import { Prisma } from '@prisma/client'
import path from 'node:path'
import { lstat, realpath, unlink } from 'node:fs/promises'
import { prisma } from './prisma.js'
import { ensure, logOperation, sumBy } from './utils.js'

const unsafe = '该订单关联账务无法安全回退，请使用售后/财务调整流程。'
const settled = '该订单相关员工收益已完成线下结算，不能直接删除，请先处理对应结算记录或使用售后调整流程。'

/** Money is reversed from source ledger deltas, never from caller-supplied amounts. */
export async function deleteOrder(orderId: string, confirmation: string, operatorId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${operatorId} FOR UPDATE`
    const operator = await tx.user.findUnique({ where: { id: operatorId }, select: { role: true, isActive: true } })
    ensure(operator?.isActive && operator.role === 'SUPER_ADMIN', 403, '仅超级管理员可以删除订单')
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
    const order = await tx.order.findUnique({ where: { id: orderId }, include: {
      assignments: { include: { earningAdjustments: true } }, completionProofs: true,
      orderConsumption: true, consumptionRecord: true, fundTransactions: true,
      adjustments: { include: { staffAdjustments: true } },
      afterSaleCase: { include: { messages: true, fundTransactions: true, orderAdjustments: true } }, supplementaryCase: true,
    } })
    ensure(order, 404, '订单不存在或已删除')
    ensure(confirmation === order.orderNo, 400, '输入的订单号不正确')
    // Coupons and cross-order supplementary services require separate reconciliation.
    ensure(!order.customerCouponId && !order.supplementaryCase && !order.afterSaleCase?.supplementaryOrderId, 409, unsafe)
    ensure(!order.afterSaleCase?.refundCents, 409, unsafe) // Offline refund annotation has no reversible cash ledger.
    ensure(order.afterSaleCase?.orderAdjustments.every(a => a.orderId === order.id) ?? true, 409, unsafe)
    const staffIds = [...new Set(order.assignments.map(a => a.staffId).filter((v): v is string => Boolean(v)))].sort()
    for (const staffId of staffIds) await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${staffId} FOR UPDATE`
    const earningAssignments = order.assignments.filter(a => a.actualEarningCents !== 0 || a.earningAdjustments.length > 0)
    const earningStaffIds = [...new Set(earningAssignments.map(a => a.staffId).filter((v): v is string => Boolean(v)))]
    // SettlementRecord has no order FK: conservatively reject any payment for an affected earner.
    ensure(await tx.settlementRecord.count({ where: { staffId: { in: earningStaffIds } } }) === 0, 409, settled)
    await tx.$queryRaw`SELECT id FROM customers WHERE id = ${order.customerId} FOR UPDATE`
    const customer = await tx.customer.findUnique({ where: { id: order.customerId } })
    ensure(customer, 404, '客户不存在')
    const consumption = order.orderConsumption
    const afterSaleFunds = order.afterSaleCase?.fundTransactions ?? []
    const funds = [...new Map([...order.fundTransactions, ...afterSaleFunds].map(f => [f.id, f])).values()]
    ensure(funds.every(f => f.customerId === order.customerId && (!f.orderId || f.orderId === order.id) && (!f.afterSaleCaseId || f.afterSaleCaseId === order.afterSaleCase?.id)), 409, unsafe)
    // Original split consumption entries share whole-order before/after snapshots.
    // Only adjustment/compensation entries have per-entry balance deltas.
    const changes = funds.filter(f => !['PRINCIPAL_CONSUMPTION','BONUS_CONSUMPTION'].includes(f.type))
    ensure(changes.every(f => f.principalAfterCents + f.bonusAfterCents === f.balanceAfterCents && f.principalBeforeCents + f.bonusBeforeCents === f.balanceBeforeCents && f.amountCents === f.balanceAfterCents - f.balanceBeforeCents), 409, unsafe)
    let principal = 0, bonus = 0
    if (consumption) {
      ensure(consumption.customerId === order.customerId && consumption.totalAmountCents === order.amountCents && consumption.principalUsedCents + consumption.bonusUsedCents === consumption.totalAmountCents, 409, unsafe)
      ensure(consumption.principalBeforeCents - consumption.principalAfterCents === consumption.principalUsedCents && consumption.bonusBeforeCents - consumption.bonusAfterCents === consumption.bonusUsedCents, 409, unsafe)
      ensure(!order.consumptionRecord || order.consumptionRecord.amountCents === consumption.totalAmountCents, 409, unsafe)
      const initial = funds.filter(f => ['PRINCIPAL_CONSUMPTION', 'BONUS_CONSUMPTION'].includes(f.type))
      ensure(-sumBy(initial.filter(f => f.type === 'PRINCIPAL_CONSUMPTION'), f => f.amountCents) === consumption.principalUsedCents && -sumBy(initial.filter(f => f.type === 'BONUS_CONSUMPTION'), f => f.amountCents) === consumption.bonusUsedCents, 409, unsafe)
      const adjustments = funds.filter(f => f.type === 'ORDER_ADJUSTMENT')
      ensure(sumBy(adjustments, f => f.amountCents) === -sumBy(order.adjustments, a => a.orderAmountDeltaCents), 409, unsafe)
      ensure(funds.every(f => ['PRINCIPAL_CONSUMPTION','BONUS_CONSUMPTION','ORDER_ADJUSTMENT','AFTER_SALE'].includes(f.type)), 409, unsafe)
      ensure(sumBy(funds.filter(f => f.type === 'AFTER_SALE'), f => f.amountCents) === (order.afterSaleCase?.compensationCents ?? 0), 409, unsafe)
      principal = consumption.principalUsedCents + sumBy(changes, f => f.principalBeforeCents - f.principalAfterCents)
      bonus = consumption.bonusUsedCents + sumBy(changes, f => f.bonusBeforeCents - f.bonusAfterCents)
      ensure(principal + bonus === order.amountCents + sumBy(order.adjustments, a => a.orderAmountDeltaCents) - (order.afterSaleCase?.compensationCents ?? 0), 409, unsafe)
    } else {
      // Legacy total-only consumption cannot safely reconstruct principal vs bonus.
      ensure(!order.consumptionRecord && funds.length === 0 && order.adjustments.length === 0 && earningAssignments.length === 0 && !['COMPLETED','AFTER_SALE'].includes(order.status), 409, unsafe)
    }
    ensure(customer.balanceCents === customer.principalBalanceCents + customer.bonusBalanceCents, 409, unsafe)
    const principalAfter = customer.principalBalanceCents + principal, bonusAfter = customer.bonusBalanceCents + bonus
    ensure(principalAfter >= 0 && bonusAfter >= 0 && [principalAfter, bonusAfter, principalAfter + bonusAfter].every(n => Number.isSafeInteger(n) && n <= 2147483647), 409, '客户当前余额不足以回退本单售后补偿，请使用售后/财务调整流程。')
    const assignmentIds = order.assignments.map(a => a.id), adjustmentIds = order.adjustments.map(a => a.id)
    ensure(order.assignments.every(a => a.earningAdjustments.every(e => adjustmentIds.includes(e.orderAdjustmentId))), 409, unsafe)
    ensure(order.adjustments.every(a => a.staffAdjustments.every(e => assignmentIds.includes(e.assignmentId))), 409, unsafe)
    const historicalLogCount = await tx.operationLog.count({ where: { entityId: { in: [order.id, ...assignmentIds, ...adjustmentIds, ...(order.afterSaleCase ? [order.afterSaleCase.id] : [])] } } })
    if (principal || bonus) await tx.customer.update({ where: { id: customer.id }, data: { principalBalanceCents: principalAfter, bonusBalanceCents: bonusAfter, balanceCents: principalAfter + bonusAfter } })
    const deleted: Record<string, number> = {}
    deleted.staffEarningAdjustments = (await tx.staffEarningAdjustment.deleteMany({ where: { assignmentId: { in: assignmentIds } } })).count
    deleted.orderAdjustments = (await tx.orderAdjustment.deleteMany({ where: { orderId } })).count
    deleted.fundTransactions = (await tx.fundTransaction.deleteMany({ where: { id: { in: funds.map(f => f.id) } } })).count
    if (order.afterSaleCase) {
      deleted.afterSaleMessages = (await tx.afterSaleMessage.deleteMany({ where: { caseId: order.afterSaleCase.id } })).count
      await tx.afterSaleCase.delete({ where: { id: order.afterSaleCase.id } }); deleted.afterSaleCases = 1
    }
    deleted.orderConsumptions = (await tx.orderConsumption.deleteMany({ where: { orderId } })).count
    deleted.consumptionRecords = (await tx.consumptionRecord.deleteMany({ where: { orderId } })).count
    deleted.completionProofs = (await tx.orderCompletionProof.deleteMany({ where: { orderId } })).count
    deleted.assignments = (await tx.orderStaffAssignment.deleteMany({ where: { orderId } })).count
    await tx.order.delete({ where: { id: orderId } }); deleted.orders = 1
    for (const staffId of staffIds) {
      const active = await tx.orderStaffAssignment.count({ where: { staffId, assignmentStatus: { in: ['ACTIVE','EXIT_REQUESTED'] }, order: { status: { in: ['IN_PROGRESS','PENDING_COMPLETION_REVIEW'] } } } })
      await tx.staffProfile.updateMany({ where: { id: staffId, status: { not: active ? 'BUSY' : 'IDLE' } }, data: { status: active ? 'BUSY' : 'IDLE' } })
    }
    const earnings = order.assignments.map(a => ({ staffId: a.staffId, assignmentId: a.id, earningCents: a.actualEarningCents + sumBy(a.earningAdjustments, e => e.earningDeltaCents) }))
    const proofPaths = [...new Set(order.completionProofs.map(p => p.proofPath))]
    const audit = await logOperation(tx, { operatorId, action: 'SUPER_ADMIN_DELETE_ORDER', entityType: 'ORDER', entityId: orderId, detail: { orderNo: order.orderNo, originalStatus: order.status, originalAmountCents: order.amountCents, restoredPrincipalCents: principal, restoredBonusCents: bonus, removedStaffEarnings: earnings, deleted, operatorId, operatedAt: new Date().toISOString(), historicalLogCount, proofCleanupPending: proofPaths } })
    return { orderNo: order.orderNo, staffIds, auditId: audit.id, proofPaths, restoredPrincipalCents: principal, restoredBonusCents: bonus, earnings, deleted }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 })
}

/** Audit keeps pending paths if process exits after commit. Files never affect transaction success. */
export async function cleanupDeletedOrderProofs(result: Awaited<ReturnType<typeof deleteOrder>>, operatorId: string) {
  const root = path.resolve(process.cwd(), 'uploads', 'order-proofs')
  const outcomes: Array<{ path: string; status: string }> = []
  for (const proofPath of result.proofPaths) {
    try {
      if (await prisma.orderCompletionProof.count({ where: { proofPath } })) { outcomes.push({ path: proofPath, status: 'shared-retained' }); continue }
      const file = path.resolve(process.cwd(), proofPath)
      ensure(path.dirname(file) === root, 403, '非法附件路径')
      const stat = await lstat(file)
      ensure(stat.isFile() && !stat.isSymbolicLink(), 403, '非法附件文件')
      ensure(path.dirname(await realpath(file)) === await realpath(root), 403, '非法附件路径')
      await unlink(file); outcomes.push({ path: proofPath, status: 'deleted' })
    } catch (error) { outcomes.push({ path: proofPath, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'already-missing' : 'pending-cleanup' }) }
  }
  try { await logOperation(prisma, { operatorId, action: 'ORDER_PROOF_CLEANUP', entityType: 'OPERATION_LOG', entityId: result.auditId, detail: { outcomes } }) } catch { console.error('订单附件清理结果记录失败，请依据删除审计中的待清理路径复核') }
  return outcomes
}

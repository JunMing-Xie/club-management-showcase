import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4000/api'
const adminPassword = process.env.TEST_ADMIN_PASSWORD ?? 'Demo-Local-Only!2026'
const staffPassword = process.env.TEST_STAFF_PASSWORD ?? 'Demo-Local-Only!2026'
const prisma = new PrismaClient()
const marker = String(Date.now()).slice(-8)
const startedAt = new Date()
const created = { orders: [], customers: [], users: [], tiers: [], settlements: [], proofs: [] }
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

const result = async (apiPath, { token, method = 'GET', body, formData } = {}) => {
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  let payload = formData
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await fetch(`${baseUrl}${apiPath}`, { method, headers, body: payload })
  const text = await response.text()
  return { status: response.status, ok: response.ok, data: text ? JSON.parse(text) : null }
}
const request = async (apiPath, options = {}) => {
  const response = await result(apiPath, options)
  if (options.expectedStatus === undefined) assert.equal(response.ok, true, `${options.method ?? 'GET'} ${apiPath}: ${response.status} ${JSON.stringify(response.data)}`)
  else assert.equal(response.status, options.expectedStatus, `${options.method ?? 'GET'} ${apiPath}: expected ${options.expectedStatus}, got ${response.status} ${JSON.stringify(response.data)}`)
  return response.data
}
const login = (username, password) => request('/auth/login', { method: 'POST', body: { username, password } })
const proofForm = () => {
  const form = new FormData()
  form.append('note', '客户反馈收口专项完单凭证')
  form.append('proofs', new Blob([tinyPng], { type: 'image/png' }), 'proof.png')
  return form
}

const main = async () => {
  let originalWelcome
  let lin
  let originalLin
  try {
    const [adminLogin, linLogin] = await Promise.all([login('admin', adminPassword), login('lin', staffPassword)])
    const adminToken = adminLogin.token
    const linToken = linLogin.token
    const staffOptions = await request('/staff/options', { token: adminToken })
    lin = staffOptions.items.find((item) => item.name === '阿凯')
    assert.ok(lin, '测试员工阿凯不存在')
    originalLin = await prisma.staffProfile.findUnique({ where: { id: lin.id }, select: { tierId: true, status: true, presence: true, accepting: true, accountStatus: true } })
    const servicePackage = (await request('/packages', { token: adminToken })).items.find((item) => item.isEnabled)
    assert.ok(servicePackage, '需要至少一个启用套餐')

    originalWelcome = (await request('/settings/workbench-welcome', { token: adminToken })).item
    await request('/settings/workbench-welcome', { token: adminToken, method: 'PATCH', body: { titleTemplate: '{员工昵称}，专项验证进行中。', subtitle: '欢迎语配置实时同步验证。' } })
    const summaryWithWelcome = await request('/workbench/summary', { token: linToken })
    assert.equal(summaryWithWelcome.welcome.title, '阿凯，专项验证进行中。')
    assert.equal(summaryWithWelcome.welcome.subtitle, '欢迎语配置实时同步验证。')

    const unusedTier = await request('/staff-tiers', { token: adminToken, method: 'POST', body: { name: `未引用层级${marker}`, level: 88, priceMultiplierBps: 10000 } })
    created.tiers.push(unusedTier.item.id)
    const deletedTier = await request(`/staff-tiers/${unusedTier.item.id}`, { token: adminToken, method: 'DELETE' })
    assert.equal(deletedTier.deleted, true, '未引用层级应物理删除')
    created.tiers = created.tiers.filter((id) => id !== unusedTier.item.id)

    const boundTier = await request('/staff-tiers', { token: adminToken, method: 'POST', body: { name: `员工引用层级${marker}`, level: 89, priceMultiplierBps: 10000 } })
    created.tiers.push(boundTier.item.id)
    const tempUsername = `tier${marker}`
    const tempStaff = await request('/staff', { token: adminToken, method: 'POST', body: { username: tempUsername, password: 'Feedback123!', name: `层级员工${marker}`, tierId: boundTier.item.id, commissionRateBps: 3000 } })
    created.users.push(tempStaff.item.id)
    const blockedByStaff = await request(`/staff-tiers/${boundTier.item.id}`, { token: adminToken, method: 'DELETE', expectedStatus: 409 })
    assert.match(blockedByStaff.message, /当前仍有 1 名员工使用该服务层级/)

    await prisma.staffProfile.update({ where: { id: tempStaff.item.staffProfile.id }, data: { tierId: null } })
    const customer = await request('/customers', { token: adminToken, method: 'POST', body: { customerCode: `CLIENT-${marker}`, teamCode: `TEAM-${marker}`, note: '客户反馈专项验证' } })
    created.customers.push(customer.item.id)
    await request(`/customers/${customer.item.id}/recharges`, { token: adminToken, method: 'POST', body: { amount: 500, bonusAmount: 0, note: '专项测试充值' } })

    const restrictedOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: customer.item.id, servicePackageId: servicePackage.id, requiredTierId: boundTier.item.id, amountCents: 5000, requiredStaffCount: 1, collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }] } })
    created.orders.push(restrictedOrder.item.id)
    const blockedByOrder = await request(`/staff-tiers/${boundTier.item.id}`, { token: adminToken, method: 'DELETE', expectedStatus: 409 })
    assert.match(blockedByOrder.message, /当前仍有 1 个未完成订单引用该服务层级/)

    const unrestricted = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: customer.item.id, servicePackageId: servicePackage.id, requiredTierId: null, amountCents: 10000, requiredStaffCount: 1, collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }] } })
    created.orders.push(unrestricted.item.id)
    assert.equal(unrestricted.item.requiredTier, null, '不限层级应保存为 null')
    const pool = await request('/workbench/available-orders', { token: linToken })
    const poolOrder = pool.items.find((item) => item.id === unrestricted.item.id)
    assert.ok(poolOrder, '不限层级订单应对正常可接员工可见')
    assert.equal(poolOrder.customer.customerCode, null)
    assert.equal(poolOrder.customer.teamCode, null)
    assert.equal(Object.hasOwn(poolOrder.customer, 'phone'), false)
    const claimed = await request(`/orders/${unrestricted.item.id}/claim`, { token: linToken, method: 'POST' })
    assert.equal(claimed.item.customer.customerCode, customer.item.customerCode)
    assert.equal(claimed.item.customer.teamCode, customer.item.teamCode)
    assert.equal(Object.hasOwn(claimed.item.customer, 'id'), false)

    await request(`/orders/${unrestricted.item.id}/start`, { token: linToken, method: 'POST' })
    await request(`/orders/${unrestricted.item.id}/completion-submissions`, { token: linToken, method: 'POST', formData: proofForm() })
    const completed = await request(`/orders/${unrestricted.item.id}/completion-review`, { token: adminToken, method: 'POST', body: { approved: true } })
    assert.equal(completed.item.status, 'COMPLETED')
    const proofRows = await prisma.orderCompletionProof.findMany({ where: { orderId: unrestricted.item.id }, select: { proofPath: true } })
    created.proofs.push(...proofRows.map((item) => item.proofPath))
    assert.equal((await request(`/customers/${customer.item.id}`, { token: adminToken })).item.balanceCents, 40000)

    const afterSale = await request('/after-sales', { token: adminToken, method: 'POST', body: { orderId: unrestricted.item.id, issueType: '服务时长调整', description: '客户确认部分服务时长需要核减。' } })
    const completedAssignment = completed.item.assignments.find((item) => item.assignmentStatus === 'COMPLETED')
    const reduceRequestId = `adjust-down-${marker}`
    const reductionBody = { requestId: reduceRequestId, afterSaleId: afterSale.item.id, reason: '售后核减', handlingNote: '订单净额由100元调整为80元', netAmount: 80, staffNetEarnings: [{ assignmentId: completedAssignment.id, amount: 24 }] }
    const reduced = await request(`/orders/${unrestricted.item.id}/adjustments`, { token: adminToken, method: 'POST', body: reductionBody })
    assert.equal(reduced.item.currentNetAmountCents, 8000)
    assert.equal(reduced.item.assignments.find((item) => item.id === completedAssignment.id).currentNetEarningCents, 2400)
    assert.equal((await request(`/customers/${customer.item.id}`, { token: adminToken })).item.balanceCents, 42000)
    const repeatedReduction = await request(`/orders/${unrestricted.item.id}/adjustments`, { token: adminToken, method: 'POST', body: reductionBody })
    assert.equal(repeatedReduction.idempotent, true)
    assert.equal(await prisma.orderAdjustment.count({ where: { requestId: reduceRequestId } }), 1)
    assert.equal((await request(`/customers/${customer.item.id}`, { token: adminToken })).item.balanceCents, 42000)

    const increaseRequestId = `adjust-up-${marker}`
    const increased = await request(`/orders/${unrestricted.item.id}/adjustments`, { token: adminToken, method: 'POST', body: { requestId: increaseRequestId, afterSaleId: afterSale.item.id, reason: '补充服务确认', netAmount: 90, staffNetEarnings: [{ assignmentId: completedAssignment.id, amount: 27 }] } })
    assert.equal(increased.item.currentNetAmountCents, 9000)
    assert.equal((await request(`/customers/${customer.item.id}`, { token: adminToken })).item.balanceCents, 41000)
    const balanceBeforeRejectedIncrease = (await request(`/customers/${customer.item.id}`, { token: adminToken })).item.balanceCents
    await request(`/orders/${unrestricted.item.id}/adjustments`, { token: adminToken, method: 'POST', expectedStatus: 409, body: { requestId: `adjust-fail-${marker}`, reason: '余额不足测试', netAmount: 1000, staffNetEarnings: [{ assignmentId: completedAssignment.id, amount: 300 }] } })
    assert.equal((await request(`/customers/${customer.item.id}`, { token: adminToken })).item.balanceCents, balanceBeforeRejectedIncrease)

    const workload = await request(`/staff/workload?startDate=${dayKey(new Date())}&endDate=${dayKey(new Date())}`, { token: adminToken })
    const linWorkload = workload.items.find((item) => item.staffId === lin.id)
    assert.ok(linWorkload.claimedCount >= 1 && linWorkload.completedCount >= 1)

    const settlementRequestId = `settlement-${marker}`
    const settlementBody = { requestId: settlementRequestId, amount: 10, settlementMethod: '线下现金', settlementDate: dayKey(new Date()), note: '专项结算测试' }
    const settlement = await request(`/staff/${lin.id}/settlements`, { token: adminToken, method: 'POST', body: settlementBody })
    created.settlements.push(settlement.item.id)
    const repeatedSettlement = await request(`/staff/${lin.id}/settlements`, { token: adminToken, method: 'POST', body: settlementBody })
    assert.equal(repeatedSettlement.idempotent, true)
    assert.equal(await prisma.settlementRecord.count({ where: { requestId: settlementRequestId } }), 1)

    await request(`/after-sales/${afterSale.item.id}`, { token: adminToken, method: 'PATCH', body: { status: 'COMPLETED', handlingNote: '售后已完成，净额调整另行登记。' } })
    await request(`/after-sales/${afterSale.item.id}`, { token: adminToken, method: 'PATCH', body: { status: 'COMPLETED', handlingNote: '售后已完成，净额调整另行登记。' } })
    assert.equal(await prisma.orderAdjustment.count({ where: { orderId: unrestricted.item.id } }), 2, '重复完成售后不能生成订单净额调整')

    await prisma.order.update({ where: { id: unrestricted.item.id }, data: { requiredTierId: boundTier.item.id } })
    await prisma.order.delete({ where: { id: restrictedOrder.item.id } })
    created.orders = created.orders.filter((id) => id !== restrictedOrder.item.id)
    const archivedTier = await request(`/staff-tiers/${boundTier.item.id}`, { token: adminToken, method: 'DELETE' })
    assert.equal(archivedTier.archived, true, '仅历史完成订单引用时应归档层级')

    console.log(JSON.stringify({ ok: true, tierSafeDelete: true, unrestrictedTier: true, customerBusinessFields: true, staffCustomerIsolation: true, workbenchWelcome: true, staffWorkload: true, orderAdjustment: { reduction: true, increase: true, insufficientRollback: true, idempotent: true }, afterSaleCompletion: true, settlementIdempotent: true }, null, 2))
  } finally {
    if (originalWelcome) await fetch(`${baseUrl}/settings/workbench-welcome`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(await login('admin', adminPassword)).token}` }, body: JSON.stringify(originalWelcome) }).catch(() => undefined)
    if (created.settlements.length) await prisma.settlementRecord.deleteMany({ where: { id: { in: created.settlements } } }).catch(() => undefined)
    if (created.orders.length) {
      await prisma.afterSaleMessage.deleteMany({ where: { case: { orderId: { in: created.orders } } } }).catch(() => undefined)
      await prisma.fundTransaction.deleteMany({ where: { afterSaleCase: { orderId: { in: created.orders } } } }).catch(() => undefined)
      await prisma.afterSaleCase.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.staffEarningAdjustment.deleteMany({ where: { orderAdjustment: { orderId: { in: created.orders } } } }).catch(() => undefined)
      await prisma.orderAdjustment.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.fundTransaction.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.orderConsumption.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.consumptionRecord.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.order.deleteMany({ where: { id: { in: created.orders } } }).catch(() => undefined)
    }
    if (created.customers.length) {
      await prisma.fundTransaction.deleteMany({ where: { customerId: { in: created.customers } } }).catch(() => undefined)
      await prisma.rechargeRecord.deleteMany({ where: { customerId: { in: created.customers } } }).catch(() => undefined)
      await prisma.customer.deleteMany({ where: { id: { in: created.customers } } }).catch(() => undefined)
    }
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => undefined)
    if (created.tiers.length) await prisma.staffTier.deleteMany({ where: { id: { in: created.tiers } } }).catch(() => undefined)
    if (lin && originalLin) await prisma.staffProfile.update({ where: { id: lin.id }, data: originalLin }).catch(() => undefined)
    await prisma.operationLog.deleteMany({ where: { createdAt: { gte: startedAt } } }).catch(() => undefined)
    await Promise.allSettled(created.proofs.map((proofPath) => unlink(path.resolve(process.cwd(), proofPath))))
    await prisma.$disconnect()
  }
}

const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

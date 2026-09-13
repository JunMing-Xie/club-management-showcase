import { Prisma, OrderStaffAssignmentStatus } from '@prisma/client'
import { prisma } from './prisma.js'
import { allocateSettlements, currentStaffEarningTotal, settlementBalance } from './earnings.js'
import { ensure, parseDateRange, sumBy } from './utils.js'

export const staffStatisticsRange = (query: Record<string, unknown>) => {
  if (query.period === undefined || query.period === 'range') return parseDateRange(query.startDate, query.endDate)
  ensure(['today', 'month', 'week', 'all'].includes(String(query.period)), 400, '统计区间无效')
  if (query.period === 'all') return null
  const now = new Date()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (query.period === 'month') start.setDate(1)
  if (query.period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  const end = new Date(now)
  if (query.period === 'week') end.setDate(end.getDate() + (7 - end.getDay()) % 7)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

export const staffStatistics = async (staffId: string, query: Record<string, unknown>) => {
  const range = staffStatisticsRange(query)
  const filter = range ? { gte: range.start, lte: range.end } : undefined
  // One consistent snapshot keeps summary and drawer totals in agreement during adjustments.
  return prisma.$transaction(async (tx) => {
    const assignments = await tx.orderStaffAssignment.findMany({
      where: { staffId, assignmentStatus: OrderStaffAssignmentStatus.COMPLETED },
      orderBy: [{ order: { completedAt: 'asc' } }, { orderId: 'asc' }, { id: 'asc' }],
      include: { earningAdjustments: true, order: { select: { id: true, orderNo: true, serviceItem: true, completedAt: true, status: true, customer: { select: { customerCode: true } } } } },
    })
    const settlements = await tx.settlementRecord.findMany({ where: { staffId, ...(filter ? { settledAt: filter } : {}) }, orderBy: [{ settledAt: 'desc' }, { id: 'asc' }] })
    const settled = await tx.settlementRecord.aggregate({ where: { staffId }, _sum: { amountCents: true } })
    const totalSettled = settled._sum.amountCents ?? 0
    const selectedIds = range ? new Set((await tx.orderStaffAssignment.findMany({
      where: { staffId, assignmentStatus: OrderStaffAssignmentStatus.COMPLETED, order: { completedAt: filter } }, select: { id: true },
    })).map((item) => item.id)) : null
    const allocated = allocateSettlements(assignments, totalSettled).filter((item) => !selectedIds || selectedIds.has(item.id))
    const grouped = new Map<string, { id: string; orderNo: string; serviceItem: string; completedAt: Date | null; status: string; customerCode: string; originalEarningCents: number; currentActualEarningCents: number; allocatedSettlementCents: number; pendingSettlementCents: number }>()
    for (const item of allocated) {
      const row = grouped.get(item.orderId) ?? { id: item.orderId, orderNo: item.order.orderNo, serviceItem: item.order.serviceItem, completedAt: item.order.completedAt, status: item.order.status, customerCode: item.order.customer.customerCode, originalEarningCents: 0, currentActualEarningCents: 0, allocatedSettlementCents: 0, pendingSettlementCents: 0 }
      row.originalEarningCents += item.actualEarningCents
      row.currentActualEarningCents += item.currentActualEarningCents
      row.allocatedSettlementCents += item.allocatedSettlementCents
      row.pendingSettlementCents += item.pendingSettlementCents
      grouped.set(item.orderId, row)
    }
    const orders = [...grouped.values()].reverse()
    const summary = {
      completedCount: orders.length,
      earningsCents: sumBy(orders, (item) => item.currentActualEarningCents),
      settledCents: sumBy(settlements, (item) => item.amountCents),
      pendingSettlementCents: sumBy(orders, (item) => item.pendingSettlementCents),
      overSettledCents: settlementBalance(currentStaffEarningTotal(assignments), totalSettled).overSettledCents,
    }
    return { range, summary, orders, settlements: settlements.map(({ id, amountCents, settlementMethod, settledAt, note }) => ({ id, amountCents, settlementMethod, settledAt, note })), allocationNote: '结算记录按员工记账；订单已结算为按完单时间顺序的展示分摊，不是原始逐单结算凭据。待冲抵为账户累计值。' }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

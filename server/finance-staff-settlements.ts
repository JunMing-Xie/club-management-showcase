import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { addDays, dateKey, endOfDay, ensure, parseDateRange, startOfDay } from './utils.js'

export const financeSettlementRange = (query: Record<string, unknown>, now = new Date()) => {
  const period = query.period ?? (query.startDate || query.endDate ? 'custom' : 'week')
  if (period === 'custom') {
    const range = parseDateRange(query.startDate, query.endDate)
    ensure(range, 400, '请选择完整的开始日期和结束日期')
    return range
  }
  ensure(['week', 'lastWeek', 'month', 'lastMonth', 'today'].includes(String(period)), 400, '统计周期无效')
  const start = startOfDay(now)
  if (period === 'today') return { start, end: endOfDay(start) }
  if (period === 'week' || period === 'lastWeek') {
    start.setDate(start.getDate() - (start.getDay() + 6) % 7 - (period === 'lastWeek' ? 7 : 0))
    return { start, end: endOfDay(addDays(start, 6)) }
  }
  start.setDate(1)
  if (period === 'lastMonth') start.setMonth(start.getMonth() - 1)
  const end = new Date(start)
  end.setMonth(end.getMonth() + 1, 0)
  return { start, end: endOfDay(end) }
}

type Aggregate = { staffId: string; opening: Prisma.Decimal; period: Prisma.Decimal; count?: bigint; participation?: Prisma.Decimal; lastDate?: Date | null }
const integer = (value: unknown) => {
  const result = Number(value ?? 0)
  ensure(Number.isSafeInteger(result), 500, '统计金额超出安全处理范围')
  return result
}

export const financeStaffSettlements = async (query: Record<string, unknown>) => {
  const range = financeSettlementRange(query)
  return prisma.$transaction(async tx => {
    // Aggregate in SQL. No full order/settlement ledger is sent to the browser.
    const normal = await tx.$queryRaw<Aggregate[]>(Prisma.sql`
      SELECT p.staffId,
        SUM(CASE WHEN p.completedAt < ${range.start} THEN p.earning ELSE 0 END) AS opening,
        SUM(CASE WHEN p.completedAt >= ${range.start} THEN p.earning ELSE 0 END) AS period,
        SUM(CASE WHEN p.completedAt >= ${range.start} THEN 1 ELSE 0 END) AS count,
        SUM(CASE WHEN p.completedAt >= ${range.start} THEN p.amount ELSE 0 END) AS participation
      FROM (
        SELECT a.staffId, o.id, o.completedAt, MAX(o.amountCents) AS amount, SUM(a.actualEarningCents) AS earning
        FROM order_staff_assignments a
        JOIN orders o ON o.id = a.orderId
        LEFT JOIN order_consumptions c ON c.orderId = o.id
        LEFT JOIN consumption_records legacy ON legacy.orderId = o.id
        WHERE a.assignmentStatus = 'COMPLETED' AND a.staffId IS NOT NULL
          AND (c.id IS NOT NULL OR legacy.id IS NOT NULL)
          AND o.status IN ('COMPLETED', 'AFTER_SALE') AND o.completedAt <= ${range.end}
        GROUP BY a.staffId, o.id, o.completedAt
      ) p GROUP BY p.staffId`)
    const adjustments = await tx.$queryRaw<Aggregate[]>(Prisma.sql`
      SELECT e.staffId,
        SUM(CASE WHEN e.createdAt < ${range.start} THEN e.earningDeltaCents ELSE 0 END) AS opening,
        SUM(CASE WHEN e.createdAt >= ${range.start} THEN e.earningDeltaCents ELSE 0 END) AS period
      FROM staff_earning_adjustments e
      JOIN order_staff_assignments a ON a.id = e.assignmentId
      JOIN orders o ON o.id = a.orderId
      LEFT JOIN order_consumptions c ON c.orderId = o.id
      LEFT JOIN consumption_records legacy ON legacy.orderId = o.id
      WHERE a.assignmentStatus = 'COMPLETED' AND o.status IN ('COMPLETED', 'AFTER_SALE')
        AND (c.id IS NOT NULL OR legacy.id IS NOT NULL)
        AND o.completedAt <= ${range.end} AND e.createdAt <= ${range.end}
      GROUP BY e.staffId`)
    const payments = await tx.$queryRaw<Aggregate[]>(Prisma.sql`
      SELECT staffId,
        SUM(CASE WHEN settledAt < ${range.start} THEN amountCents ELSE 0 END) AS opening,
        SUM(CASE WHEN settledAt >= ${range.start} THEN amountCents ELSE 0 END) AS period,
        MAX(settledAt) AS lastDate
      FROM settlement_records WHERE settledAt <= ${range.end} GROUP BY staffId`)
    const staff = await tx.staffProfile.findMany({ select: { id: true, name: true, user: { select: { username: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
    const byId = (rows: Aggregate[]) => new Map(rows.map(row => [row.staffId, row]))
    const n = byId(normal), a = byId(adjustments), p = byId(payments)
    const items = staff.map(person => {
      const normal = n.get(person.id), adjustment = a.get(person.id), payment = p.get(person.id)
      const openingEarnedCents = integer(normal?.opening) + integer(adjustment?.opening)
      const openingPaidCents = integer(payment?.opening)
      const openingNetCents = openingEarnedCents - openingPaidCents
      const normalEarningCents = integer(normal?.period)
      const adjustmentCents = integer(adjustment?.period)
      const periodNetEarningCents = normalEarningCents + adjustmentCents
      const periodSettledCents = integer(payment?.period)
      const closingNetCents = openingNetCents + periodNetEarningCents - periodSettledCents
      return {
        staffId: person.id, name: person.name, username: person.user.username,
        orderCount: integer(normal?.count), participationAmountCents: integer(normal?.participation),
        openingNetCents, openingPendingCents: Math.max(0, openingNetCents), openingOffsetCents: Math.max(0, -openingNetCents),
        normalEarningCents, adjustmentCents, periodNetEarningCents, periodSettledCents,
        cumulativeEarningCents: openingEarnedCents + periodNetEarningCents,
        cumulativeSettledCents: openingPaidCents + periodSettledCents,
        closingNetCents, pendingCents: Math.max(0, closingNetCents), offsetCents: Math.max(0, -closingNetCents),
        lastSettlementAt: payment?.lastDate ?? null,
      }
    })
    const total = (field: 'participationAmountCents' | 'periodNetEarningCents' | 'periodSettledCents' | 'pendingCents' | 'offsetCents') => integer(items.reduce((sum, item) => sum + item[field], 0))
    return {
      range: { startDate: dateKey(range.start), endDate: dateKey(range.end), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      summary: {
        participationAmountCents: total('participationAmountCents'), netEarningCents: total('periodNetEarningCents'),
        settledCents: total('periodSettledCents'), pendingCents: total('pendingCents'), offsetCents: total('offsetCents'),
      }, items,
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './prisma.js'
import { ensure } from './utils.js'
import { getUserPermissions } from './admin-roles.js'

const dayMs = 86400000
export const dispatchRangeSchema = z.object({
  period: z.enum(['today', 'week', 'lastWeek', 'month', 'lastMonth', 'custom']).default('week'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
})
export type DispatchRangeInput = z.infer<typeof dispatchRangeSchema>
export const dispatchRange = (input: DispatchRangeInput, now = new Date()) => {
  // UTC arithmetic on the Beijing calendar is independent of the process timezone.
  const local = new Date(now.getTime() + 8 * 3600000)
  let from = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  let to = from + dayMs
  if (input.period === 'week' || input.period === 'lastWeek') {
    from -= ((local.getUTCDay() + 6) % 7) * dayMs
    if (input.period === 'lastWeek') from -= 7 * dayMs
    to = from + 7 * dayMs
  } else if (input.period === 'month' || input.period === 'lastMonth') {
    const month = local.getUTCMonth() - (input.period === 'lastMonth' ? 1 : 0)
    from = Date.UTC(local.getUTCFullYear(), month, 1); to = Date.UTC(local.getUTCFullYear(), month + 1, 1)
  } else if (input.period === 'custom') {
    ensure(input.from && input.to, 400, '请选择完整日期范围')
    from = Date.parse(input.from + 'T00:00:00Z'); to = Date.parse(input.to + 'T00:00:00Z')
    ensure(Number.isFinite(from) && Number.isFinite(to) && new Date(from).toISOString().slice(0, 10) === input.from && new Date(to).toISOString().slice(0, 10) === input.to, 400, '日期无效')
    to += dayMs
    ensure(to > from && to - from <= 366 * dayMs, 400, '日期范围须为 1 至 366 天')
  }
  return { from: new Date(from - 8 * 3600000), to: new Date(to - 8 * 3600000), startDate: new Date(from).toISOString().slice(0, 10), endDate: new Date(to - dayMs).toISOString().slice(0, 10) }
}

// ASSIGN is written only after a successful assignment. CREATE with explicit staffId
// is the audited pre-assignment action, not an inference from the order creator.
const source = Prisma.sql`SELECT l.id, l.operatorId, l.entityId AS orderId, l.createdAt, l.detail,
  JSON_UNQUOTE(JSON_EXTRACT(l.detail, '$.staffId')) AS staffId
  FROM operation_logs l WHERE l.entityType = 'ORDER' AND l.operatorId IS NOT NULL
  AND (l.action = 'ASSIGN' OR (l.action = 'CREATE'
    AND JSON_TYPE(JSON_EXTRACT(l.detail, '$.staffId')) = 'STRING'
    AND JSON_UNQUOTE(JSON_EXTRACT(l.detail, '$.staffId')) <> ''))`

export const dispatchStatistics = async (input: DispatchRangeInput, scope: { selfId: string } | { operatorId?: string }, now = new Date()) => {
  const range = dispatchRange(input, now)
  const selfId = 'selfId' in scope ? scope.selfId : undefined
  const operatorId = selfId ?? ('operatorId' in scope ? scope.operatorId : undefined)
  const pageSize = 30
  return prisma.$transaction(async (tx) => {
    const accounts = await tx.user.findMany({ where: { role: { not: 'STAFF' } }, select: { id: true, role: true, adminRoleId: true, adminRole: { select: { name: true } } } })
    const eligible = (await Promise.all(accounts.map(async account => (await getUserPermissions(account, tx)).includes('orders.assign') ? account.id : null))).filter((id): id is string => id !== null)
    const rows = await tx.$queryRaw<Array<{ id: string; username: string; role: string; orderCount: bigint; operationCount: bigint; lastAssignedAt: Date | null }>>`
      SELECT u.id, u.username, u.role, COUNT(DISTINCT e.orderId) AS orderCount,
        COUNT(e.id) AS operationCount, MAX(e.createdAt) AS lastAssignedAt
      FROM users u LEFT JOIN (${source}) e ON e.operatorId = u.id AND e.createdAt >= ${range.from} AND e.createdAt < ${range.to}
      WHERE ${operatorId ? Prisma.sql`u.id = ${operatorId} AND u.role <> 'STAFF'` : eligible.length ? Prisma.sql`u.role <> 'STAFF' AND (u.id IN (${Prisma.join(eligible)}) OR e.id IS NOT NULL)` : Prisma.sql`u.role <> 'STAFF' AND e.id IS NOT NULL`}
      GROUP BY u.id, u.username, u.role ORDER BY orderCount DESC, u.username ASC`
    if (operatorId) ensure(rows.length === 1, 404, '后台账号不存在')
    const result = { range, rows: rows.map(r => ({ ...r, roleName: accounts.find(account => account.id === r.id)?.adminRole?.name ?? null, orderCount: Number(r.orderCount), operationCount: Number(r.operationCount) })), history: '统计明确记录的成功手动派单和建单预分配；历史普通编辑无法确认是否真的改派，不计入。相同人员在所选周期内按订单去重。' }
    if (!operatorId) return result
    const count = result.rows[0].operationCount
    const page = Math.min(input.page, Math.max(1, Math.ceil(count / pageSize)))
    const details = await tx.$queryRaw<Array<{ id: string; orderId: string; createdAt: Date; orderNo: string | null; status: string | null; staffName: string | null; slotIndex: string | null; assignmentId: string | null }>>`
      SELECT e.id, e.orderId, e.createdAt, o.orderNo, o.status, s.name AS staffName,
        JSON_UNQUOTE(JSON_EXTRACT(e.detail, '$.slotIndex')) AS slotIndex,
        JSON_UNQUOTE(JSON_EXTRACT(e.detail, '$.assignmentId')) AS assignmentId
      FROM (${source}) e LEFT JOIN orders o ON o.id = e.orderId LEFT JOIN staff_profiles s ON s.id = e.staffId
      WHERE e.operatorId = ${operatorId} AND e.createdAt >= ${range.from} AND e.createdAt < ${range.to}
      ORDER BY e.createdAt DESC, e.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
    let summary: Record<string, number> | undefined
    if (selfId) {
      summary = {}
      for (const period of ['today', 'week', 'month'] as const) {
        const r = dispatchRange({ period, page: 1 }, now)
        const [row] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(DISTINCT e.orderId) AS count FROM (${source}) e WHERE e.operatorId = ${selfId} AND e.createdAt >= ${r.from} AND e.createdAt < ${r.to}`
        summary[period] = Number(row.count)
      }
    }
    return { ...result, details: details.map(row => ({ ...row, result: '成功' })), page, pageSize, total: count, summary }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

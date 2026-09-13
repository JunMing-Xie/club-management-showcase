import { Prisma } from '@prisma/client'
import type { AuthUser } from './types.js'
import { hasPermission } from './auth.js'
import { prisma } from './prisma.js'

export type ReminderKind = 'completion' | 'exit' | 'afterSale'
type TodoRow = { id: string; kind: ReminderKind; orderId: string; orderNo: string; staffName: string | null; summary: string | null; occurredAt: Date }
type ActivityRow = { id: string; action: string; entityType: string; entityId: string; staffName: string; orderId: string | null; orderNo: string | null; occurredAt: Date }

// Only existing business states determine the badge. Reading never acknowledges a task.
export const getAdminReminders = async (user: AuthUser, page: number, kind?: ReminderKind) => {
  const canReadOrders = hasPermission(user, 'orders.view')
  const canReadSales = hasPermission(user, 'aftersales.view')
  const allowed = {
    completion: canReadOrders && hasPermission(user, 'orders.review'),
    exit: canReadOrders && hasPermission(user, 'orders.assign'),
    afterSale: canReadSales && hasPermission(user, 'aftersales.manage'),
  }
  const pending = Prisma.sql`
    SELECT o.id, 'completion' AS kind, o.id AS orderId, o.orderNo, NULL AS staffName,
      '全部当前参与员工已提交，等待审核' AS summary, COALESCE(o.completionSubmittedAt, o.updatedAt) AS occurredAt
    FROM orders o WHERE ${allowed.completion} AND o.status = 'PENDING_COMPLETION_REVIEW'
    UNION ALL
    SELECT a.id, 'exit', o.id, o.orderNo, s.name, LEFT(a.exitReason, 180), COALESCE(a.exitRequestedAt, a.updatedAt)
    FROM order_staff_assignments a JOIN orders o ON o.id = a.orderId LEFT JOIN staff_profiles s ON s.id = a.staffId
    WHERE ${allowed.exit} AND a.assignmentStatus = 'EXIT_REQUESTED' AND a.exitReviewStatus = 'PENDING'
    UNION ALL
    SELECT c.id, 'afterSale', o.id, o.orderNo, NULL,
      LEFT(COALESCE((SELECT m.content FROM after_sale_messages m WHERE m.caseId = c.id ORDER BY m.createdAt DESC, m.id DESC LIMIT 1), c.description), 180),
      GREATEST(c.updatedAt, COALESCE((SELECT MAX(m.createdAt) FROM after_sale_messages m WHERE m.caseId = c.id), c.createdAt))
    FROM after_sale_cases c JOIN orders o ON o.id = c.orderId
    WHERE ${allowed.afterSale} AND c.status IN ('PENDING', 'PROCESSING')
  `
  return prisma.$transaction(async (tx) => {
    const groups = await tx.$queryRaw<Array<{ kind: ReminderKind; count: bigint }>>`
      SELECT kind, COUNT(*) AS count FROM (${pending}) t GROUP BY kind`
    const counts = { completion: 0, exit: 0, afterSale: 0 }
    for (const group of groups) counts[group.kind] = Number(group.count)
    const total = counts.completion + counts.exit + counts.afterSale
    const filteredTotal = kind ? counts[kind] : total
    const pageSize = 30
    const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredTotal / pageSize)))
    const rows = await tx.$queryRaw<TodoRow[]>`
      SELECT * FROM (${pending}) t ${kind ? Prisma.sql`WHERE kind = ${kind}` : Prisma.empty}
      ORDER BY occurredAt DESC, kind ASC, id DESC LIMIT ${pageSize} OFFSET ${(currentPage - 1) * pageSize}`
    // SQL restricts to known employee actions before LIMIT; no full log history or raw details leave the API.
    const activity = await tx.$queryRaw<ActivityRow[]>`
      SELECT l.id, l.action, l.entityType, l.entityId, COALESCE(s.name, u.username) AS staffName,
        o.id AS orderId, o.orderNo, l.createdAt AS occurredAt
      FROM operation_logs l JOIN users u ON u.id = l.operatorId
      LEFT JOIN staff_profiles s ON s.userId = u.id
      LEFT JOIN after_sale_cases c ON l.entityType = 'AFTER_SALE' AND c.id = l.entityId
      LEFT JOIN orders o ON o.id = CASE WHEN l.entityType = 'ORDER' THEN l.entityId ELSE c.orderId END
      WHERE u.role = 'STAFF' AND (
        (${canReadOrders} AND l.entityType = 'ORDER' AND o.id IS NOT NULL AND l.action IN ('CLAIM', 'START', 'SUBMIT_COMPLETION', 'EXIT_ORDER'))
        OR (${canReadSales} AND (${hasPermission(user, 'aftersales.manage')} OR c.createdById = ${user.id} OR o.createdById = ${user.id} OR EXISTS (SELECT 1 FROM operation_logs mine WHERE mine.operatorId = ${user.id} AND mine.entityType = 'ORDER' AND mine.action = 'ASSIGN' AND mine.entityId = o.id)) AND l.entityType = 'AFTER_SALE' AND c.id IS NOT NULL AND l.action IN ('CREATE', 'MESSAGE'))
        OR (${hasPermission(user, 'staff.view')} AND l.entityType = 'STAFF' AND l.action IN ('UPDATE_STATUS', 'UPDATE_PRESENCE', 'UPDATE_ACCEPTING'))
      ) ORDER BY l.createdAt DESC, l.id DESC LIMIT 30`
    const actionLabels: Record<string, string> = {
      CLAIM: '接取了订单', START: '开始服务订单', SUBMIT_COMPLETION: '提交了完单凭证', EXIT_ORDER: '退出了未开始订单',
      CREATE: '发起了售后', MESSAGE: '追加了售后跟进', UPDATE_STATUS: '更新了工作状态', UPDATE_PRESENCE: '更新了在线状态', UPDATE_ACCEPTING: '更新了接单状态',
    }
    return {
      counts, total, allowed, page: currentPage, pageSize, filteredTotal,
      todos: rows.map((row) => ({
        ...row, id: `${row.kind}:${row.id}`,
        title: row.kind === 'completion' ? `订单【${row.orderNo}】待完单审核`
          : row.kind === 'exit' ? `员工【${row.staffName ?? '员工'}】申请退出订单【${row.orderNo}】`
            : `订单【${row.orderNo}】有售后待处理`,
        href: row.kind === 'afterSale' ? `/admin/after-sales?afterSaleId=${encodeURIComponent(row.id)}`
          : `/admin/orders?orderId=${encodeURIComponent(row.orderId)}&reminder=${row.kind}${row.kind === 'exit' ? `&assignmentId=${encodeURIComponent(row.id)}` : ''}`,
      })),
      activities: activity.map((row) => ({
        id: row.id, staffName: row.staffName, action: row.action, orderNo: row.orderNo, occurredAt: row.occurredAt,
        title: `${row.staffName}${actionLabels[row.action]}${row.orderNo ? ` · ${row.orderNo}` : ''}`,
        href: row.entityType === 'AFTER_SALE' ? `/admin/after-sales?afterSaleId=${encodeURIComponent(row.entityId)}`
          : row.orderId ? `/admin/orders?orderId=${encodeURIComponent(row.orderId)}` : '/admin/staff',
      })),
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

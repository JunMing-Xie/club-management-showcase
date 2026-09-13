import { currentActualEarning, currentStaffEarningTotal, settlementBalance } from './earnings.js'
import { staffStatistics } from './staff-statistics.js'
import { financeStaffSettlements } from './finance-staff-settlements.js'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, unlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import type { Request } from 'express'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { changePasswordSchema, changeUsernameSchema, passwordSchema } from './password-policy.js'
import { currentStaffPresence } from './staff-presence.js'
import { deleteOrder, cleanupDeletedOrderProofs } from './delete-order.js'
import {
  Prisma,
  ActivityType,
  AfterSaleResultType,
  AfterSaleStatus,
  CouponType,
  CompletionReviewStatus,
  ExitReviewStatus,
  FundingPolicy,
  FundTransactionType,
  IdentityReviewStatus,
  OrderStatus,
  OrderStaffAssignmentStatus,
  StaffAccepting,
  StaffAccountStatus,
  StaffIncidentType,
  StaffStatus,
  UserRole,
} from '@prisma/client'
import { prisma } from './prisma.js'
import {
  authMiddleware,
  createToken,
  hashPassword,
  hasPermission,
  isAdminRole,
  requirePermission,
  requireRole,
  userView,
  verifyPassword,
  type Permission,
} from './auth.js'
import { config } from './config.js'
import { notifyChange, revokeUserSockets } from './realtime.js'
import { getAdminReminders } from './admin-reminders.js'
import { dispatchRangeSchema, dispatchStatistics } from './dispatch-statistics.js'
import { allPermissions, assertAccountScope, assertRoleConfigScope, manageableRoles, subordinateRoles, configurableRoles, defaultRolePermissions, getRolePermissions, permissionCatalog, rolePermissionKey, saveRolePermissions } from './role-permissions.js'
import { adminRoleSchema, adminRoleUpdateSchema, checkRoleOperator, delegatedPermissions, deleteAdminRole, getUserPermissions, saveAdminRole, validateJobAssignment } from './admin-roles.js'
import { DEFAULT_DASHBOARD_SLOGAN, getDashboardSlogan, saveDashboardSlogan } from './dashboard-copy.js'
import {
  addDays,
  addMonths,
  asyncHandler,
  calculateStaffAmount,
  dateKey,
  endOfDay,
  ensure,
  HttpError,
  logOperation,
  MAX_AMOUNT_CENTS,
  monthKey,
  parseDateRange,
  parseYuanToCents,
  parseSignedYuanToCents,
  startOfDay,
  startOfMonth,
  sumBy,
} from './utils.js'

export const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })
const completionProofDirectory = path.resolve(process.cwd(), 'uploads', 'order-proofs')
const completionProofMimeExtensions = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
])
const completionProofUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      mkdirSync(completionProofDirectory, { recursive: true })
      callback(null, completionProofDirectory)
    },
    filename: (_req, file, callback) => {
      const extension = completionProofMimeExtensions.get(file.mimetype)
      callback(extension ? null : new HttpError(415, '仅支持 JPG、PNG、WEBP 图片'), `${randomUUID()}${extension ?? ''}`)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, callback) => {
    if (!completionProofMimeExtensions.has(file.mimetype)) {
      callback(new HttpError(415, '仅支持 JPG、PNG、WEBP 图片'))
      return
    }
    callback(null, true)
  },
})
const authenticated = [authMiddleware]
const staffOnly = [authMiddleware, requireRole(UserRole.STAFF)]
const accountSecurityLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, keyGenerator: req => req.user!.id, standardHeaders: true, legacyHeaders: false, message: { message: '账号安全验证次数过多，请稍后再试' } })
const adminRead = [authMiddleware, requirePermission('dashboard.view')]
router.get('/admin/reminders', ...authenticated, asyncHandler(async (req, res) => {
  ensure(isAdminRole(req.user!.role) && ['dashboard.view', 'orders.view', 'aftersales.view'].some(key => hasPermission(req.user!, key as Permission)), 403, '没有相关待办查看权限')
  const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), kind: z.enum(['completion', 'exit', 'afterSale']).optional() }).parse(req.query)
  res.setHeader('Cache-Control', 'no-store')
  res.json(await getAdminReminders(req.user!, query.page, query.kind))
}))
const staffRead = [authMiddleware, requirePermission('staff.view')]
const staffManage = [authMiddleware, requirePermission('staff.manage')]
const customerRead = [authMiddleware, requirePermission('customers.view')]
const customerManage = [authMiddleware, requirePermission('customers.manage')]
const customerRecharge = [authMiddleware, requirePermission('customers.recharge')]
const fundAdjust = [authMiddleware, requirePermission('funds.adjust')]
const fundingPolicyManage = fundAdjust
const orderRead = [authMiddleware, requirePermission('orders.view')]
const orderCreate = [authMiddleware, requirePermission('orders.create')]
const orderEdit = [authMiddleware, requirePermission('orders.edit')]
const orderReview = [authMiddleware, requirePermission('orders.review')]
const orderAssign = [authMiddleware, requirePermission('orders.assign')]
const orderLock = [authMiddleware, requirePermission('orders.lock')]
const orderCancel = [authMiddleware, requirePermission('orders.cancel')]
const statsRead = [authMiddleware, requirePermission('stats.view')]
const financeRead = [authMiddleware, requirePermission('finance.view')]
const settlementManage = [authMiddleware, requirePermission('settlement.manage')]
const afterSaleRead = [authMiddleware, requirePermission('aftersales.view')]
const afterSaleManage = [authMiddleware, requirePermission('aftersales.manage')]
const packageManage = [authMiddleware, requirePermission('packages.manage')]
const activityManage = [authMiddleware, requirePermission('activities.manage')]
const couponManage = [authMiddleware, requirePermission('coupons.manage')]
const campaignManage = [authMiddleware, requirePermission('campaigns.manage')]
const noticeManage = [authMiddleware, requirePermission('notices.manage')]
const importManage = [authMiddleware, requirePermission('imports.manage')]
const rbacManage = [authMiddleware, requireRole(UserRole.SUPER_ADMIN, UserRole.STORE_MANAGER), requirePermission('rbac.manage')]

router.get('/dispatch-statistics/me', authMiddleware, requirePermission('dispatch.self'), asyncHandler(async (req, res) => {
  ensure(isAdminRole(req.user!.role), 403, '无权查看后台派单统计')
  ensure(!['userId', 'operatorId', 'staffId', 'role'].some(key => key in req.query), 403, '个人统计只能查询当前登录账号')
  const query = dispatchRangeSchema.strict().parse(req.query)
  res.json(await dispatchStatistics(query, { selfId: req.user!.id }))
}))
router.get('/dispatch-statistics', authMiddleware, requireRole(UserRole.SUPER_ADMIN, UserRole.STORE_MANAGER), requirePermission('dispatch.view'), asyncHandler(async (req, res) => {
  const { operatorId, ...query } = dispatchRangeSchema.extend({ operatorId: z.string().min(1).max(64).optional() }).strict().parse(req.query)
  res.json(await dispatchStatistics(query, { operatorId }))
}))

// These selectors expose only fields needed to place an order, not employee or customer management.
router.get('/order-options/customers', ...orderCreate, asyncHandler(async (req, res) => {
  const { search } = z.object({ search: z.string().trim().min(1).max(128).optional() }).strict().parse(req.query)
  if (!search) { res.json({ items: [] }); return }
  const items = await prisma.customer.findMany({ where: { isBlacklisted: false, OR: [{ customerCode: { contains: search } }, { teamCode: { contains: search } }] }, select: { id: true, customerCode: true, teamCode: true }, take: 20, orderBy: { customerCode: 'asc' } })
  res.json({ items })
}))
router.get('/order-options/staff', ...orderAssign, asyncHandler(async (_req, res) => {
  res.json({ items: await prisma.staffProfile.findMany({ where: { user: { isActive: true }, accountStatus: 'NORMAL' }, select: { id: true, name: true, status: true, tierId: true }, orderBy: { name: 'asc' } }) })
}))
router.get('/order-options/tiers', ...orderCreate, asyncHandler(async (_req, res) => {
  res.json({ items: await prisma.staffTier.findMany({ where: { isEnabled: true }, select: { id: true, name: true, level: true, isEnabled: true, priceMultiplierBps: true }, orderBy: { level: 'asc' } }) })
}))

const loginSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(72) })
const staffCreateSchema = z.object({
  username: z.string().trim().min(2).max(64),
  password: passwordSchema,
  name: z.string().trim().min(1).max(64),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
  contact: z.string().trim().max(128).optional().or(z.literal('')),
  realName: z.string().trim().max(64).optional().or(z.literal('')),
  idNumber: z.string().trim().max(32).optional().or(z.literal('')),
  tierId: z.string().min(1).optional(),
  commissionRateBps: z.number().int().min(0).max(10000).optional(),
})
const staffUpdateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
  contact: z.string().trim().max(128).optional().or(z.literal('')),
  realName: z.string().trim().max(64).optional().or(z.literal('')),
  idNumber: z.string().trim().max(32).optional().or(z.literal('')),
  identityReviewNote: z.string().max(2000).optional().or(z.literal('')),
  tierId: z.string().min(1).nullable().optional(),
  commissionRateBps: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
  accountStatus: z.nativeEnum(StaffAccountStatus).optional(),
  accepting: z.nativeEnum(StaffAccepting).optional(),
  note: z.string().max(2000).optional().or(z.literal('')),
})
const customerSchema = z.object({
  customerCode: z.string().trim().min(1).max(128),
  teamCode: z.string().trim().min(1).max(128),
  tags: z.string().max(1000).optional().or(z.literal('')),
  note: z.string().max(2000).optional().or(z.literal('')),
  isBlacklisted: z.boolean().optional(),
})
const collaborationSlotSchema = z.object({
  slotIndex: z.coerce.number().int().min(1).max(20),
  commissionRateBps: z.coerce.number().int().min(0).max(10000),
})
const orderBaseSchema = z.object({
  customerId: z.string().min(1).nullable().optional(),
  serviceItem: z.string().trim().min(1).max(160).optional(),
  amountCents: z.coerce.number().int().nonnegative().max(MAX_AMOUNT_CENTS).optional(),
  originalAmountCents: z.coerce.number().int().nonnegative().max(MAX_AMOUNT_CENTS).optional(),
  discountAmountCents: z.coerce.number().int().nonnegative().max(MAX_AMOUNT_CENTS).optional(),
  staffAmountCents: z.coerce.number().int().nonnegative().max(MAX_AMOUNT_CENTS).optional(),
  staffId: z.string().min(1).nullable().optional(),
  servicePackageId: z.string().min(1).nullable().optional(),
  requiredTierId: z.string().min(1).nullable().optional(),
  customerCouponId: z.string().min(1).nullable().optional(),
  requiredStaffCount: z.coerce.number().int().min(1).max(20).optional(),
  collaborationSlots: z.array(collaborationSlotSchema).max(20).optional(),
  note: z.string().max(2000).optional().or(z.literal('')),
})
const orderCreateSchema = orderBaseSchema.extend({
  preassignedStaffIds: z.array(z.string().min(1)).max(20).optional(),
  servicePackageId: z.string().min(1),
  newCustomer: z.object({
    customerCode: z.string().trim().min(1).max(128),
    teamCode: z.string().trim().min(1).max(128),
    note: z.string().max(2000).optional().or(z.literal('')),
  }).optional(),
  rechargeAmountCents: z.coerce.number().int().nonnegative().max(MAX_AMOUNT_CENTS).optional(),
  rechargeNote: z.string().max(2000).optional().or(z.literal('')),
}).superRefine((body, context) => {
  if (Boolean(body.customerId) === Boolean(body.newCustomer)) {
    context.addIssue({ code: 'custom', message: '请选择已有客户或录入新客户' })
  }
})
const orderUpdateSchema = orderBaseSchema.partial().extend({ status: z.nativeEnum(OrderStatus).optional() })
const assignmentRatesSchema = z.object({ slots: z.array(collaborationSlotSchema).min(1).max(20) })
const exitRequestSchema = z.object({ reason: z.string().trim().min(2).max(2000) })
const exitReviewSchema = z.object({ approved: z.boolean(), note: z.string().max(2000).optional().or(z.literal('')) })
const completionReviewSchema = z.object({ approved: z.boolean(), reason: z.string().max(2000).optional().or(z.literal('')) }).superRefine((body, context) => {
  if (!body.approved && !body.reason?.trim()) context.addIssue({ code: 'custom', path: ['reason'], message: '审核退回时必须填写原因' })
})
const afterSaleCreateSchema = z.object({
  orderId: z.string().min(1),
  issueType: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(4000),
})
const afterSaleUpdateSchema = z.object({
  issueType: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  status: z.nativeEnum(AfterSaleStatus).optional(),
  resultType: z.nativeEnum(AfterSaleResultType).nullable().optional(),
  compensationAmount: z.union([z.number(), z.string()]).optional(),
  refundAmount: z.union([z.number(), z.string()]).optional(),
  supplementaryOrderId: z.string().min(1).nullable().optional(),
  handlingNote: z.string().max(4000).optional().or(z.literal('')),
})
const settlementSchema = z.object({
  requestId: z.string().trim().min(8).max(64),
  amount: z.union([z.number(), z.string()]),
  settlementMethod: z.string().trim().min(1).max(64),
  settlementDate: z.string().trim().min(1),
  note: z.string().max(2000).optional().or(z.literal('')),
})
const orderAdjustmentSchema = z.object({
  requestId: z.string().trim().min(8).max(64),
  afterSaleId: z.string().min(1).nullable().optional(),
  reason: z.string().trim().min(1).max(255),
  handlingNote: z.string().max(4000).optional().or(z.literal('')),
  netAmount: z.union([z.number(), z.string()]),
  staffNetEarnings: z.array(z.object({ assignmentId: z.string().min(1), amount: z.union([z.number(), z.string()]) })).max(20),
})
const safePlainText = (label: string, max: number) => z.string().trim().min(1, `${label}不能为空`).max(max).refine((value) => !/[<>]/.test(value), `${label}不能包含 HTML 标签`)
const workbenchWelcomeSchema = z.object({
  titleTemplate: safePlainText('主标题模板', 120).refine((value) => value.includes('{员工昵称}'), '主标题模板必须包含 {员工昵称}'),
  subtitle: safePlainText('辅助文案', 240),
})
const fundAdjustmentSchema = z.object({
  principalAmount: z.union([z.number(), z.string()]).optional(),
  bonusAmount: z.union([z.number(), z.string()]).optional(),
  note: z.string().trim().min(1).max(2000),
})
const messageSchema = z.object({ content: z.string().trim().min(1).max(4000) })
const tierSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(2000).optional().or(z.literal('')),
  level: z.coerce.number().int().min(1).max(99).optional(),
  priceMultiplierBps: z.coerce.number().int().min(1).max(50000).optional(),
  canAcceptOrders: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
  sort: z.coerce.number().int().min(0).max(9999).optional(),
  remark: z.string().max(2000).optional().or(z.literal('')),
})
const packageSchema = z.object({
  name: z.string().trim().min(1).max(128),
  category: z.string().max(64).optional().or(z.literal('')),
  description: z.string().max(2000).optional().or(z.literal('')),
  basePriceCents: z.coerce.number().int().nonnegative().max(MAX_AMOUNT_CENTS),
  isEnabled: z.boolean().optional(),
  sort: z.coerce.number().int().min(0).max(9999).optional(),
  note: z.string().max(2000).optional().or(z.literal('')),
})
const activitySchema = z.object({
  name: z.string().trim().min(1).max(128),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  isEnabled: z.boolean().optional(),
  note: z.string().max(2000).optional().or(z.literal('')),
  tiers: z.array(z.object({ thresholdCents: z.coerce.number().int().positive(), bonusCents: z.coerce.number().int().nonnegative() })).min(1),
})
const couponSchema = z.object({
  name: z.string().trim().min(1).max(128),
  amountCents: z.coerce.number().int().positive().max(MAX_AMOUNT_CENTS),
  minSpendCents: z.coerce.number().int().nonnegative().max(MAX_AMOUNT_CENTS).optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  isEnabled: z.boolean().optional(),
  note: z.string().max(2000).optional().or(z.literal('')),
})
const campaignSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: z.nativeEnum(ActivityType),
  rule: z.record(z.string(), z.unknown()).optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  isEnabled: z.boolean().optional(),
  note: z.string().max(2000).optional().or(z.literal('')),
})
const noticeSchema = z.object({
  type: z.enum(['ANNOUNCEMENT', 'RISK']),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(4000),
  isEnabled: z.boolean().optional(),
})
const adminAccountUpdateSchema = z.object({
  adminRoleId: z.string().min(1).max(191).nullable().optional(),
  username: z.string().trim().min(2).max(64).optional(),
  role: z.nativeEnum(UserRole).optional(),
  isActive: z.boolean().optional(),
}).refine((body) => Object.keys(body).length > 0, '请提供需要修改的账号信息')

const getParam = (req: Request, name = 'id') => {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] ?? '' : value
}
const parseQueryDate = (value: unknown, fallback: Date) => {
  if (typeof value !== 'string' || !value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}
const maskIdNumber = (value: string | null | undefined) => {
  if (!value) return null
  if (value.length <= 6) return '*'.repeat(Math.max(value.length - 2, 1)) + value.slice(-2)
  return value.slice(0, 3) + '***********' + value.slice(-4)
}
const orderNo = () => {
  const now = new Date()
  return 'CLB' + now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + String(now.getTime()).slice(-7)
}
const caseNo = () => 'AS' + String(Date.now()).slice(-10)
const currentAssignmentStatuses = [OrderStaffAssignmentStatus.OPEN, OrderStaffAssignmentStatus.CLAIMED, OrderStaffAssignmentStatus.ACTIVE, OrderStaffAssignmentStatus.EXIT_REQUESTED] as const
const participatingAssignmentStatuses = [OrderStaffAssignmentStatus.CLAIMED, OrderStaffAssignmentStatus.ACTIVE, OrderStaffAssignmentStatus.EXIT_REQUESTED, OrderStaffAssignmentStatus.COMPLETED] as const
const capacityAssignmentStatuses = [OrderStaffAssignmentStatus.CLAIMED, OrderStaffAssignmentStatus.ACTIVE, OrderStaffAssignmentStatus.EXIT_REQUESTED] as const
const finalizedOrderStatuses = [OrderStatus.COMPLETED, OrderStatus.AFTER_SALE] as const
const orderInclude = {
  orderConsumption: { select: { id: true } },
  customer: { select: { id: true, name: true, phone: true, customerCode: true, teamCode: true, balanceCents: true, principalBalanceCents: true, bonusBalanceCents: true, isBlacklisted: true } },
  staff: { select: { id: true, name: true, status: true, presence: true, accepting: true, selfAccepting: true, accountStatus: true, tierId: true, commissionRateBps: true } },
  servicePackage: { select: { id: true, name: true, category: true, description: true, basePriceCents: true } },
  requiredTier: { select: { id: true, name: true, level: true, priceMultiplierBps: true } },
  customerCoupon: { select: { id: true, status: true, coupon: { select: { name: true, amountCents: true } } } },
  completionReviewedBy: { select: { username: true } },
  afterSaleCase: { select: { id: true, messages: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }], include: { author: { select: { username: true, role: true, staffProfile: { select: { name: true } } } } } } } },
  assignments: {
    orderBy: [{ slotIndex: 'asc' as const }, { createdAt: 'asc' as const }],
    include: {
      staff: { select: { id: true, name: true, status: true, presence: true, accepting: true, selfAccepting: true, accountStatus: true, tierId: true } },
      completionProofs: { orderBy: { submittedAt: 'asc' as const } },
      earningAdjustments: { orderBy: { createdAt: 'asc' as const } },
    },
  },
  adjustments: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      staffAdjustments: { include: { staff: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' as const } },
      afterSale: { select: { id: true, caseNo: true } },
      operator: { select: { username: true } },
    },
  },
} satisfies Prisma.OrderInclude
type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>
type AssignmentWithRelations = OrderWithRelations['assignments'][number]

const latestSlotAssignments = (assignments: AssignmentWithRelations[]) => {
  const latest = new Map<number, AssignmentWithRelations>()
  for (const assignment of assignments) latest.set(assignment.slotIndex, assignment)
  return [...latest.values()].sort((a, b) => a.slotIndex - b.slotIndex)
}

const orderView = (order: OrderWithRelations, staffView = false, viewerStaffId?: string, hideCustomerId = false, includeStaffDetail = false) => {
  const currentSlots = latestSlotAssignments(order.assignments)
  const activeAssignments = currentSlots.filter((assignment) => assignment.staffId && participatingAssignmentStatuses.includes(assignment.assignmentStatus as typeof participatingAssignmentStatuses[number]))
  const submittedAssignments = activeAssignments.filter((assignment) => assignment.completionReviewStatus === CompletionReviewStatus.SUBMITTED || assignment.completionReviewStatus === CompletionReviewStatus.APPROVED)
  const viewerCanSeeCustomerId = Boolean(viewerStaffId && order.assignments.some((assignment) => assignment.staffId === viewerStaffId && participatingAssignmentStatuses.includes(assignment.assignmentStatus as typeof participatingAssignmentStatuses[number])))
  const { customerId: _customerId, staffId: _legacyStaffId, createdById: _createdById, lockedById: _lockedById, completionReviewedById: _completionReviewedById, adjustments, ...orderWithoutInternalIds } = order
  const visibleOrder = staffView
    ? orderWithoutInternalIds
    : { ...order, adjustments }
  const visibleStaffAdjustments = staffView && viewerStaffId
    ? adjustments.map((item) => ({
        ...item,
        staffAdjustments: item.staffAdjustments.filter((staffItem) => staffItem.staffId === viewerStaffId),
      }))
    : adjustments
  const customer = staffView
    ? viewerCanSeeCustomerId && !hideCustomerId
      ? { customerCode: order.customer.customerCode, teamCode: order.customer.teamCode }
      : { customerCode: null, teamCode: null }
    : order.customer
  const assignments = hideCustomerId
    ? currentSlots.map((assignment) => assignment.assignmentStatus === OrderStaffAssignmentStatus.OPEN
      ? {
          slotIndex: assignment.slotIndex,
          commissionRateBps: assignment.commissionRateBps,
          expectedEarningCents: assignment.expectedEarningCents,
          assignmentStatus: assignment.assignmentStatus,
          occupied: false,
        }
      : {
          slotIndex: assignment.slotIndex,
          assignmentStatus: assignment.assignmentStatus,
          occupied: true,
        })
    : order.assignments.map(({ completionProofs, earningAdjustments, ...assignment }) => {
        if (staffView && assignment.staffId !== viewerStaffId) {
          return {
            id: assignment.id,
            slotIndex: assignment.slotIndex,
            assignmentStatus: assignment.assignmentStatus,
            completionReviewStatus: assignment.completionReviewStatus,
            staff: assignment.staff,
            occupied: Boolean(assignment.staffId),
          }
        }
        return {
          ...assignment,
          currentNetEarningCents: currentActualEarning({ ...assignment, earningAdjustments }),
          completionProofs: completionProofs.map(({ proofPath: _proofPath, ...proof }) => ({ ...proof, fileUrl: `/api/order-proofs/${proof.id}/file` })),
        }
      })
  const adjustmentTotalCents = sumBy(adjustments, (item) => item.orderAmountDeltaCents)
  return {
    ...visibleOrder,
    hasOriginalSettlement: Boolean(order.orderConsumption),
    customer,
    assignments,
    ...(includeStaffDetail && staffView ? { adjustments: visibleStaffAdjustments, afterSaleCase: order.afterSaleCase } : {}),
    afterSaleCase: staffView && !includeStaffDetail ? undefined : order.afterSaleCase,
    activeStaffCount: activeAssignments.length,
    missingStaffCount: Math.max(order.requiredStaffCount - activeAssignments.length, 0),
    isTeamFull: activeAssignments.length >= order.requiredStaffCount,
    completionSubmittedCount: submittedAssignments.length,
    completionRequiredCount: activeAssignments.length,
    adjustmentTotalCents,
    currentNetAmountCents: order.amountCents + adjustmentTotalCents,
    currentStaffEarningTotalCents: staffView ? undefined : currentStaffEarningTotal(order.assignments),
  }
}
const orderStatusLabel = (status: OrderStatus) => ({
  [OrderStatus.PENDING_PAYMENT]: '待付款',
  [OrderStatus.PENDING_ASSIGNMENT]: '待派单',
  [OrderStatus.PENDING]: '待处理 / 已接单',
  [OrderStatus.IN_PROGRESS]: '进行中',
  [OrderStatus.PENDING_COMPLETION_REVIEW]: '待完单审核',
  [OrderStatus.COMPLETED]: '已完成',
  [OrderStatus.AFTER_SALE]: '售后中',
  [OrderStatus.CANCELLED]: '已取消',
}[status])
const orderRevenue = (status: OrderStatus) => finalizedOrderStatuses.includes(status as typeof finalizedOrderStatuses[number])
const orderActualStaffEarnings = (order: { staffAmountCents: number; assignments?: Array<{ actualEarningCents: number; earningAdjustments?: Array<{ earningDeltaCents: number }> }> }) =>
  order.assignments?.length ? currentStaffEarningTotal(order.assignments) : order.staffAmountCents
const orderNetAmount = (order: { amountCents: number; adjustments?: Array<{ orderAmountDeltaCents: number }> }) => order.amountCents + sumBy(order.adjustments ?? [], (item) => item.orderAmountDeltaCents)
const getStatsForOrders = (orders: Array<{ amountCents: number; staffAmountCents: number; status: OrderStatus; assignments?: Array<{ actualEarningCents: number; earningAdjustments?: Array<{ earningDeltaCents: number }> }>; adjustments?: Array<{ orderAmountDeltaCents: number }> }>) => ({
  orderCount: orders.length,
  completedOrderCount: orders.filter((item) => orderRevenue(item.status)).length,
  revenueCents: sumBy(orders.filter((item) => orderRevenue(item.status)), orderNetAmount),
  staffEarningsCents: sumBy(orders.filter((item) => orderRevenue(item.status)), orderActualStaffEarnings),
})
const updateDerivedStaffStatus = async (client: Prisma.TransactionClient | typeof prisma, staffId: string) => {
  const count = await client.orderStaffAssignment.count({
    where: {
      staffId,
      assignmentStatus: { in: [OrderStaffAssignmentStatus.ACTIVE, OrderStaffAssignmentStatus.EXIT_REQUESTED] },
      order: { status: { in: [OrderStatus.IN_PROGRESS, OrderStatus.PENDING_COMPLETION_REVIEW] } },
    },
  })
  await client.staffProfile.update({ where: { id: staffId }, data: { status: count > 0 ? StaffStatus.BUSY : StaffStatus.IDLE } })
}
const updateDerivedStaffStatuses = async (client: Prisma.TransactionClient | typeof prisma, staffIds: Array<string | null | undefined>) => {
  for (const staffId of new Set(staffIds.filter((value): value is string => Boolean(value)))) await updateDerivedStaffStatus(client, staffId)
}
const getStaff = async (staffId: string, checkNormal = true) => {
  const staff = await prisma.staffProfile.findUnique({ where: { id: staffId }, include: { user: true, tier: true } })
  ensure(staff, 404, '员工不存在')
  ensure(staff.user.isActive, 400, '该员工账号已禁用')
  if (checkNormal) ensure(staff.accountStatus === StaffAccountStatus.NORMAL, 400, '该员工账号当前不可接单')
  return staff
}
const getOrderForUser = async (id: string, request: Request) => {
  const staffId = request.user?.role === UserRole.STAFF ? request.user.staffProfileId : undefined
  ensure(request.user && (isAdminRole(request.user.role) || staffId), 403, '没有权限查看订单')
  const order = await prisma.order.findFirst({
    where: {
      id,
      ...(staffId ? { assignments: { some: { staffId, assignmentStatus: { in: [...participatingAssignmentStatuses] } } } } : {}),
    },
    include: orderInclude,
  })
  ensure(order, 404, '订单不存在或无权查看')
  return order
}
const getCustomer = async (id: string, client: typeof prisma | Prisma.TransactionClient = prisma) => {
  const customer = await client.customer.findUnique({ where: { id } })
  ensure(customer, 404, '客户不存在')
  return customer
}
const FUNDING_POLICY_SETTING_KEY = 'funding_policy_default'
const WORKBENCH_WELCOME_TITLE_KEY = 'workbench_welcome_title_template'
const WORKBENCH_WELCOME_SUBTITLE_KEY = 'workbench_welcome_subtitle'
const DEFAULT_WORKBENCH_WELCOME = {
  titleTemplate: '{员工昵称}，今天辛苦了。',
  subtitle: '把每个进度更新好，现场就会一直清楚。',
}
const getWorkbenchWelcome = async (client: typeof prisma | Prisma.TransactionClient = prisma) => {
  const items = await client.systemSetting.findMany({ where: { key: { in: [WORKBENCH_WELCOME_TITLE_KEY, WORKBENCH_WELCOME_SUBTITLE_KEY] } } })
  const settings = new Map(items.map((item) => [item.key, item.value]))
  return {
    titleTemplate: settings.get(WORKBENCH_WELCOME_TITLE_KEY) || DEFAULT_WORKBENCH_WELCOME.titleTemplate,
    subtitle: settings.get(WORKBENCH_WELCOME_SUBTITLE_KEY) || DEFAULT_WORKBENCH_WELCOME.subtitle,
  }
}
const renderWorkbenchWelcome = (template: string, staffName: string) => template.replaceAll('{员工昵称}', staffName)
type ScheduleStatus = 'ENABLED' | 'DISABLED' | 'EXPIRED' | 'NOT_STARTED'
const getScheduleStatus = (item: { isEnabled: boolean; startAt: Date; endAt: Date }, now = new Date()): ScheduleStatus => {
  if (!item.isEnabled) return 'DISABLED'
  if (item.endAt < now) return 'EXPIRED'
  if (item.startAt > now) return 'NOT_STARTED'
  return 'ENABLED'
}
const getGlobalFundingPolicy = async (client: typeof prisma | Prisma.TransactionClient = prisma): Promise<FundingPolicy> => {
  const setting = await client.systemSetting.findUnique({ where: { key: FUNDING_POLICY_SETTING_KEY } })
  return setting?.value === FundingPolicy.BONUS_FIRST ? FundingPolicy.BONUS_FIRST : FundingPolicy.PRINCIPAL_FIRST
}
const getAvailableActivityBonus = async (amountCents: number, now = new Date()) => {
  const activities = await prisma.rechargeActivity.findMany({
    where: { isEnabled: true, startAt: { lte: now }, endAt: { gte: now } },
    include: { tiers: { where: { thresholdCents: { lte: amountCents } }, orderBy: { thresholdCents: 'desc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
  })
  const matches = activities.flatMap((activity) => activity.tiers.map((tier) => ({ activity, tier })))
  const match = matches.sort((a, b) => b.tier.thresholdCents - a.tier.thresholdCents || b.tier.bonusCents - a.tier.bonusCents || b.activity.createdAt.getTime() - a.activity.createdAt.getTime())[0]
  return { activity: match?.activity, bonusCents: match?.tier.bonusCents ?? 0 }
}
const getValidCustomerCoupon = async (
  client: typeof prisma | Prisma.TransactionClient,
  couponId: string,
  customerId: string,
  spendCents: number,
  now = new Date(),
) => {
  const customerCoupon = await client.customerCoupon.findUnique({ where: { id: couponId }, include: { coupon: true } })
  ensure(customerCoupon, 404, '优惠券不存在')
  ensure(customerCoupon.customerId === customerId, 403, '优惠券不属于当前客户')
  ensure(customerCoupon.status === 'ISSUED' && !customerCoupon.usedOrderId, 409, '优惠券已使用或不可用')
  ensure(customerCoupon.coupon.isEnabled && customerCoupon.coupon.startAt <= now && customerCoupon.coupon.endAt >= now, 409, '优惠券已过期或已停用')
  ensure(spendCents >= customerCoupon.coupon.minSpendCents, 409, `订单金额未达到优惠券最低消费 ${(customerCoupon.coupon.minSpendCents / 100).toFixed(2)} 元`)
  ensure(customerCoupon.coupon.type === CouponType.FIXED, 400, '当前优惠券类型暂不支持')
  ensure(customerCoupon.coupon.amountCents <= spendCents, 409, '优惠券面额不能高于订单金额')
  return customerCoupon
}
const expireCustomerCoupons = async (customerId: string, client: typeof prisma | Prisma.TransactionClient = prisma) => {
  await client.customerCoupon.updateMany({ where: { customerId, status: 'ISSUED', coupon: { endAt: { lt: new Date() } } }, data: { status: 'EXPIRED' } })
}
const ensureCustomerCanOrder = async (customerId: string) => {
  const customer = await getCustomer(customerId)
  ensure(!customer.isBlacklisted, 409, '该客户已被列入黑名单，暂不能创建订单')
  return customer
}
const findTier = async (tierId: string | null | undefined) => {
  if (!tierId) return null
  const tier = await prisma.staffTier.findUnique({ where: { id: tierId } })
  ensure(tier, 404, '员工层级不存在')
  return tier
}
const validateCollaborationSlots = (requiredStaffCount: number, slots: Array<{ slotIndex: number; commissionRateBps: number }>) => {
  ensure(slots.length === requiredStaffCount, 400, `需要配置 ${requiredStaffCount} 个协作名额`)
  const normalized = [...slots].sort((a, b) => a.slotIndex - b.slotIndex)
  ensure(new Set(normalized.map((slot) => slot.slotIndex)).size === requiredStaffCount, 400, '协作名额序号不能重复')
  ensure(normalized.every((slot, index) => slot.slotIndex === index + 1), 400, '协作名额必须从 1 连续编号')
  ensure(sumBy(normalized, (slot) => slot.commissionRateBps) <= 10000, 400, '协作提成比例合计不能超过 100%')
  return normalized
}

const lockOrderRow = async (tx: Prisma.TransactionClient, orderId: string) => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
  ensure(rows.length === 1, 404, '订单不存在')
}

const lockStaffRow = async (tx: Prisma.TransactionClient, staffId: string) => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM staff_profiles WHERE id = ${staffId} FOR UPDATE`
  ensure(rows.length === 1, 404, '员工不存在')
}

const currentStaffEarnings = async (client: typeof prisma | Prisma.TransactionClient, staffId: string) => {
  const [completed, adjustments, settled] = await Promise.all([
    client.orderStaffAssignment.aggregate({ where: { staffId, assignmentStatus: OrderStaffAssignmentStatus.COMPLETED }, _sum: { actualEarningCents: true } }),
    client.staffEarningAdjustment.aggregate({ where: { staffId }, _sum: { earningDeltaCents: true } }),
    client.settlementRecord.aggregate({ where: { staffId }, _sum: { amountCents: true } }),
  ])
  const earnedCents = currentActualEarning({ actualEarningCents: completed._sum.actualEarningCents ?? 0, earningAdjustments: [{ earningDeltaCents: adjustments._sum.earningDeltaCents ?? 0 }] })
  const settledCents = settled._sum.amountCents ?? 0
  return {
    earnedCents,
    settledCents,
    ...settlementBalance(earnedCents, settledCents),
  }
}

const createRechargeInTransaction = async (
  tx: Prisma.TransactionClient,
  customerId: string,
  operatorId: string,
  principalAmountCents: number,
  bonusAmountCents: number,
  note?: string,
) => {
  const current = await tx.customer.findUnique({ where: { id: customerId } })
  ensure(current, 404, '客户不存在')
  const principalAfterCents = current.principalBalanceCents + principalAmountCents
  const bonusAfterCents = current.bonusBalanceCents + bonusAmountCents
  const balanceAfterCents = current.balanceCents + principalAmountCents + bonusAmountCents
  const updated = await tx.customer.update({
    where: { id: current.id },
    data: {
      principalBalanceCents: { increment: principalAmountCents },
      bonusBalanceCents: { increment: bonusAmountCents },
      balanceCents: { increment: principalAmountCents + bonusAmountCents },
    },
  })
  const record = await tx.rechargeRecord.create({
    data: {
      customerId: current.id,
      operatorId,
      amountCents: principalAmountCents + bonusAmountCents,
      principalAmountCents,
      bonusAmountCents,
      note: note || null,
    },
  })
  if (principalAmountCents > 0) {
    await tx.fundTransaction.create({
      data: {
        customerId: current.id,
        operatorId,
        type: FundTransactionType.PRINCIPAL_RECHARGE,
        amountCents: principalAmountCents,
        principalBeforeCents: current.principalBalanceCents,
        principalAfterCents,
        bonusBeforeCents: current.bonusBalanceCents,
        bonusAfterCents: current.bonusBalanceCents,
        balanceBeforeCents: current.balanceCents,
        balanceAfterCents: current.balanceCents + principalAmountCents,
        note: note || '本金充值',
      },
    })
  }
  if (bonusAmountCents > 0) {
    await tx.fundTransaction.create({
      data: {
        customerId: current.id,
        operatorId,
        type: FundTransactionType.BONUS_RECHARGE,
        amountCents: bonusAmountCents,
        principalBeforeCents: principalAfterCents,
        principalAfterCents,
        bonusBeforeCents: current.bonusBalanceCents,
        bonusAfterCents,
        balanceBeforeCents: current.balanceCents + principalAmountCents,
        balanceAfterCents,
        note: '充值活动赠金',
      },
    })
  }
  await logOperation(tx, {
    operatorId,
    action: 'RECHARGE',
    entityType: 'CUSTOMER',
    entityId: current.id,
    detail: { rechargeRecordId: record.id, principalAmountCents, bonusAmountCents, balanceBeforeCents: current.balanceCents, balanceAfterCents },
  })
  return { customer: updated, record, bonusCents: bonusAmountCents }
}

const completeOrderWithBalance = async (tx: Prisma.TransactionClient, orderId: string, operatorId: string) => {
  await lockOrderRow(tx, orderId)
  const current = await tx.order.findUnique({ where: { id: orderId }, include: orderInclude })
  ensure(current, 404, '订单不存在')
  if (current.status === OrderStatus.COMPLETED) {
    return tx.order.findUnique({ where: { id: current.id, }, include: orderInclude })
  }
  ensure(current.status === OrderStatus.PENDING_COMPLETION_REVIEW, 400, '只有待完单审核的订单可以审核通过')
  const slots = latestSlotAssignments(current.assignments)
  const activeAssignments = slots.filter((assignment) => assignment.staffId && capacityAssignmentStatuses.includes(assignment.assignmentStatus as typeof capacityAssignmentStatuses[number]))
  ensure(activeAssignments.length === current.requiredStaffCount, 409, '协作人员尚未到齐')
  ensure(activeAssignments.every((assignment) => assignment.completionReviewStatus === CompletionReviewStatus.SUBMITTED), 409, '仍有员工未提交完单凭证')

  const customer = await tx.customer.findUnique({ where: { id: current.customerId } })
  ensure(customer, 404, '客户不存在')
  const amount = current.amountCents
  const principalBefore = customer.principalBalanceCents
  const bonusBefore = customer.bonusBalanceCents
  const fundingPolicy = await getGlobalFundingPolicy(tx)
  const bonusUsed = fundingPolicy === FundingPolicy.BONUS_FIRST ? Math.min(bonusBefore, amount) : Math.min(bonusBefore, Math.max(0, amount - Math.min(principalBefore, amount)))
  const actualPrincipalUsed = fundingPolicy === FundingPolicy.BONUS_FIRST ? Math.max(0, amount - bonusUsed) : Math.min(principalBefore, amount)
  const available = principalBefore + bonusBefore
  ensure(available >= amount, 409, '客户余额不足，请先充值或调整余额')
  ensure(principalBefore >= actualPrincipalUsed && bonusBefore >= bonusUsed, 409, '客户余额不足，请先充值或调整余额')
  const updatedCustomer = await tx.customer.updateMany({
    where: { id: customer.id, principalBalanceCents: { gte: actualPrincipalUsed }, bonusBalanceCents: { gte: bonusUsed }, balanceCents: { gte: amount } },
    data: {
      principalBalanceCents: { decrement: actualPrincipalUsed },
      bonusBalanceCents: { decrement: bonusUsed },
      balanceCents: { decrement: amount },
    },
  })
  ensure(updatedCustomer.count === 1, 409, '客户账户余额发生变化，请刷新后重试')
  const principalAfter = principalBefore - actualPrincipalUsed
  const bonusAfter = bonusBefore - bonusUsed
  const balanceBefore = principalBefore + bonusBefore
  const balanceAfter = principalAfter + bonusAfter
  const consumption = await tx.orderConsumption.create({
    data: {
      orderId: current.id,
      customerId: current.customerId,
      operatorId,
      totalAmountCents: amount,
      principalUsedCents: actualPrincipalUsed,
      bonusUsedCents: bonusUsed,
      principalBeforeCents: principalBefore,
      principalAfterCents: principalAfter,
      bonusBeforeCents: bonusBefore,
      bonusAfterCents: bonusAfter,
    },
  })
  await tx.consumptionRecord.create({
    data: {
      customerId: current.customerId,
      orderId: current.id,
      operatorId,
      amountCents: amount,
      balanceBeforeCents: balanceBefore,
      balanceAfterCents: balanceAfter,
      note: '订单 ' + current.orderNo + ' 完成消费',
    },
  })
  let principalRunning = principalBefore
  let bonusRunning = bonusBefore
  if (actualPrincipalUsed > 0) {
    await tx.fundTransaction.create({
      data: {
        customerId: current.customerId,
        operatorId,
        orderId: current.id,
        type: FundTransactionType.PRINCIPAL_CONSUMPTION,
        amountCents: -actualPrincipalUsed,
        principalBeforeCents: principalRunning,
        principalAfterCents: principalAfter,
        bonusBeforeCents: bonusRunning,
        bonusAfterCents: bonusAfter,
        balanceBeforeCents: balanceBefore,
        balanceAfterCents: balanceAfter,
        note: '订单 ' + current.orderNo + ' 本金消费',
      },
    })
    principalRunning = principalAfter
  }
  if (bonusUsed > 0) {
    await tx.fundTransaction.create({
      data: {
        customerId: current.customerId,
        operatorId,
        orderId: current.id,
        type: FundTransactionType.BONUS_CONSUMPTION,
        amountCents: -bonusUsed,
        principalBeforeCents: principalRunning,
        principalAfterCents: principalAfter,
        bonusBeforeCents: bonusRunning,
        bonusAfterCents: bonusAfter,
        balanceBeforeCents: balanceBefore,
        balanceAfterCents: balanceAfter,
        note: '订单 ' + current.orderNo + ' 赠金消费',
      },
    })
    bonusRunning = bonusAfter
  }
  await logOperation(tx, {
    operatorId,
    action: 'CONSUME',
    entityType: 'CUSTOMER',
    entityId: current.customerId,
    detail: { orderId: current.id, orderNo: current.orderNo, amountCents: amount, principalUsedCents: actualPrincipalUsed, bonusUsedCents: bonusUsed, balanceBeforeCents: balanceBefore, balanceAfterCents: balanceAfter, orderConsumptionId: consumption.id },
  })
  const completedAt = new Date()
  for (const assignment of activeAssignments) {
    await tx.orderStaffAssignment.update({
      where: { id: assignment.id },
      data: {
        assignmentStatus: OrderStaffAssignmentStatus.COMPLETED,
        actualEarningCents: assignment.expectedEarningCents,
        completedAt,
        completionReviewStatus: CompletionReviewStatus.APPROVED,
        completionReviewReason: null,
      },
    })
  }
  const actualEarningCents = sumBy(activeAssignments, (assignment) => assignment.expectedEarningCents)
  await tx.orderCompletionProof.updateMany({
    where: { orderId: current.id, reviewStatus: CompletionReviewStatus.SUBMITTED },
    data: { reviewStatus: CompletionReviewStatus.APPROVED },
  })
  await tx.order.update({
    where: { id: current.id },
    data: {
      status: OrderStatus.COMPLETED,
      staffAmountCents: actualEarningCents,
      completedAt,
      completionReviewStatus: CompletionReviewStatus.APPROVED,
      completionReviewReason: null,
      completionReviewedAt: completedAt,
      completionReviewedById: operatorId,
    },
  })
  await logOperation(tx, { operatorId, action: 'APPROVE_COMPLETION', entityType: 'ORDER', entityId: current.id, detail: { orderConsumptionId: consumption.id, assignmentIds: activeAssignments.map((assignment) => assignment.id), actualEarningCents } })
  await updateDerivedStaffStatuses(tx, activeAssignments.map((assignment) => assignment.staffId))
  return tx.order.findUnique({ where: { id: current.id }, include: orderInclude })
}

const isAllowedImageSignature = async (file: Express.Multer.File) => {
  const data = await readFile(file.path)
  if (file.mimetype === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  if (file.mimetype === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (file.mimetype === 'image/webp') return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
  return false
}

const removeUploadedFiles = async (files: Express.Multer.File[]) => {
  await Promise.allSettled(files.map((file) => unlink(file.path)))
}

const getCurrentAssignments = (client: Prisma.TransactionClient | typeof prisma, orderId: string) =>
  client.orderStaffAssignment.findMany({
    where: { orderId, assignmentStatus: { in: [...currentAssignmentStatuses] } },
    orderBy: [{ slotIndex: 'asc' }, { createdAt: 'desc' }],
    include: { staff: { select: { id: true, name: true } } },
  })

const syncLegacyAssignmentFields = async (client: Prisma.TransactionClient, orderId: string) => {
  const assignments = await getCurrentAssignments(client, orderId)
  const participants = assignments.filter((assignment) => assignment.staffId && capacityAssignmentStatuses.includes(assignment.assignmentStatus as typeof capacityAssignmentStatuses[number]))
  const primary = participants[0]
  await client.order.update({
    where: { id: orderId },
    data: {
      staffId: primary?.staffId ?? null,
      staffAmountCents: sumBy(assignments, (assignment) => assignment.expectedEarningCents),
      assignedAt: primary?.claimedAt ?? null,
    },
  })
  return { assignments, participants }
}

const checkStaffAccepting = async (tx: Prisma.TransactionClient, staffId: string) => {
  await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${staffId} FOR UPDATE`
  const staff = await tx.staffProfile.findUnique({ where: { id: staffId }, include: { user: true, tier: true } })
  ensure(staff && staff.user.isActive && staff.accountStatus === StaffAccountStatus.NORMAL, 409, '该员工账号当前不可接单')
  ensure(staff.accepting === StaffAccepting.ACCEPTING, 409, '管理员已暂停您的接单权限，如需恢复请联系管理员。')
  ensure(staff.selfAccepting === StaffAccepting.ACCEPTING, 409, '员工当前暂时不接单')
  ensure(staff.tier?.canAcceptOrders !== false && staff.tier?.isEnabled !== false, 409, '当前员工档位无权接单')
  return staff
}

const assignStaffToOrderInTransaction = async (
  tx: Prisma.TransactionClient,
  orderId: string,
  staff: { id: string; tier: { level: number } | null },
  requestedSlotIndex?: number,
  allowPreStartReplacement = false,
) => {
  await lockOrderRow(tx, orderId)
  const eligible = await checkStaffAccepting(tx, staff.id)
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { requiredTier: true } })
  ensure(order, 404, '订单不存在')
  ensure(!order.isLocked, 409, '订单已锁定，暂不能接取或分配')
  ensure(!([OrderStatus.PENDING_PAYMENT, OrderStatus.PENDING_COMPLETION_REVIEW, OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.AFTER_SALE] as OrderStatus[]).includes(order.status), 400, '当前状态不能接取或分配')
  if (order.requiredTier) ensure(Boolean(eligible.tier && eligible.tier.level >= order.requiredTier.level), 403, '当前员工层级不满足订单要求')

  let assignments = await getCurrentAssignments(tx, order.id)
  const existing = assignments.find((assignment) => assignment.staffId === staff.id && capacityAssignmentStatuses.includes(assignment.assignmentStatus as typeof capacityAssignmentStatuses[number]))
  if (existing) {
    const current = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
    ensure(current, 404, '订单不存在')
    return { order: current, assignment: existing, idempotent: true }
  }

  let target = requestedSlotIndex
    ? assignments.find((assignment) => assignment.slotIndex === requestedSlotIndex)
    : assignments.find((assignment) => assignment.assignmentStatus === OrderStaffAssignmentStatus.OPEN)
  if (target?.assignmentStatus !== OrderStaffAssignmentStatus.OPEN && target?.staffId) {
    ensure(allowPreStartReplacement && !order.startedAt && ([OrderStatus.PENDING, OrderStatus.PENDING_ASSIGNMENT] as OrderStatus[]).includes(order.status), 409, '该协作名额已被占用')
    await tx.orderStaffAssignment.update({
      where: { id: target.id },
      data: { assignmentStatus: OrderStaffAssignmentStatus.EXITED, exitedAt: new Date(), exitReviewStatus: ExitReviewStatus.APPROVED, exitReviewNote: '管理员在服务开始前重新分配' },
    })
    target = await tx.orderStaffAssignment.create({
      data: {
        orderId: order.id,
        slotIndex: target.slotIndex,
        commissionRateBps: target.commissionRateBps,
        expectedEarningCents: target.expectedEarningCents,
      },
      include: { staff: { select: { id: true, name: true } } },
    })
    assignments = await getCurrentAssignments(tx, order.id)
  }
  ensure(target && target.assignmentStatus === OrderStaffAssignmentStatus.OPEN, 409, '该订单协作人数已满')

  const claimedAt = new Date()
  const assignment = await tx.orderStaffAssignment.update({
    where: { id: target.id },
    data: {
      staffId: staff.id,
      assignmentStatus: order.status === OrderStatus.IN_PROGRESS ? OrderStaffAssignmentStatus.ACTIVE : OrderStaffAssignmentStatus.CLAIMED,
      claimedAt,
      startedAt: order.status === OrderStatus.IN_PROGRESS ? claimedAt : null,
      exitedAt: null,
      completionSubmittedAt: null,
      completionReviewStatus: CompletionReviewStatus.NOT_SUBMITTED,
      completionReviewReason: null,
      exitReviewStatus: ExitReviewStatus.NONE,
      exitRequestedAt: null,
      exitReason: null,
      exitReviewedAt: null,
      exitReviewNote: null,
      exitReviewedById: null,
    },
    include: { staff: { select: { id: true, name: true } } },
  })
  const synced = await syncLegacyAssignmentFields(tx, order.id)
  const teamFull = synced.participants.length >= order.requiredStaffCount
  const nextStatus = order.status === OrderStatus.PENDING_ASSIGNMENT && teamFull ? OrderStatus.PENDING : order.status
  if (nextStatus !== order.status) await tx.order.update({ where: { id: order.id }, data: { status: nextStatus } })
  if (order.status === OrderStatus.IN_PROGRESS) await updateDerivedStaffStatus(tx, staff.id)
  const updated = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
  ensure(updated, 404, '订单不存在')
  return { order: updated, assignment, idempotent: false }
}

const releaseAssignmentSlot = async (
  tx: Prisma.TransactionClient,
  assignment: { id: string; orderId: string; slotIndex: number; commissionRateBps: number; expectedEarningCents: number; staffId: string | null },
  review: { status: ExitReviewStatus; reviewerId?: string; note?: string },
) => {
  const now = new Date()
  await tx.orderStaffAssignment.update({
    where: { id: assignment.id },
    data: {
      assignmentStatus: OrderStaffAssignmentStatus.EXITED,
      exitedAt: now,
      exitReviewStatus: review.status,
      exitReviewedAt: now,
      exitReviewedById: review.reviewerId,
      exitReviewNote: review.note || null,
    },
  })
  await tx.orderStaffAssignment.create({
    data: {
      orderId: assignment.orderId,
      slotIndex: assignment.slotIndex,
      commissionRateBps: assignment.commissionRateBps,
      expectedEarningCents: assignment.expectedEarningCents,
    },
  })
  return syncLegacyAssignmentFields(tx, assignment.orderId)
}

router.post('/auth/login', asyncHandler(async (req, res) => {
  const body = loginSchema.parse(req.body)
  const user = await prisma.user.findUnique({ where: { username: body.username }, include: { staffProfile: true } })
  ensure(user && user.isActive, 401, '账号或密码错误')
  ensure(await verifyPassword(body.password, user.passwordHash), 401, '账号或密码错误')
  ensure(user.role !== UserRole.STAFF || (user.staffProfile?.accountStatus ?? StaffAccountStatus.NORMAL) === StaffAccountStatus.NORMAL, 401, '账号或密码错误')
  const current = await prisma.user.findUnique({ where: { id: user.id }, include: { staffProfile: true, adminRole: true } })
  ensure(current && current.isActive && current.passwordHash === user.passwordHash && current.authVersion === user.authVersion, 401, '账号状态或密码已变化，请重新登录')
  const view = { ...userView(current), permissions: await getUserPermissions(current) }
  const token = createToken({ id: current.id, authVersion: user.authVersion })
  await logOperation(prisma, { operatorId: current.id, action: 'LOGIN', entityType: 'USER', entityId: current.id, detail: { role: current.role } })
  notifyChange([current.staffProfile?.id])
  res.json({ token, user: view })
}))

router.get('/auth/me', authMiddleware, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, include: { staffProfile: true, adminRole: true } })
  ensure(user, 401, '登录已失效')
  res.json({ user: { ...userView(user), permissions: req.user!.permissions } })
}))

router.post('/workbench/change-password', ...staffOnly, accountSecurityLimit, asyncHandler(async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body)
  ensure(parsed.success, 400, parsed.success ? '' : parsed.error.issues[0].code === 'unrecognized_keys' ? '只允许修改本人密码，请检查提交内容' : parsed.error.issues[0].message)
  const body = parsed.data
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
  ensure(user && user.isActive && user.role === UserRole.STAFF, 403, '当前员工账号不可用')
  ensure(await verifyPassword(body.currentPassword, user.passwordHash), 400, '当前密码不正确')
  ensure(!await verifyPassword(body.newPassword, user.passwordHash), 400, '新密码不能与当前密码相同')
  const passwordHash = await hashPassword(body.newPassword)
  await prisma.$transaction(async tx => {
    // A concurrent reset must not be overwritten using a previously valid password.
    const updated = await tx.user.updateMany({ where: { id: user.id, role: UserRole.STAFF, isActive: true, passwordHash: user.passwordHash, authVersion: user.authVersion }, data: { passwordHash, authVersion: { increment: 1 } } })
    ensure(updated.count === 1, 409, '账号状态或密码已变化，请重新登录后再试')
    await logOperation(tx, { operatorId: user.id, action: 'STAFF_CHANGE_PASSWORD', entityType: 'USER', entityId: user.id, detail: { userId: user.id, source: 'workbench', description: '员工自助修改密码' } })
  })
  revokeUserSockets(user.id, user.authVersion + 1)
  res.json({ message: '密码修改成功，请使用新密码重新登录' })
}))

router.post('/workbench/change-username', ...staffOnly, accountSecurityLimit, asyncHandler(async (req, res) => {
  const parsed = changeUsernameSchema.safeParse(req.body)
  ensure(parsed.success, 400, parsed.success ? '' : parsed.error.issues[0].code === 'unrecognized_keys' ? '只允许修改本人登录账号，请检查提交内容' : parsed.error.issues[0].message)
  const body = parsed.data
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
  ensure(user && user.isActive && user.role === UserRole.STAFF, 403, '当前员工账号不可用')
  ensure(await verifyPassword(body.currentPassword, user.passwordHash), 400, '当前密码不正确')
  ensure(body.newUsername !== user.username, 400, '新登录账号不能与当前账号相同')
  try {
    await prisma.$transaction(async tx => {
      const existing = await tx.user.findUnique({ where: { username: body.newUsername }, select: { id: true } })
      ensure(!existing, 409, '登录账号已存在，请使用其他账号')
      const result = await tx.user.updateMany({ where: { id: user.id, username: user.username, passwordHash: user.passwordHash, role: UserRole.STAFF, isActive: true }, data: { username: body.newUsername } })
      ensure(result.count === 1, 409, '账号状态或密码已变化，请重新登录后再试')
      await logOperation(tx, { operatorId: user.id, action: 'STAFF_CHANGE_USERNAME', entityType: 'USER', entityId: user.id, detail: { userId: user.id, oldUsername: user.username, newUsername: body.newUsername, source: 'workbench', description: '员工自助修改登录账号' } })
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new HttpError(409, '登录账号已存在，请使用其他账号')
    throw error
  }
  notifyChange([req.user!.staffProfileId])
  res.json({ message: '登录账号修改成功，请使用新账号重新登录' })
}))

router.get('/dashboard/summary', ...adminRead, asyncHandler(async (_req, res) => {
  const todayStart = startOfDay()
  const todayEnd = endOfDay()
  const sevenDaysAgo = startOfDay(addDays(new Date(), -6))
  const monthStart = startOfMonth()
  const sixMonthsAgo = addMonths(monthStart, -5)
  const [todayOrders, recentOrders, dailyOrders, monthlyOrders, staffCounts] = await Promise.all([
    prisma.order.findMany({ where: { createdAt: { gte: todayStart, lte: todayEnd } }, include: orderInclude }),
    prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 8, include: orderInclude }),
    prisma.order.findMany({ where: { createdAt: { gte: sevenDaysAgo, lte: todayEnd } }, include: orderInclude }),
    prisma.order.findMany({ where: { createdAt: { gte: sixMonthsAgo, lte: todayEnd } }, include: orderInclude }),
    prisma.staffProfile.groupBy({ by: ['status'], _count: { _all: true }, where: { accountStatus: { not: StaffAccountStatus.RETIRED } } }),
  ])
  const dailyStats = Array.from({ length: 7 }, (_, index) => {
    const date = startOfDay(addDays(sevenDaysAgo, index))
    const key = dateKey(date)
    return { date: key, label: String(date.getMonth() + 1) + '/' + String(date.getDate()), ...getStatsForOrders(dailyOrders.filter((item) => dateKey(item.createdAt) === key)) }
  })
  const monthlyStats = Array.from({ length: 6 }, (_, index) => {
    const date = addMonths(startOfMonth(), index - 5)
    const key = monthKey(date)
    return { month: key, label: String(date.getFullYear()) + '年' + String(date.getMonth() + 1) + '月', ...getStatsForOrders(monthlyOrders.filter((item) => monthKey(item.createdAt) === key)) }
  })
  const counts = Object.fromEntries(staffCounts.map((item) => [item.status, item._count._all]))
  res.json({
    slogan: await getDashboardSlogan(),
    today: getStatsForOrders(todayOrders),
    inProgressCount: await prisma.order.count({ where: { status: { in: [OrderStatus.IN_PROGRESS, OrderStatus.PENDING_COMPLETION_REVIEW] } } }),
    idleStaffCount: counts.IDLE ?? 0,
    busyStaffCount: counts.BUSY ?? 0,
    recentOrders: recentOrders.map((item) => orderView(item)),
    dailyStats,
    monthlyStats,
  })
}))

router.get('/staff/options', ...staffRead, asyncHandler(async (_req, res) => {
  const staff = await prisma.staffProfile.findMany({ where: { user: { isActive: true }, accountStatus: { not: StaffAccountStatus.RETIRED } }, include: { tier: true }, orderBy: [{ status: 'asc' }, { name: 'asc' }] })
  const options = await Promise.all(staff.map(async (profile) => ({
    id: profile.id,
    name: profile.name,
    status: profile.status,
    presence: profile.presence,
    accepting: profile.accepting, selfAccepting: profile.selfAccepting,
    accountStatus: profile.accountStatus,
    tier: profile.tier ? { id: profile.tier.id, name: profile.tier.name, level: profile.tier.level, canAcceptOrders: profile.tier.canAcceptOrders } : null,
    currentInProgressCount: await prisma.orderStaffAssignment.count({ where: { staffId: profile.id, assignmentStatus: { in: [OrderStaffAssignmentStatus.ACTIVE, OrderStaffAssignmentStatus.EXIT_REQUESTED] }, order: { status: { in: [OrderStatus.IN_PROGRESS, OrderStatus.PENDING_COMPLETION_REVIEW] } } } }),
  })))
  options.sort((a, b) => Number(a.status === StaffStatus.BUSY) - Number(b.status === StaffStatus.BUSY) || a.currentInProgressCount - b.currentInProgressCount || a.name.localeCompare(b.name, 'zh-CN'))
  res.json({ items: options })
}))

router.get('/staff', ...staffRead, asyncHandler(async (_req, res) => {
  const staff = await prisma.staffProfile.findMany({
    include: {
      user: { select: { id: true, username: true, isActive: true } },
      tier: true,
      orderAssignments: { where: { staffId: { not: null } }, select: { orderId: true, assignmentStatus: true, actualEarningCents: true, earningAdjustments: { select: { earningDeltaCents: true } }, order: { select: { status: true } } } },
      incidents: { orderBy: { createdAt: 'desc' }, select: { id: true, type: true, note: true, createdAt: true } },
      settlements: { select: { amountCents: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  res.json({
    items: staff.map((profile) => {
      const assignedOrderIds = new Set(profile.orderAssignments.map((item) => item.orderId))
      const completedOrderIds = new Set(profile.orderAssignments.filter((item) => item.assignmentStatus === OrderStaffAssignmentStatus.COMPLETED).map((item) => item.orderId))
      const inProgressOrderIds = new Set(profile.orderAssignments.filter((item) => ([OrderStaffAssignmentStatus.ACTIVE, OrderStaffAssignmentStatus.EXIT_REQUESTED] as OrderStaffAssignmentStatus[]).includes(item.assignmentStatus) && ([OrderStatus.IN_PROGRESS, OrderStatus.PENDING_COMPLETION_REVIEW] as OrderStatus[]).includes(item.order.status)).map((item) => item.orderId))
      const actual = sumBy(profile.orderAssignments.filter((item) => item.assignmentStatus === OrderStaffAssignmentStatus.COMPLETED), currentActualEarning)
      const settled = sumBy(profile.settlements, (item) => item.amountCents)
      const incidentCounts = { BAD_REVIEW: 0, ROLLOVER: 0, COMPLAINT: 0 }
      for (const incident of profile.incidents) {
        if (incident.type === 'BAD_REVIEW') incidentCounts.BAD_REVIEW += 1
        if (incident.type === 'ROLLOVER') incidentCounts.ROLLOVER += 1
        if (incident.type === 'COMPLAINT') incidentCounts.COMPLAINT += 1
      }
      return {
        id: profile.id,
        userId: profile.userId,
        username: profile.user.username,
        name: profile.name,
        phone: profile.phone,
        contact: profile.contact,
        status: profile.status,
        accountStatus: profile.accountStatus,
        presence: profile.presence,
        accepting: profile.accepting, selfAccepting: profile.selfAccepting,
        isActive: profile.user.isActive,
        commissionRateBps: profile.commissionRateBps,
        realName: profile.realName,
        idNumberMasked: profile.idNumberMasked,
        identityStatus: profile.identityStatus,
        identityReviewNote: profile.identityReviewNote,
        note: profile.note,
        tier: profile.tier ? { id: profile.tier.id, name: profile.tier.name, level: profile.tier.level, priceMultiplierBps: profile.tier.priceMultiplierBps, canAcceptOrders: profile.tier.canAcceptOrders, isEnabled: profile.tier.isEnabled } : null,
        inProgressCount: inProgressOrderIds.size,
        completedCount: completedOrderIds.size,
        assignedOrderCount: assignedOrderIds.size,
        completionRate: assignedOrderIds.size ? completedOrderIds.size / assignedOrderIds.size : 0,
        totalEarningsCents: actual,
        settledCents: settled,
        pendingSettlementCents: Math.max(actual - settled, 0),
        overSettledCents: Math.max(settled - actual, 0),
        incidentCounts,
        incidents: profile.incidents,
      }
    }),
  })
}))

router.get('/staff/workload', ...staffRead, asyncHandler(async (req, res) => {
  const range = parseDateRange(req.query.startDate, req.query.endDate)
  ensure(range, 400, '请选择统计开始和结束日期')
  const staff = await prisma.staffProfile.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      tier: true,
      orderAssignments: {
        where: { staffId: { not: null } },
        select: { orderId: true, assignmentStatus: true, claimedAt: true, completedAt: true, exitedAt: true, actualEarningCents: true, earningAdjustments: { select: { earningDeltaCents: true } }, order: { select: { status: true } } },
      },
    },
  })
  res.json({
    range,
    items: staff.map((profile) => {
      const claimed = profile.orderAssignments.filter((item) => item.claimedAt && item.claimedAt >= range.start && item.claimedAt <= range.end)
      const completed = profile.orderAssignments.filter((item) => item.completedAt && item.completedAt >= range.start && item.completedAt <= range.end)
      const exited = profile.orderAssignments.filter((item) => item.exitedAt && item.exitedAt >= range.start && item.exitedAt <= range.end)
      const inProgress = profile.orderAssignments.filter((item) => capacityAssignmentStatuses.includes(item.assignmentStatus as typeof capacityAssignmentStatuses[number]) && ([OrderStatus.IN_PROGRESS, OrderStatus.PENDING_COMPLETION_REVIEW] as OrderStatus[]).includes(item.order.status))
      return {
        staffId: profile.id,
        name: profile.name,
        tier: profile.tier,
        claimedCount: claimed.length,
        completedCount: completed.length,
        inProgressCount: inProgress.length,
        exitedCount: exited.length,
        actualEarningCents: currentStaffEarningTotal(completed),
      }
    }),
  })
}))

router.post('/staff', ...staffManage, asyncHandler(async (req, res) => {
  const body = staffCreateSchema.parse(req.body)
  const tier = body.tierId ? await findTier(body.tierId) : await prisma.staffTier.findFirst({ where: { isEnabled: true }, orderBy: [{ level: 'asc' }, { sort: 'asc' }] })
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username: body.username,
        passwordHash: await hashPassword(body.password),
        role: UserRole.STAFF,
        staffProfile: { create: { name: body.name, phone: body.phone || null, contact: body.contact || null, realName: body.realName || null, idNumberMasked: maskIdNumber(body.idNumber), tierId: tier?.id, commissionRateBps: body.commissionRateBps ?? config.defaultCommissionRateBps } },
      },
      include: { staffProfile: true },
    })
    await logOperation(tx, { operatorId: req.user!.id, action: 'CREATE', entityType: 'STAFF', entityId: created.staffProfile!.id, detail: { username: created.username, tierId: tier?.id } })
    return created
  })
  notifyChange([user.staffProfile?.id])
  res.status(201).json({ item: userView(user) })
}))

router.patch('/staff/me/status', ...staffOnly, asyncHandler(async (req, res) => {
  ensure(req.user!.staffProfileId, 403, '员工档案不存在')
  const status = z.nativeEnum(StaffStatus).parse(req.body.status)
  const profile = await prisma.staffProfile.update({ where: { id: req.user!.staffProfileId }, data: { status } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE_STATUS', entityType: 'STAFF', entityId: profile.id, detail: { status } })
  notifyChange([profile.id])
  res.json({ item: profile })
}))
router.patch('/staff/me/presence', ...staffOnly, asyncHandler(async (req, res) => {
  ensure(req.user!.staffProfileId, 403, '员工档案不存在')
  // Legacy clients may call this while signing out. The connection lifecycle owns presence.
  res.json({ item: { id: req.user!.staffProfileId, presence: currentStaffPresence(req.user!.id) } })
}))
router.patch('/staff/me/accepting', ...staffOnly, asyncHandler(async (req, res) => {
  ensure(req.user!.staffProfileId, 403, '员工档案不存在')
  // Keep the existing request key for old clients, but it now controls only personal willingness.
  const { accepting } = z.object({ accepting: z.nativeEnum(StaffAccepting) }).strict().parse(req.body)
  const profile = await prisma.$transaction(async tx => {
    const result = await tx.staffProfile.updateMany({ where: { id: req.user!.staffProfileId, userId: req.user!.id, accepting: StaffAccepting.ACCEPTING }, data: { selfAccepting: accepting } })
    ensure(result.count === 1, 403, '管理员已暂停您的接单权限，如需恢复请联系管理员。')
    await logOperation(tx, { operatorId: req.user!.id, action: 'UPDATE_ACCEPTING', entityType: 'STAFF', entityId: req.user!.staffProfileId, detail: { selfAccepting: accepting, source: 'workbench' } })
    return tx.staffProfile.findUniqueOrThrow({ where: { id: req.user!.staffProfileId } })
  })
  notifyChange([profile.id])
  res.json({ item: profile })
}))

router.patch('/staff/:id', ...staffManage, asyncHandler(async (req, res) => {
  const body = staffUpdateSchema.parse(req.body)
  const profile = await prisma.staffProfile.findUnique({ where: { id: getParam(req) }, include: { user: true } })
  ensure(profile, 404, '员工不存在')
  const updated = await prisma.$transaction(async (tx) => {
    if (body.isActive !== undefined) await tx.user.update({ where: { id: profile.userId }, data: { isActive: body.isActive } })
    const result = await tx.staffProfile.update({
      where: { id: profile.id },
      data: {
        name: body.name,
        phone: body.phone === undefined ? undefined : body.phone || null,
        contact: body.contact === undefined ? undefined : body.contact || null,
        realName: body.realName === undefined ? undefined : body.realName || null,
        idNumberMasked: body.idNumber === undefined ? undefined : maskIdNumber(body.idNumber),
        identityReviewNote: body.identityReviewNote === undefined ? undefined : body.identityReviewNote || null,
        tierId: body.tierId === undefined ? undefined : body.tierId,
        commissionRateBps: body.commissionRateBps,
        accountStatus: body.accountStatus,
        accepting: body.accepting,
        note: body.note === undefined ? undefined : body.note || null,
      },
      include: { user: { select: { id: true, username: true, isActive: true } }, tier: true },
    })
    await logOperation(tx, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'STAFF', entityId: profile.id, detail: { ...body, idNumber: body.idNumber ? '[已脱敏]' : undefined } })
    return result
  })
  notifyChange([profile.id])
  res.json({ item: { ...updated, idNumberEncrypted: undefined } })
}))
router.patch('/staff/:id/status', ...staffManage, asyncHandler(async (req, res) => {
  const status = z.nativeEnum(StaffStatus).parse(req.body.status)
  const profile = await prisma.staffProfile.update({ where: { id: getParam(req) }, data: { status } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE_STATUS', entityType: 'STAFF', entityId: profile.id, detail: { status } })
  notifyChange([profile.id])
  res.json({ item: profile })
}))
router.patch('/staff/:id/identity-review', ...staffManage, asyncHandler(async (req, res) => {
  const body = z.object({ status: z.nativeEnum(IdentityReviewStatus), note: z.string().max(2000).optional().or(z.literal('')) }).parse(req.body)
  const profile = await prisma.staffProfile.update({ where: { id: getParam(req) }, data: { identityStatus: body.status, identityReviewNote: body.note || null, identityReviewedAt: new Date(), identityReviewedById: req.user!.id } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'IDENTITY_REVIEW', entityType: 'STAFF', entityId: profile.id, detail: body })
  notifyChange([profile.id])
  res.json({ item: profile })
}))
router.post('/staff/:id/reset-password', ...staffManage, asyncHandler(async (req, res) => {
  const password = passwordSchema.parse(req.body.password)
  const profile = await prisma.staffProfile.findUnique({ where: { id: getParam(req) } })
  ensure(profile, 404, '员工不存在')
  const passwordHash = await hashPassword(password)
  const updated = await prisma.$transaction(async tx => {
    const user = await tx.user.update({ where: { id: profile.userId }, data: { passwordHash, authVersion: { increment: 1 } }, select: { id: true, authVersion: true } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'RESET_PASSWORD', entityType: 'STAFF', entityId: profile.id })
    return user
  })
  revokeUserSockets(updated.id, updated.authVersion)
  res.json({ message: '密码已重置' })
}))
router.get('/staff-tiers', ...staffRead, asyncHandler(async (_req, res) => {
  const items = await prisma.staffTier.findMany({ where: { archivedAt: null }, orderBy: [{ isEnabled: 'desc' }, { level: 'asc' }, { sort: 'asc' }] })
  res.json({ items })
}))
router.post('/staff-tiers', ...staffManage, asyncHandler(async (req, res) => {
  const body = tierSchema.parse(req.body)
  const item = await prisma.staffTier.create({ data: { name: body.name, description: body.description || null, level: body.level ?? 1, priceMultiplierBps: body.priceMultiplierBps ?? 10000, canAcceptOrders: body.canAcceptOrders ?? true, isEnabled: body.isEnabled ?? true, sort: body.sort ?? 0, remark: body.remark || null, createdById: req.user!.id } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'STAFF_TIER', entityId: item.id, detail: body })
  notifyChange()
  res.status(201).json({ item })
}))
router.patch('/staff-tiers/:id', ...staffManage, asyncHandler(async (req, res) => {
  const body = tierSchema.partial().parse(req.body)
  const current = await prisma.staffTier.findUnique({ where: { id: getParam(req) } })
  ensure(current && !current.archivedAt, 404, '员工层级不存在或已移除')
  const item = await prisma.staffTier.update({ where: { id: current.id }, data: { name: body.name, description: body.description === undefined ? undefined : body.description || null, level: body.level, priceMultiplierBps: body.priceMultiplierBps, canAcceptOrders: body.canAcceptOrders, isEnabled: body.isEnabled, sort: body.sort, remark: body.remark === undefined ? undefined : body.remark || null } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'STAFF_TIER', entityId: item.id, detail: body })
  notifyChange()
  res.json({ item })
}))
router.delete('/staff-tiers/:id', ...staffManage, asyncHandler(async (req, res) => {
  const id = getParam(req)
  const tier = await prisma.staffTier.findUnique({ where: { id } })
  ensure(tier && !tier.archivedAt, 404, '员工层级不存在或已移除')
  const [staffCount, unfinishedOrderCount, historicalOrderCount] = await Promise.all([
    prisma.staffProfile.count({ where: { tierId: id } }),
    prisma.order.count({ where: { requiredTierId: id, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.AFTER_SALE, OrderStatus.CANCELLED] } } }),
    prisma.order.count({ where: { requiredTierId: id } }),
  ])
  ensure(staffCount === 0, 409, `当前仍有 ${staffCount} 名员工使用该服务层级，请先调整员工层级后再删除。`)
  ensure(unfinishedOrderCount === 0, 409, `当前仍有 ${unfinishedOrderCount} 个未完成订单引用该服务层级，请先调整相关订单后再删除。`)
  if (historicalOrderCount > 0) {
    const archived = await prisma.staffTier.update({ where: { id }, data: { archivedAt: new Date(), isEnabled: false, canAcceptOrders: false } })
    await logOperation(prisma, { operatorId: req.user!.id, action: 'ARCHIVE', entityType: 'STAFF_TIER', entityId: id, detail: { name: tier.name, historicalOrderCount } })
    notifyChange()
    res.json({ item: archived, archived: true, message: '该层级存在历史订单，已安全移除并保留历史名称。' })
    return
  }
  await prisma.staffTier.delete({ where: { id } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'DELETE', entityType: 'STAFF_TIER', entityId: id, detail: { name: tier.name } })
  notifyChange()
  res.json({ deleted: true, archived: false, message: '员工层级已删除。' })
}))
router.get('/staff/:id/incidents', ...staffRead, asyncHandler(async (req, res) => {
  const items = await prisma.staffIncident.findMany({ where: { staffId: getParam(req) }, orderBy: { createdAt: 'desc' }, include: { operator: { select: { username: true } } } })
  res.json({ items })
}))
router.post('/staff/:id/incidents', ...staffManage, asyncHandler(async (req, res) => {
  const body = z.object({ type: z.nativeEnum(StaffIncidentType), note: z.string().trim().min(1).max(2000) }).parse(req.body)
  await getStaff(getParam(req), false)
  const item = await prisma.staffIncident.create({ data: { staffId: getParam(req), operatorId: req.user!.id, type: body.type, note: body.note } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'STAFF_INCIDENT', entityId: item.id, detail: body })
  notifyChange([getParam(req)])
  res.status(201).json({ item })
}))
router.get('/staff/:id/settlements', ...financeRead, asyncHandler(async (req, res) => {
  const items = await prisma.settlementRecord.findMany({ where: { staffId: getParam(req) }, orderBy: { settledAt: 'desc' }, include: { operator: { select: { username: true } } } })
  res.json({ items })
}))
router.post('/staff/:id/settlements', ...settlementManage, asyncHandler(async (req, res) => {
  const body = settlementSchema.parse(req.body)
  const amountCents = parseYuanToCents(body.amount, '结算金额')
  ensure(amountCents > 0, 400, '结算金额必须大于 0')
  const settlementDate = new Date(body.settlementDate)
  ensure(!Number.isNaN(settlementDate.getTime()), 400, '结算日期格式不正确')
  const staff = await getStaff(getParam(req), false)
  const result = await prisma.$transaction(async (tx) => {
    await lockStaffRow(tx, staff.id)
    const existing = await tx.settlementRecord.findUnique({ where: { requestId: body.requestId } })
    if (existing) {
      ensure(existing.staffId === staff.id && existing.amountCents === amountCents, 409, '该结算请求已用于其他记录')
      return { item: existing, idempotent: true }
    }
    const earnings = await currentStaffEarnings(tx, staff.id)
    ensure(amountCents <= earnings.pendingSettlementCents, 409, '结算金额不能超过员工待结算金额')
    const item = await tx.settlementRecord.create({ data: { requestId: body.requestId, staffId: staff.id, operatorId: req.user!.id, amountCents, settlementMethod: body.settlementMethod, settledAt: settlementDate, note: body.note || null } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'SETTLE', entityType: 'STAFF', entityId: staff.id, detail: { settlementId: item.id, requestId: body.requestId, amountCents, settledAt: settlementDate } })
    return { item, idempotent: false }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  notifyChange([staff.id])
  res.status(result.idempotent ? 200 : 201).json(result)
}))

router.get('/customers', ...customerRead, asyncHandler(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
  const [customers, fundingPolicy] = await Promise.all([
    prisma.customer.findMany({
    where: search ? { OR: [{ customerCode: { contains: search } }, { teamCode: { contains: search } }] } : undefined,
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { orders: true, rechargeRecords: true, consumptionRecords: true, orderConsumptions: true } },
      rechargeRecords: { select: { amountCents: true, principalAmountCents: true, bonusAmountCents: true } },
      consumptionRecords: { select: { orderId: true, amountCents: true } },
      orderConsumptions: { select: { orderId: true, totalAmountCents: true } },
    },
    }),
    getGlobalFundingPolicy(),
  ])
  res.json({ items: customers.map(({ rechargeRecords, consumptionRecords, orderConsumptions, ...customer }) => {
    const newOrderIds = new Set(orderConsumptions.map((item) => item.orderId))
    return {
      ...customer,
      fundingPolicy,
      totalRechargeCents: sumBy(rechargeRecords, (item) => item.principalAmountCents),
      totalPrincipalRechargeCents: sumBy(rechargeRecords, (item) => item.principalAmountCents),
      totalBonusCents: sumBy(rechargeRecords, (item) => item.bonusAmountCents),
      totalConsumptionCents: sumBy(orderConsumptions, (item) => item.totalAmountCents) + sumBy(consumptionRecords.filter((item) => !newOrderIds.has(item.orderId)), (item) => item.amountCents),
      consumptionCount: orderConsumptions.length + consumptionRecords.filter((item) => !newOrderIds.has(item.orderId)).length,
    }
  }) })
}))
router.post('/customers', ...customerManage, asyncHandler(async (req, res) => {
  const body = customerSchema.parse(req.body)
  const customer = await prisma.customer.create({ data: { customerCode: body.customerCode, teamCode: body.teamCode, name: body.customerCode, phone: null, tags: body.tags || null, note: body.note || null, isBlacklisted: body.isBlacklisted ?? false, principalBalanceCents: 0, bonusBalanceCents: 0, balanceCents: 0 } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'CUSTOMER', entityId: customer.id, detail: { customerCode: customer.customerCode, teamCode: customer.teamCode } })
  notifyChange()
  res.status(201).json({ item: customer })
}))
router.patch('/customers/:id', ...customerManage, asyncHandler(async (req, res) => {
  const body = customerSchema.partial().parse(req.body)
  const customer = await prisma.customer.update({ where: { id: getParam(req) }, data: { customerCode: body.customerCode, teamCode: body.teamCode, name: body.customerCode, tags: body.tags === undefined ? undefined : body.tags || null, note: body.note === undefined ? undefined : body.note || null, isBlacklisted: body.isBlacklisted } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'CUSTOMER', entityId: customer.id, detail: body })
  notifyChange()
  res.json({ item: customer })
}))
router.patch('/customers/:id/funding-policy', ...customerManage, asyncHandler(async (_req, _res) => {
  throw new HttpError(409, '扣款策略为全局配置，请前往业务配置修改')
}))
router.get('/settings/funding-policy', ...fundingPolicyManage, asyncHandler(async (_req, res) => {
  const policy = await getGlobalFundingPolicy()
  res.json({ item: { key: FUNDING_POLICY_SETTING_KEY, policy, label: policy === FundingPolicy.BONUS_FIRST ? '赠金优先' : '本金优先' } })
}))
router.patch('/settings/funding-policy', ...fundingPolicyManage, asyncHandler(async (req, res) => {
  const policy = z.nativeEnum(FundingPolicy).parse(req.body.policy)
  const setting = await prisma.systemSetting.upsert({
    where: { key: FUNDING_POLICY_SETTING_KEY },
    update: { value: policy, updatedById: req.user!.id },
    create: { id: 'phase2-setting-funding-policy', key: FUNDING_POLICY_SETTING_KEY, value: policy, updatedById: req.user!.id },
  })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE_FUNDING_POLICY', entityType: 'SYSTEM_SETTING', entityId: setting.key, detail: { policy } })
  notifyChange()
  res.json({ item: { key: setting.key, policy, label: policy === FundingPolicy.BONUS_FIRST ? '赠金优先' : '本金优先' } })
}))
router.get('/settings/admin-dashboard', ...noticeManage, asyncHandler(async (_req, res) => {
  res.json({ item: { slogan: await getDashboardSlogan() }, defaults: { slogan: DEFAULT_DASHBOARD_SLOGAN } })
}))
router.patch('/settings/admin-dashboard', ...noticeManage, asyncHandler(async (req, res) => {
  const body = z.object({ slogan: z.string().trim().min(1).max(240).refine((value) => !/[<>]/.test(value), '标语只允许纯文本') }).strict().parse(req.body)
  const slogan = await saveDashboardSlogan(body.slogan, req.user!.id)
  notifyChange()
  res.json({ item: { slogan } })
}))
router.post('/settings/admin-dashboard/reset', ...noticeManage, asyncHandler(async (req, res) => {
  const slogan = await saveDashboardSlogan(null, req.user!.id)
  notifyChange()
  res.json({ item: { slogan } })
}))
router.get('/settings/workbench-welcome', ...noticeManage, asyncHandler(async (_req, res) => {
  res.json({ item: await getWorkbenchWelcome(), defaults: DEFAULT_WORKBENCH_WELCOME })
}))
router.patch('/settings/workbench-welcome', ...noticeManage, asyncHandler(async (req, res) => {
  const body = workbenchWelcomeSchema.parse(req.body)
  await prisma.$transaction(async (tx) => {
    await tx.systemSetting.upsert({ where: { key: WORKBENCH_WELCOME_TITLE_KEY }, update: { value: body.titleTemplate, updatedById: req.user!.id }, create: { key: WORKBENCH_WELCOME_TITLE_KEY, value: body.titleTemplate, updatedById: req.user!.id } })
    await tx.systemSetting.upsert({ where: { key: WORKBENCH_WELCOME_SUBTITLE_KEY }, update: { value: body.subtitle, updatedById: req.user!.id }, create: { key: WORKBENCH_WELCOME_SUBTITLE_KEY, value: body.subtitle, updatedById: req.user!.id } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'UPDATE_WORKBENCH_WELCOME', entityType: 'SYSTEM_SETTING', entityId: WORKBENCH_WELCOME_TITLE_KEY, detail: body })
  })
  notifyChange()
  res.json({ item: body, defaults: DEFAULT_WORKBENCH_WELCOME })
}))
router.post('/settings/workbench-welcome/reset', ...noticeManage, asyncHandler(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    await tx.systemSetting.deleteMany({ where: { key: { in: [WORKBENCH_WELCOME_TITLE_KEY, WORKBENCH_WELCOME_SUBTITLE_KEY] } } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'RESET_WORKBENCH_WELCOME', entityType: 'SYSTEM_SETTING', entityId: WORKBENCH_WELCOME_TITLE_KEY })
  })
  notifyChange()
  res.json({ item: DEFAULT_WORKBENCH_WELCOME, defaults: DEFAULT_WORKBENCH_WELCOME })
}))
router.patch('/customers/:id/blacklist', ...customerManage, asyncHandler(async (req, res) => {
  const body = z.object({ isBlacklisted: z.boolean(), note: z.string().max(2000).optional().or(z.literal('')) }).parse(req.body)
  const customer = await prisma.customer.update({ where: { id: getParam(req) }, data: { isBlacklisted: body.isBlacklisted, note: body.note || undefined } })
  await logOperation(prisma, { operatorId: req.user!.id, action: body.isBlacklisted ? 'BLACKLIST' : 'UNBLACKLIST', entityType: 'CUSTOMER', entityId: customer.id, detail: body })
  notifyChange()
  res.json({ item: customer })
}))
router.get('/customers/:id', ...customerRead, asyncHandler(async (req, res) => {
  await expireCustomerCoupons(getParam(req))
  const [customer, fundingPolicy] = await Promise.all([
    prisma.customer.findUnique({
    where: { id: getParam(req) },
    include: {
      rechargeRecords: { orderBy: { createdAt: 'desc' }, include: { operator: { select: { username: true } } } },
      consumptionRecords: { orderBy: { createdAt: 'desc' }, include: { order: { select: { orderNo: true, orderConsumption: true } }, operator: { select: { username: true } } } },
      orderConsumptions: { orderBy: { createdAt: 'desc' }, include: { order: { select: { orderNo: true } }, operator: { select: { username: true } } } },
      fundTransactions: { orderBy: { createdAt: 'desc' }, take: 100, include: { order: { select: { orderNo: true } }, operator: { select: { username: true } } } },
      customerCoupons: { orderBy: { issuedAt: 'desc' }, include: { coupon: true } },
      orders: { orderBy: { createdAt: 'desc' }, take: 50, include: { staff: { select: { name: true } } } },
      _count: { select: { orders: true, rechargeRecords: true, consumptionRecords: true, orderConsumptions: true } },
    },
    }),
    getGlobalFundingPolicy(),
  ])
  ensure(customer, 404, '客户不存在')
  const newOrderIds = new Set(customer.orderConsumptions.map((item) => item.orderId))
  const totalConsumptionCents = sumBy(customer.orderConsumptions, (item) => item.totalAmountCents) + sumBy(customer.consumptionRecords.filter((item) => !newOrderIds.has(item.orderId)), (item) => item.amountCents)
  const consumptionRecords = [
    ...customer.consumptionRecords.filter((item) => !newOrderIds.has(item.orderId)),
    ...customer.orderConsumptions.map((item) => ({ id: item.id, customerId: item.customerId, orderId: item.orderId, operatorId: item.operatorId, amountCents: item.totalAmountCents, balanceBeforeCents: item.principalBeforeCents + item.bonusBeforeCents, balanceAfterCents: item.principalAfterCents + item.bonusAfterCents, note: '订单完成消费', createdAt: item.createdAt, order: { orderNo: item.order.orderNo }, operator: item.operator })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  res.json({ item: { ...customer, fundingPolicy, totalRechargeCents: sumBy(customer.rechargeRecords, (item) => item.principalAmountCents), totalPrincipalRechargeCents: sumBy(customer.rechargeRecords, (item) => item.principalAmountCents), totalBonusCents: sumBy(customer.rechargeRecords, (item) => item.bonusAmountCents), totalConsumptionCents, consumptionCount: consumptionRecords.length } })
}))
router.get('/customers/:id/funds', ...customerRead, asyncHandler(async (req, res) => {
  const items = await prisma.fundTransaction.findMany({ where: { customerId: getParam(req) }, orderBy: { createdAt: 'desc' }, take: 200, include: { order: { select: { orderNo: true } }, operator: { select: { username: true } } } })
  res.json({ items })
}))
router.get('/customers/:id/coupons', ...customerRead, asyncHandler(async (req, res) => {
  await getCustomer(getParam(req))
  await expireCustomerCoupons(getParam(req))
  const items = await prisma.customerCoupon.findMany({ where: { customerId: getParam(req) }, orderBy: { issuedAt: 'desc' }, include: { coupon: true } })
  res.json({ items })
}))
router.post('/customers/:id/recharges', ...customerRecharge, asyncHandler(async (req, res) => {
  const amountCents = parseYuanToCents(req.body.amount, '充值金额')
  ensure(amountCents > 0, 400, '充值金额必须大于 0')
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : undefined
  const explicitBonus = req.body.bonusAmount !== undefined && req.body.bonusAmount !== ''
  const bonusCents = explicitBonus ? parseYuanToCents(req.body.bonusAmount, '奖励金额') : (await getAvailableActivityBonus(amountCents)).bonusCents
  const result = await prisma.$transaction((tx) => createRechargeInTransaction(tx, getParam(req), req.user!.id, amountCents, bonusCents, note))
  notifyChange()
  res.status(201).json({ item: result.customer, recharge: result.record, bonusCents: result.bonusCents })
}))
router.post('/customers/:id/fund-adjustment', ...fundAdjust, asyncHandler(async (req, res) => {
  const body = fundAdjustmentSchema.parse(req.body)
  const principalAmountCents = body.principalAmount === undefined || body.principalAmount === '' ? 0 : parseSignedYuanToCents(body.principalAmount, '本金调整金额')
  const bonusAmountCents = body.bonusAmount === undefined || body.bonusAmount === '' ? 0 : parseSignedYuanToCents(body.bonusAmount, '赠金调整金额')
  ensure(principalAmountCents !== 0 || bonusAmountCents !== 0, 400, '至少填写一项非零调整金额')
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.customer.findUnique({ where: { id: getParam(req) } })
    ensure(current, 404, '客户不存在')
    const principalAfterCents = current.principalBalanceCents + principalAmountCents
    const bonusAfterCents = current.bonusBalanceCents + bonusAmountCents
    ensure(principalAfterCents >= 0 && bonusAfterCents >= 0, 409, '调整后账户余额不能为负数')
    const updated = await tx.customer.updateMany({
      where: { id: current.id, principalBalanceCents: { gte: Math.max(-principalAmountCents, 0) }, bonusBalanceCents: { gte: Math.max(-bonusAmountCents, 0) } },
      data: { principalBalanceCents: { increment: principalAmountCents }, bonusBalanceCents: { increment: bonusAmountCents }, balanceCents: { increment: principalAmountCents + bonusAmountCents } },
    })
    ensure(updated.count === 1, 409, '客户账户发生变化，请刷新后重试')
    const item = await tx.fundTransaction.create({ data: { customerId: current.id, operatorId: req.user!.id, type: FundTransactionType.ADJUSTMENT, amountCents: principalAmountCents + bonusAmountCents, principalBeforeCents: current.principalBalanceCents, principalAfterCents, bonusBeforeCents: current.bonusBalanceCents, bonusAfterCents, balanceBeforeCents: current.balanceCents, balanceAfterCents: current.balanceCents + principalAmountCents + bonusAmountCents, note: body.note } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'ADJUST_BALANCE', entityType: 'CUSTOMER', entityId: current.id, detail: { fundTransactionId: item.id, principalAmountCents, bonusAmountCents, balanceBeforeCents: current.balanceCents, balanceAfterCents: current.balanceCents + principalAmountCents + bonusAmountCents } })
    return { customer: await tx.customer.findUnique({ where: { id: current.id } }), item }
  })
  notifyChange()
  res.status(201).json(result)
}))

router.get('/orders', ...authenticated, asyncHandler(async (req, res) => {
  const staffId = req.user!.role === UserRole.STAFF ? req.user!.staffProfileId : undefined
  if (!staffId) ensure(isAdminRole(req.user!.role) && hasPermission(req.user!, 'orders.view'), 403, '当前账号没有查看订单的权限')
  const where: Prisma.OrderWhereInput = {}
  if (staffId) where.assignments = { some: { staffId, assignmentStatus: { in: [...participatingAssignmentStatuses] } } }
  if (typeof req.query.status === 'string' && Object.values(OrderStatus).includes(req.query.status as OrderStatus)) where.status = req.query.status as OrderStatus
  if (typeof req.query.staffId === 'string' && !staffId) where.assignments = { some: { staffId: req.query.staffId, assignmentStatus: { in: [...participatingAssignmentStatuses] } } }
  if (typeof req.query.from === 'string' || typeof req.query.to === 'string') where.createdAt = { gte: parseQueryDate(req.query.from, new Date(0)), lte: parseQueryDate(req.query.to, new Date()) }
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
  if (search) {
    where.OR = staffId
      ? [{ orderNo: { contains: search } }, { serviceItem: { contains: search } }]
      : [{ orderNo: { contains: search } }, { serviceItem: { contains: search } }, { customer: { customerCode: { contains: search } } }, { customer: { teamCode: { contains: search } } }]
  }
  const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: orderInclude })
  res.json({ items: orders.map((item) => orderView(item, Boolean(staffId), staffId)) })
}))

router.get('/orders/export', ...orderRead, asyncHandler(async (req, res) => {
  const where: Prisma.OrderWhereInput = {}
  if (typeof req.query.status === 'string' && Object.values(OrderStatus).includes(req.query.status as OrderStatus)) where.status = req.query.status as OrderStatus
  if (typeof req.query.staffId === 'string') where.assignments = { some: { staffId: req.query.staffId, assignmentStatus: { in: [...participatingAssignmentStatuses] } } }
  if (typeof req.query.from === 'string' || typeof req.query.to === 'string') where.createdAt = { gte: parseQueryDate(req.query.from, new Date(0)), lte: parseQueryDate(req.query.to, new Date()) }
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
  if (search) where.OR = [{ orderNo: { contains: search } }, { serviceItem: { contains: search } }, { customer: { customerCode: { contains: search } } }, { customer: { teamCode: { contains: search } } }]
  const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000, include: orderInclude })
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('订单列表')
  sheet.columns = [
    { header: '订单号', key: 'orderNo', width: 24 },
    { header: '客户ID', key: 'customer', width: 20 },
    { header: '客户组队码', key: 'teamCode', width: 20 },
    { header: '服务套餐', key: 'serviceItem', width: 24 },
    { header: '订单金额（元）', key: 'amount', width: 16 },
    { header: '员工金额（元）', key: 'staffAmount', width: 16 },
    { header: '参与员工', key: 'staff', width: 24 },
    { header: '协作进度', key: 'progress', width: 14 },
    { header: '状态', key: 'status', width: 18 },
    { header: '创建时间', key: 'createdAt', width: 22 },
    { header: '备注', key: 'note', width: 36 },
  ]
  for (const order of orders) {
    const slots = latestSlotAssignments(order.assignments)
    const participants = slots.filter((assignment) => assignment.staff && participatingAssignmentStatuses.includes(assignment.assignmentStatus as typeof participatingAssignmentStatuses[number]))
    sheet.addRow({
      orderNo: order.orderNo,
      customer: order.customer.customerCode,
      teamCode: order.customer.teamCode,
      serviceItem: order.serviceItem,
      amount: ((order.amountCents + sumBy(order.adjustments, (item) => item.orderAmountDeltaCents)) / 100).toFixed(2),
      staffAmount: (currentStaffEarningTotal(order.assignments) / 100).toFixed(2),
      staff: participants.map((assignment) => assignment.staff?.name).filter(Boolean).join('、') || '待接单',
      progress: `${participants.length}/${order.requiredStaffCount}`,
      status: orderStatusLabel(order.status),
      createdAt: order.createdAt.toLocaleString('zh-CN'),
      note: order.note || '',
    })
  }
  sheet.getRow(1).font = { bold: true }
  const buffer = await workbook.xlsx.writeBuffer()
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''club-orders-${dateKey(new Date())}.xlsx`)
  res.send(Buffer.from(buffer as unknown as Uint8Array))
}))

router.get('/orders/:id', ...authenticated, asyncHandler(async (req, res) => {
  if (isAdminRole(req.user!.role)) ensure(hasPermission(req.user!, 'orders.view'), 403, '当前账号没有查看订单的权限')
  const order = await getOrderForUser(getParam(req), req)
  res.json({ item: orderView(order, req.user!.role === UserRole.STAFF, req.user!.staffProfileId, false, true) })
}))

router.get('/orders/:id/logs', ...orderRead, asyncHandler(async (req, res) => {
  const items = await prisma.operationLog.findMany({ where: { entityType: 'ORDER', entityId: getParam(req) }, orderBy: { createdAt: 'desc' }, include: { operator: { select: { username: true } } } })
  res.json({ items })
}))

router.post('/orders', ...orderCreate, asyncHandler(async (req, res) => {
  const body = orderCreateSchema.parse(req.body)
  ensure(!body.newCustomer || hasPermission(req.user!, 'customers.manage'), 403, '没有新建客户权限，请搜索已有客户')
  ensure(!body.rechargeAmountCents || hasPermission(req.user!, 'customers.recharge'), 403, '没有客户充值权限')
  ensure(!(body.staffId && body.preassignedStaffIds !== undefined), 400, '请勿同时提交两种预分配员工字段')
  const preassignedStaffIds = body.preassignedStaffIds ?? (body.staffId ? [body.staffId] : [])
  ensure(preassignedStaffIds.length <= (body.requiredStaffCount ?? 1), 400, '预分配员工人数不能超过需要协作人数')
  ensure(new Set(preassignedStaffIds).size === preassignedStaffIds.length, 400, '同一员工不能重复预分配')
  ensure(!preassignedStaffIds.length || hasPermission(req.user!, 'orders.assign'), 403, '没有派单权限')
  const [servicePackage, tier, staff] = await Promise.all([
    prisma.servicePackage.findUnique({ where: { id: body.servicePackageId } }),
    findTier(body.requiredTierId),
    preassignedStaffIds[0] ? getStaff(preassignedStaffIds[0]) : Promise.resolve(null),
  ])
  ensure(servicePackage?.isEnabled, servicePackage ? 409 : 404, servicePackage ? '所选服务套餐已停用' : '服务套餐不存在')
  if (tier) ensure(tier.isEnabled, 409, '所选员工层级已停用')
  if (staff && tier) ensure(Boolean(staff.tier && staff.tier.level >= tier.level), 409, '所选员工层级不满足订单要求')
  if (body.customerCouponId) ensure(Boolean(body.customerId), 400, '新客户建单暂不能同时使用已有客户优惠券')

  const requiredStaffCount = body.requiredStaffCount ?? 1
  const recommendedAmountCents = Math.round(servicePackage.basePriceCents * (tier?.priceMultiplierBps ?? 10000) / 10000)
  const selectedCoupon = body.customerCouponId ? await prisma.customerCoupon.findUnique({ where: { id: body.customerCouponId }, include: { coupon: true } }) : null
  if (body.customerCouponId) ensure(selectedCoupon, 404, '优惠券不存在')
  const originalAmountCents = body.originalAmountCents ?? body.amountCents ?? recommendedAmountCents
  const defaultDiscountCents = selectedCoupon?.coupon.amountCents ?? 0
  const discountAmountCents = body.discountAmountCents ?? defaultDiscountCents
  const amountCents = body.amountCents ?? Math.max(originalAmountCents - discountAmountCents, 0)
  ensure(originalAmountCents >= amountCents && discountAmountCents === originalAmountCents - amountCents, 400, '订单金额口径不正确')

  let collaborationSlots = body.collaborationSlots
  if (!collaborationSlots) {
    ensure(requiredStaffCount === 1, 400, '多人协作订单必须配置每个名额的提成比例')
    const rate = body.staffAmountCents !== undefined
      ? (amountCents > 0 ? Math.round(body.staffAmountCents * 10000 / amountCents) : 0)
      : staff?.commissionRateBps ?? config.defaultCommissionRateBps
    collaborationSlots = [{ slotIndex: 1, commissionRateBps: rate }]
  }
  const normalizedSlots = validateCollaborationSlots(requiredStaffCount, collaborationSlots)
  const slotAmounts = normalizedSlots.map((slot) => ({ ...slot, expectedEarningCents: Math.round(amountCents * slot.commissionRateBps / 10000) }))
  const totalExpectedEarningCents = sumBy(slotAmounts, (slot) => slot.expectedEarningCents)
  const rechargeAmountCents = body.rechargeAmountCents ?? 0
  const rechargeBonusCents = rechargeAmountCents > 0 ? (await getAvailableActivityBonus(rechargeAmountCents)).bonusCents : 0

  const created = await prisma.$transaction(async (tx) => {
    // Lock in stable order, but bind slots in the administrator's selection order.
    for (const staffId of [...preassignedStaffIds].sort()) {
      const eligible = await checkStaffAccepting(tx, staffId)
      if (tier) ensure(Boolean(eligible.tier && eligible.tier.level >= tier.level), 409, '所选员工层级不满足订单要求')
    }
    let customer
    if (body.newCustomer) {
      const duplicate = await tx.customer.findUnique({ where: { customerCode: body.newCustomer.customerCode } })
      ensure(!duplicate, 409, `该客户ID已存在客户档案：${duplicate?.customerCode ?? ''}`)
      customer = await tx.customer.create({
        data: { customerCode: body.newCustomer.customerCode, teamCode: body.newCustomer.teamCode, name: body.newCustomer.customerCode, phone: null, note: body.newCustomer.note || null },
      })
      await logOperation(tx, { operatorId: req.user!.id, action: 'CREATE', entityType: 'CUSTOMER', entityId: customer.id, detail: { customerCode: customer.customerCode, teamCode: customer.teamCode, source: 'ORDER_CREATE' } })
    } else {
      customer = await tx.customer.findUnique({ where: { id: body.customerId! } })
      ensure(customer, 404, '客户不存在')
      ensure(!customer.isBlacklisted, 409, '该客户已被列入黑名单，暂不能创建订单')
    }
    if (selectedCoupon) await getValidCustomerCoupon(tx, selectedCoupon.id, customer.id, originalAmountCents)
    if (rechargeAmountCents > 0) await createRechargeInTransaction(tx, customer.id, req.user!.id, rechargeAmountCents, rechargeBonusCents, body.rechargeNote || `新建订单同步充值`)
    const now = new Date()
    const item = await tx.order.create({
      data: {
        orderNo: orderNo(),
        customerId: customer.id,
        staffId: staff?.id ?? null,
        servicePackageId: servicePackage.id,
        requiredTierId: tier?.id ?? null,
        customerCouponId: selectedCoupon?.id ?? null,
        serviceItem: servicePackage.name,
        originalAmountCents,
        discountAmountCents,
        amountCents,
        staffAmountCents: totalExpectedEarningCents,
        requiredStaffCount,
        status: preassignedStaffIds.length === requiredStaffCount ? OrderStatus.PENDING : OrderStatus.PENDING_ASSIGNMENT,
        note: body.note || null,
        assignedAt: staff ? now : null,
        createdById: req.user!.id,
        assignments: {
          create: slotAmounts.map((slot) => ({
            slotIndex: slot.slotIndex,
            commissionRateBps: slot.commissionRateBps,
            expectedEarningCents: slot.expectedEarningCents,
            staffId: preassignedStaffIds[slot.slotIndex - 1] ?? null,
            assignmentStatus: preassignedStaffIds[slot.slotIndex - 1] ? OrderStaffAssignmentStatus.CLAIMED : OrderStaffAssignmentStatus.OPEN,
            claimedAt: preassignedStaffIds[slot.slotIndex - 1] ? now : null,
          })),
        },
      },
      include: orderInclude,
    })
    if (selectedCoupon) {
      const used = await tx.customerCoupon.updateMany({ where: { id: selectedCoupon.id, customerId: customer.id, status: 'ISSUED', usedOrderId: null }, data: { status: 'USED', usedAt: now, usedOrderId: item.id } })
      ensure(used.count === 1, 409, '优惠券已被其他订单使用，请刷新后重试')
    }
    await logOperation(tx, { operatorId: req.user!.id, action: 'CREATE', entityType: 'ORDER', entityId: item.id, detail: { orderNo: item.orderNo, amountCents, requiredStaffCount, slots: slotAmounts, staffId: staff?.id, assignmentId: staff ? item.assignments.find(a => a.staffId === staff.id)?.id : undefined, slotIndex: staff ? 1 : undefined, actorRole: req.user!.role, result: 'SUCCESS', rechargeAmountCents, rechargeBonusCents } })
    // CREATE already counts the first dispatch; each additional slot counts once.
    for (const staffId of preassignedStaffIds.slice(1)) {
      const assignment = item.assignments.find(a => a.staffId === staffId)!
      await logOperation(tx, { operatorId: req.user!.id, action: 'ASSIGN', entityType: 'ORDER', entityId: item.id, detail: { staffId, assignmentId: assignment.id, slotIndex: assignment.slotIndex, actorRole: req.user!.role, result: 'SUCCESS', source: 'ORDER_CREATE' } })
    }
    if (selectedCoupon) {
      const refreshed = await tx.order.findUnique({ where: { id: item.id }, include: orderInclude })
      ensure(refreshed, 500, '订单创建后读取失败')
      return refreshed
    }
    return item
  })
  notifyChange(preassignedStaffIds)
  res.status(201).json({ item: orderView(created) })
}))

router.patch('/orders/:id', ...orderEdit, asyncHandler(async (req, res) => {
  const body = orderUpdateSchema.parse(req.body)
  ensure(body.staffId === undefined || hasPermission(req.user!, 'orders.assign'), 403, '没有派单权限')
  const current = await prisma.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
  ensure(current, 404, '订单不存在')
  ensure(!current.isLocked || req.user!.role === UserRole.SUPER_ADMIN, 409, '订单已锁定，仅超级管理员可以修改')
  ensure(!finalizedOrderStatuses.includes(current.status as typeof finalizedOrderStatuses[number]), 400, '已完成或售后中的订单不能直接修改，请使用售后流程')
  ensure(current.status !== OrderStatus.PENDING_COMPLETION_REVIEW, 400, '待完单审核订单请先完成审核')
  ensure(body.status !== OrderStatus.COMPLETED && body.status !== OrderStatus.PENDING_COMPLETION_REVIEW, 400, '完单状态只能通过后台审核变更')

  const servicePackageId = body.servicePackageId === undefined ? current.servicePackageId : body.servicePackageId
  const servicePackage = servicePackageId ? await prisma.servicePackage.findUnique({ where: { id: servicePackageId } }) : null
  if (servicePackageId) ensure(servicePackage, 404, '服务套餐不存在')
  if (servicePackage) ensure(servicePackage.isEnabled, 409, '所选服务套餐已停用')
  const requiredTierId = body.requiredTierId === undefined ? current.requiredTierId : body.requiredTierId
  const tier = await findTier(requiredTierId)
  if (tier) ensure(tier.isEnabled, 409, '所选员工层级已停用')
  const customerId = body.customerId ?? current.customerId
  const customer = await ensureCustomerCanOrder(customerId)
  const nextRequiredCount = body.requiredStaffCount ?? current.requiredStaffCount
  const amountCents = body.amountCents ?? current.amountCents
  const originalAmountCents = body.originalAmountCents ?? current.originalAmountCents
  const discountAmountCents = body.discountAmountCents ?? current.discountAmountCents
  ensure(originalAmountCents >= amountCents && discountAmountCents === originalAmountCents - amountCents, 400, '订单金额口径不正确')
  const replacementStaff = body.staffId ? await getStaff(body.staffId) : null
  if (replacementStaff && tier) ensure(Boolean(replacementStaff.tier && replacementStaff.tier.level >= tier.level), 409, '所选员工层级不满足订单要求')

  const updated = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, current.id)
    let assignments = await getCurrentAssignments(tx, current.id)
    const participants = assignments.filter((assignment) => assignment.staffId && capacityAssignmentStatuses.includes(assignment.assignmentStatus as typeof capacityAssignmentStatuses[number]))
    if (nextRequiredCount !== current.requiredStaffCount) {
      ensure(!current.startedAt && ([OrderStatus.PENDING, OrderStatus.PENDING_ASSIGNMENT] as OrderStatus[]).includes(current.status), 409, '服务开始后不能修改协作人数')
      ensure(participants.length === 0, 409, '已有员工接单后不能直接修改协作人数，请先释放现有名额')
      ensure(body.collaborationSlots, 400, '修改协作人数时必须重新配置全部名额提成')
      const normalized = validateCollaborationSlots(nextRequiredCount, body.collaborationSlots)
      await tx.orderStaffAssignment.updateMany({ where: { id: { in: assignments.map((assignment) => assignment.id) } }, data: { assignmentStatus: OrderStaffAssignmentStatus.EXITED, exitedAt: new Date() } })
      await tx.orderStaffAssignment.createMany({ data: normalized.map((slot) => ({ orderId: current.id, slotIndex: slot.slotIndex, commissionRateBps: slot.commissionRateBps, expectedEarningCents: Math.round(amountCents * slot.commissionRateBps / 10000) })) })
      assignments = await getCurrentAssignments(tx, current.id)
    }
    const rateSlots = body.collaborationSlots
      ? validateCollaborationSlots(nextRequiredCount, body.collaborationSlots)
      : assignments.map((assignment) => ({ slotIndex: assignment.slotIndex, commissionRateBps: assignment.commissionRateBps }))
    ensure(rateSlots.length === nextRequiredCount, 409, '协作名额配置不完整')
    for (const slot of rateSlots) {
      const assignment = assignments.find((item) => item.slotIndex === slot.slotIndex)
      ensure(assignment, 409, `协作名额 ${slot.slotIndex} 不存在`)
      await tx.orderStaffAssignment.update({ where: { id: assignment.id }, data: { commissionRateBps: slot.commissionRateBps, expectedEarningCents: Math.round(amountCents * slot.commissionRateBps / 10000) } })
    }
    if (body.staffId !== undefined) {
      ensure(nextRequiredCount === 1, 400, '多人协作订单请通过名额分配员工')
      ensure(!current.startedAt && ([OrderStatus.PENDING, OrderStatus.PENDING_ASSIGNMENT] as OrderStatus[]).includes(current.status), 409, '服务开始后不能直接更换员工')
      assignments = await getCurrentAssignments(tx, current.id)
      const currentAssignment = assignments[0]
      ensure(currentAssignment, 409, '订单协作名额不存在')
      if (currentAssignment.staffId !== (replacementStaff?.id ?? null)) {
        if (currentAssignment.staffId) {
          await releaseAssignmentSlot(tx, currentAssignment, { status: ExitReviewStatus.APPROVED, reviewerId: req.user!.id, note: '管理员在编辑订单时重新分配' })
        }
        if (replacementStaff) {
          const assigned = await assignStaffToOrderInTransaction(tx, current.id, replacementStaff, 1, true)
          if (!assigned.idempotent) await logOperation(tx, { operatorId: req.user!.id, action: 'ASSIGN', entityType: 'ORDER', entityId: current.id, detail: { staffId: replacementStaff.id, assignmentId: assigned.assignment.id, slotIndex: assigned.assignment.slotIndex, actorRole: req.user!.role, result: 'SUCCESS', source: 'ORDER_EDIT' } })
        }
      }
    }
    await tx.order.update({
      where: { id: current.id },
      data: {
        customerId: customer.id,
        servicePackageId,
        requiredTierId,
        serviceItem: servicePackage?.name ?? body.serviceItem ?? current.serviceItem,
        originalAmountCents,
        discountAmountCents,
        amountCents,
        requiredStaffCount: nextRequiredCount,
        note: body.note === undefined ? undefined : body.note || null,
      },
    })
    const synced = await syncLegacyAssignmentFields(tx, current.id)
    const full = synced.participants.length >= nextRequiredCount
    const nextStatus = body.status ?? (([OrderStatus.PENDING, OrderStatus.PENDING_ASSIGNMENT] as OrderStatus[]).includes(current.status) ? (full ? OrderStatus.PENDING : OrderStatus.PENDING_ASSIGNMENT) : current.status)
    await tx.order.update({ where: { id: current.id }, data: { status: nextStatus } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'ORDER', entityId: current.id, detail: { ...body, amountCents, requiredStaffCount: nextRequiredCount } })
    const result = await tx.order.findUnique({ where: { id: current.id }, include: orderInclude })
    ensure(result, 404, '订单不存在')
    return result
  })
  notifyChange(current.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(updated) })
}))

router.patch('/orders/:id/assignment-rates', ...orderEdit, asyncHandler(async (req, res) => {
  const body = assignmentRatesSchema.parse(req.body)
  const updated = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, getParam(req))
    const order = await tx.order.findUnique({ where: { id: getParam(req) } })
    ensure(order, 404, '订单不存在')
    ensure(!finalizedOrderStatuses.includes(order.status as typeof finalizedOrderStatuses[number]) && order.status !== OrderStatus.CANCELLED, 400, '当前订单不能调整提成')
    const slots = validateCollaborationSlots(order.requiredStaffCount, body.slots)
    const assignments = await getCurrentAssignments(tx, order.id)
    for (const slot of slots) {
      const assignment = assignments.find((item) => item.slotIndex === slot.slotIndex)
      ensure(assignment, 409, `协作名额 ${slot.slotIndex} 不存在`)
      await tx.orderStaffAssignment.update({ where: { id: assignment.id }, data: { commissionRateBps: slot.commissionRateBps, expectedEarningCents: Math.round(order.amountCents * slot.commissionRateBps / 10000) } })
    }
    await syncLegacyAssignmentFields(tx, order.id)
    await logOperation(tx, { operatorId: req.user!.id, action: 'UPDATE_ASSIGNMENT_RATES', entityType: 'ORDER', entityId: order.id, detail: { slots, afterStart: Boolean(order.startedAt) } })
    const result = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
    ensure(result, 404, '订单不存在')
    return result
  })
  notifyChange(updated.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(updated) })
}))

router.post('/orders/:id/assign', ...orderAssign, asyncHandler(async (req, res) => {
  const body = z.object({ staffId: z.string().min(1), slotIndex: z.coerce.number().int().min(1).max(20).optional() }).parse(req.body)
  const staff = await getStaff(body.staffId)
  const result = await prisma.$transaction(async (tx) => {
    const assigned = await assignStaffToOrderInTransaction(tx, getParam(req), staff, body.slotIndex, true)
    if (!assigned.idempotent) await logOperation(tx, { operatorId: req.user!.id, action: 'ASSIGN', entityType: 'ORDER', entityId: assigned.order.id, detail: { staffId: staff.id, assignmentId: assigned.assignment.id, slotIndex: assigned.assignment.slotIndex, actorRole: req.user!.role, result: 'SUCCESS' } })
    return assigned
  })
  notifyChange([...result.order.assignments.map((assignment) => assignment.staffId), staff.id])
  res.json({ item: orderView(result.order), idempotent: result.idempotent })
}))

router.post('/orders/:id/lock', ...orderLock, asyncHandler(async (req, res) => {
  const current = await prisma.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
  ensure(current, 404, '订单不存在')
  ensure(!([OrderStatus.COMPLETED, OrderStatus.CANCELLED] as OrderStatus[]).includes(current.status), 400, '当前状态不能锁定')
  const updated = await prisma.order.update({ where: { id: current.id }, data: { isLocked: true, lockedAt: new Date(), lockedById: req.user!.id }, include: orderInclude })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'LOCK', entityType: 'ORDER', entityId: current.id })
  notifyChange(updated.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(updated) })
}))

router.post('/orders/:id/unlock', ...orderLock, asyncHandler(async (req, res) => {
  const updated = await prisma.order.update({ where: { id: getParam(req) }, data: { isLocked: false, lockedAt: null, lockedById: null }, include: orderInclude })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UNLOCK', entityType: 'ORDER', entityId: updated.id })
  notifyChange(updated.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(updated) })
}))

router.post('/orders/:id/cancel', ...orderCancel, asyncHandler(async (req, res) => {
  const updated = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, getParam(req))
    const current = await tx.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
    ensure(current, 404, '订单不存在')
    ensure(!current.isLocked || req.user!.role === UserRole.SUPER_ADMIN, 409, '订单已锁定，仅超级管理员可以取消')
    ensure(!finalizedOrderStatuses.includes(current.status as typeof finalizedOrderStatuses[number]) && current.status !== OrderStatus.PENDING_COMPLETION_REVIEW, 400, '已进入结算或售后的订单不能取消')
    await tx.orderStaffAssignment.updateMany({ where: { orderId: current.id, assignmentStatus: { in: [...currentAssignmentStatuses] } }, data: { assignmentStatus: OrderStaffAssignmentStatus.EXITED, exitedAt: new Date() } })
    const item = await tx.order.update({ where: { id: current.id }, data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() }, include: orderInclude })
    await logOperation(tx, { operatorId: req.user!.id, action: 'CANCEL', entityType: 'ORDER', entityId: current.id })
    await updateDerivedStaffStatuses(tx, current.assignments.map((assignment) => assignment.staffId))
    return item
  })
  notifyChange(updated.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(updated) })
}))

router.post('/orders/:id/claim', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const staff = await getStaff(staffId)
  ensure(staff.accepting === StaffAccepting.ACCEPTING, 409, '管理员已暂停您的接单权限，如需恢复请联系管理员。')
  ensure(staff.selfAccepting === StaffAccepting.ACCEPTING, 409, '员工当前暂时不接单')
  ensure(staff.tier?.canAcceptOrders !== false && staff.tier?.isEnabled !== false, 409, '当前员工档位无权接单')
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await assignStaffToOrderInTransaction(tx, getParam(req), staff)
    if (!claimed.idempotent) await logOperation(tx, { operatorId: req.user!.id, action: 'CLAIM', entityType: 'ORDER', entityId: claimed.order.id, detail: { staffId, assignmentId: claimed.assignment.id, slotIndex: claimed.assignment.slotIndex } })
    return claimed
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  notifyChange(result.order.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(result.order, true, staffId), idempotent: result.idempotent })
}))

router.post('/orders/:id/start', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const result = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, getParam(req))
    const order = await tx.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
    ensure(order, 404, '订单不存在')
    const currentSlots = latestSlotAssignments(order.assignments)
    const participant = currentSlots.find((assignment) => assignment.staffId === staffId && capacityAssignmentStatuses.includes(assignment.assignmentStatus as typeof capacityAssignmentStatuses[number]))
    ensure(participant, 404, '订单不存在或无权操作')
    ensure(!order.isLocked, 409, '订单已锁定，暂不能开始')
    if (([OrderStatus.IN_PROGRESS, OrderStatus.PENDING_COMPLETION_REVIEW, OrderStatus.COMPLETED] as OrderStatus[]).includes(order.status)) return { order, idempotent: true }
    ensure(order.status === OrderStatus.PENDING, 400, '只有待处理订单可以开始')
    const participants = currentSlots.filter((assignment) => assignment.staffId && capacityAssignmentStatuses.includes(assignment.assignmentStatus as typeof capacityAssignmentStatuses[number]))
    ensure(participants.length === order.requiredStaffCount, 409, '协作人员尚未到齐')
    const startedAt = new Date()
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.IN_PROGRESS, startedAt } })
    await tx.orderStaffAssignment.updateMany({
      where: { id: { in: participants.map((assignment) => assignment.id) } },
      data: { assignmentStatus: OrderStaffAssignmentStatus.ACTIVE, startedAt },
    })
    await updateDerivedStaffStatuses(tx, participants.map((assignment) => assignment.staffId))
    await logOperation(tx, { operatorId: req.user!.id, action: 'START', entityType: 'ORDER', entityId: order.id, detail: { assignmentIds: participants.map((assignment) => assignment.id) } })
    const updated = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
    ensure(updated, 404, '订单不存在')
    return { order: updated, idempotent: false }
  })
  notifyChange(result.order.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(result.order, true, staffId), idempotent: result.idempotent })
}))

router.post('/orders/:id/exit', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : ''
  const result = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, getParam(req))
    const order = await tx.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
    ensure(order, 404, '订单不存在')
    const assignment = latestSlotAssignments(order.assignments).find((item) => item.staffId === staffId && capacityAssignmentStatuses.includes(item.assignmentStatus as typeof capacityAssignmentStatuses[number]))
    ensure(assignment, 404, '订单不存在或无权退出')
    ensure(!order.isLocked, 409, '订单已锁定，请联系管理员处理')
    if (([OrderStatus.PENDING, OrderStatus.PENDING_ASSIGNMENT] as OrderStatus[]).includes(order.status)) {
      const synced = await releaseAssignmentSlot(tx, assignment, { status: ExitReviewStatus.APPROVED, note: reason || '员工在服务开始前自行退出' })
      await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING_ASSIGNMENT } })
      await logOperation(tx, { operatorId: req.user!.id, action: 'EXIT_ORDER', entityType: 'ORDER', entityId: order.id, detail: { assignmentId: assignment.id, slotIndex: assignment.slotIndex, reason: reason || null } })
      await updateDerivedStaffStatus(tx, staffId)
      const updated = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
      ensure(updated, 404, '订单不存在')
      return { order: updated, requested: false, participantIds: synced.participants.map((item) => item.staffId) }
    }
    ensure(order.status === OrderStatus.IN_PROGRESS, 409, '当前订单状态不能申请退出')
    const body = exitRequestSchema.parse({ reason })
    if (assignment.assignmentStatus === OrderStaffAssignmentStatus.EXIT_REQUESTED) return { order, requested: true, participantIds: order.assignments.map((item) => item.staffId), idempotent: true }
    await tx.orderStaffAssignment.update({
      where: { id: assignment.id },
      data: { assignmentStatus: OrderStaffAssignmentStatus.EXIT_REQUESTED, exitReviewStatus: ExitReviewStatus.PENDING, exitRequestedAt: new Date(), exitReason: body.reason },
    })
    await logOperation(tx, { operatorId: req.user!.id, action: 'REQUEST_EXIT_ORDER', entityType: 'ORDER', entityId: order.id, detail: { assignmentId: assignment.id, slotIndex: assignment.slotIndex, reason: body.reason } })
    const updated = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
    ensure(updated, 404, '订单不存在')
    return { order: updated, requested: true, participantIds: updated.assignments.map((item) => item.staffId), idempotent: false }
  })
  notifyChange([...result.participantIds, staffId])
  res.json({ item: orderView(result.order, true, staffId), exitReviewRequired: result.requested, idempotent: result.idempotent ?? false })
}))

router.post('/orders/:id/assignments/:assignmentId/exit-review', ...orderAssign, asyncHandler(async (req, res) => {
  const body = exitReviewSchema.parse(req.body)
  const assignmentId = getParam(req, 'assignmentId')
  const result = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, getParam(req))
    const order = await tx.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
    ensure(order, 404, '订单不存在')
    const assignment = order.assignments.find((item) => item.id === assignmentId)
    ensure(assignment?.assignmentStatus === OrderStaffAssignmentStatus.EXIT_REQUESTED && assignment.exitReviewStatus === ExitReviewStatus.PENDING, 409, '该退出申请已处理或不存在')
    if (body.approved) {
      await releaseAssignmentSlot(tx, assignment, { status: ExitReviewStatus.APPROVED, reviewerId: req.user!.id, note: body.note || '管理员同意退出' })
      if (!order.startedAt) await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING_ASSIGNMENT } })
    } else {
      await tx.orderStaffAssignment.update({
        where: { id: assignment.id },
        data: {
          assignmentStatus: order.startedAt ? OrderStaffAssignmentStatus.ACTIVE : OrderStaffAssignmentStatus.CLAIMED,
          exitReviewStatus: ExitReviewStatus.REJECTED,
          exitReviewedAt: new Date(),
          exitReviewedById: req.user!.id,
          exitReviewNote: body.note || null,
        },
      })
    }
    await logOperation(tx, { operatorId: req.user!.id, action: body.approved ? 'APPROVE_EXIT_ORDER' : 'REJECT_EXIT_ORDER', entityType: 'ORDER', entityId: order.id, detail: { assignmentId, note: body.note || null } })
    if (assignment.staffId) await updateDerivedStaffStatus(tx, assignment.staffId)
    const updated = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
    ensure(updated, 404, '订单不存在')
    return updated
  })
  notifyChange(result.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(result) })
}))

router.post('/orders/:id/completion-submissions', ...staffOnly, completionProofUpload.array('proofs', 6), asyncHandler(async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : []
  let keepFiles = false
  try {
    const staffId = req.user!.staffProfileId
    ensure(staffId, 403, '员工档案不存在')
    const note = z.string().trim().min(1).max(2000).parse(req.body.note)
    ensure(files.length > 0, 400, '请至少上传一张完单凭证')
    const signatures = await Promise.all(files.map(isAllowedImageSignature))
    ensure(signatures.every(Boolean), 415, '图片内容与文件类型不一致')
    const result = await prisma.$transaction(async (tx) => {
      await lockOrderRow(tx, getParam(req))
      const order = await tx.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
      ensure(order, 404, '订单不存在')
      ensure(order.status === OrderStatus.IN_PROGRESS, 409, order.status === OrderStatus.PENDING_COMPLETION_REVIEW ? '订单已进入待完单审核' : '只有进行中订单可以提交完单')
      const currentSlots = latestSlotAssignments(order.assignments)
      const assignment = currentSlots.find((item) => item.staffId === staffId && item.assignmentStatus === OrderStaffAssignmentStatus.ACTIVE)
      ensure(assignment, 403, '只有当前有效参与员工可以提交完单')
      if (assignment.completionReviewStatus === CompletionReviewStatus.SUBMITTED) return { order, idempotent: true }
      const submittedAt = new Date()
      await tx.orderCompletionProof.createMany({
        data: files.map((file) => ({
          assignmentId: assignment.id,
          orderId: order.id,
          staffId,
          proofPath: path.relative(process.cwd(), file.path).split(path.sep).join('/'),
          mimeType: file.mimetype,
          sizeBytes: file.size,
          note,
          submittedAt,
          reviewStatus: CompletionReviewStatus.SUBMITTED,
        })),
      })
      await tx.orderStaffAssignment.update({
        where: { id: assignment.id },
        data: { completionSubmittedAt: submittedAt, completionReviewStatus: CompletionReviewStatus.SUBMITTED, completionReviewReason: null },
      })
      const participants = await tx.orderStaffAssignment.findMany({ where: { orderId: order.id, assignmentStatus: { in: [...capacityAssignmentStatuses] } } })
      const allSubmitted = participants.length === order.requiredStaffCount && participants.every((item) => item.completionReviewStatus === CompletionReviewStatus.SUBMITTED)
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: allSubmitted ? OrderStatus.PENDING_COMPLETION_REVIEW : OrderStatus.IN_PROGRESS,
          completionReviewStatus: allSubmitted ? CompletionReviewStatus.SUBMITTED : CompletionReviewStatus.NOT_SUBMITTED,
          completionSubmittedAt: allSubmitted ? submittedAt : null,
          completionReviewReason: null,
          completionReviewedAt: null,
          completionReviewedById: null,
        },
      })
      await logOperation(tx, { operatorId: req.user!.id, action: 'SUBMIT_COMPLETION', entityType: 'ORDER', entityId: order.id, detail: { assignmentId: assignment.id, proofCount: files.length, allSubmitted } })
      const updated = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
      ensure(updated, 404, '订单不存在')
      return { order: updated, idempotent: false }
    })
    if (result.idempotent) await removeUploadedFiles(files)
    else keepFiles = true
    notifyChange(result.order.assignments.map((assignment) => assignment.staffId))
    res.json({ item: orderView(result.order, true, staffId), idempotent: result.idempotent })
  } finally {
    if (!keepFiles) await removeUploadedFiles(files)
  }
}))

router.post('/orders/:id/completion-review', ...orderReview, asyncHandler(async (req, res) => {
  const body = completionReviewSchema.parse(req.body)
  if (body.approved) {
    const current = await prisma.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
    ensure(current, 404, '订单不存在')
    const updated = await prisma.$transaction((tx) => completeOrderWithBalance(tx, current.id, req.user!.id), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    ensure(updated, 404, '订单不存在')
    notifyChange(updated.assignments.map((assignment) => assignment.staffId))
    res.json({ item: orderView(updated), idempotent: current.status === OrderStatus.COMPLETED })
    return
  }
  const updated = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, getParam(req))
    const order = await tx.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
    ensure(order, 404, '订单不存在')
    ensure(order.status === OrderStatus.PENDING_COMPLETION_REVIEW, 409, '只有待完单审核订单可以退回')
    const reason = body.reason!.trim()
    await tx.orderCompletionProof.updateMany({ where: { orderId: order.id, reviewStatus: CompletionReviewStatus.SUBMITTED }, data: { reviewStatus: CompletionReviewStatus.REJECTED } })
    await tx.orderStaffAssignment.updateMany({
      where: { orderId: order.id, assignmentStatus: { in: [...capacityAssignmentStatuses] }, completionReviewStatus: CompletionReviewStatus.SUBMITTED },
      data: { completionReviewStatus: CompletionReviewStatus.REJECTED, completionReviewReason: reason },
    })
    await tx.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.IN_PROGRESS, completionReviewStatus: CompletionReviewStatus.REJECTED, completionReviewReason: reason, completionReviewedAt: new Date(), completionReviewedById: req.user!.id },
    })
    await logOperation(tx, { operatorId: req.user!.id, action: 'REJECT_COMPLETION', entityType: 'ORDER', entityId: order.id, detail: { reason } })
    const result = await tx.order.findUnique({ where: { id: order.id }, include: orderInclude })
    ensure(result, 404, '订单不存在')
    return result
  })
  notifyChange(updated.assignments.map((assignment) => assignment.staffId))
  res.json({ item: orderView(updated) })
}))

router.post('/orders/:id/adjustments', ...orderEdit, asyncHandler(async (req, res) => {
  const body = orderAdjustmentSchema.parse(req.body)
  const netAmountCents = parseYuanToCents(body.netAmount, '调整后订单金额')
  ensure(netAmountCents >= 0, 400, '调整后订单金额不能小于 0')
  const staffNetEarnings = body.staffNetEarnings.map((item) => ({ assignmentId: item.assignmentId, amountCents: parseYuanToCents(item.amount, '员工调整后应得') }))
  ensure(staffNetEarnings.every((item) => item.amountCents >= 0), 400, '员工调整后应得不能小于 0')
  ensure(sumBy(staffNetEarnings, (item) => item.amountCents) <= netAmountCents, 400, '员工调整后应得合计不能超过调整后订单金额')

  const result = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, getParam(req))
    const existing = await tx.orderAdjustment.findUnique({ where: { requestId: body.requestId }, include: { staffAdjustments: true } })
    if (existing) {
      ensure(existing.orderId === getParam(req), 409, '该调整请求已用于其他订单')
      return { adjustment: existing, orderId: existing.orderId, staffIds: existing.staffAdjustments.map((item) => item.staffId), idempotent: true }
    }
    const order = await tx.order.findUnique({
      where: { id: getParam(req) },
      include: {
        orderConsumption: true,
        adjustments: { include: { staffAdjustments: true } },
        fundTransactions: { where: { type: FundTransactionType.ORDER_ADJUSTMENT }, orderBy: { createdAt: 'asc' } },
        assignments: { where: { assignmentStatus: OrderStaffAssignmentStatus.COMPLETED }, include: { earningAdjustments: true } },
      },
    })
    ensure(order, 404, '订单不存在')
    ensure(finalizedOrderStatuses.includes(order.status as typeof finalizedOrderStatuses[number]), 409, '只有已完成或售后中的订单可以调整')
    ensure(order.completedAt && order.completionReviewStatus === CompletionReviewStatus.APPROVED && order.orderConsumption, 409, '该订单尚未完成最终审核和结算，暂不能进行售后金额调整。')
    const currentNetAmountCents = order.amountCents + sumBy(order.adjustments, (item) => item.orderAmountDeltaCents)
    const orderDeltaCents = netAmountCents - currentNetAmountCents
    ensure(orderDeltaCents !== 0 || staffNetEarnings.some((item) => {
      const assignment = order.assignments.find((entry) => entry.id === item.assignmentId)
      return assignment && currentActualEarning(assignment) !== item.amountCents
    }), 400, '调整后的订单和员工金额均未发生变化')
    ensure(staffNetEarnings.length === order.assignments.length && new Set(staffNetEarnings.map((item) => item.assignmentId)).size === order.assignments.length, 400, '请填写全部参与员工的调整后应得')
    ensure(staffNetEarnings.every((item) => order.assignments.some((assignment) => assignment.id === item.assignmentId)), 400, '员工应得调整包含无效参与记录')
    if (body.afterSaleId) {
      const afterSale = await tx.afterSaleCase.findUnique({ where: { id: body.afterSaleId } })
      ensure(afterSale?.orderId === order.id, 400, '关联售后不属于当前订单')
    }

    const customerRows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM customers WHERE id = ${order.customerId} FOR UPDATE`
    ensure(customerRows.length === 1, 404, '客户不存在')
    const customer = await tx.customer.findUnique({ where: { id: order.customerId } })
    ensure(customer, 404, '客户不存在')
    let principalAfterCents = customer.principalBalanceCents
    let bonusAfterCents = customer.bonusBalanceCents

    if (orderDeltaCents > 0) {
      ensure(customer.balanceCents >= orderDeltaCents, 409, '客户余额不足，无法增加订单净额')
      const fundingPolicy = await getGlobalFundingPolicy(tx)
      const bonusUsed = fundingPolicy === FundingPolicy.BONUS_FIRST ? Math.min(bonusAfterCents, orderDeltaCents) : Math.min(bonusAfterCents, Math.max(0, orderDeltaCents - Math.min(principalAfterCents, orderDeltaCents)))
      const principalUsed = fundingPolicy === FundingPolicy.BONUS_FIRST ? orderDeltaCents - bonusUsed : Math.min(principalAfterCents, orderDeltaCents)
      principalAfterCents -= principalUsed
      bonusAfterCents -= bonusUsed
    } else if (orderDeltaCents < 0) {
      const refundCents = -orderDeltaCents
      const sourceTotals = order.fundTransactions.reduce((totals, item) => {
        const principalDelta = item.principalAfterCents - item.principalBeforeCents
        const bonusDelta = item.bonusAfterCents - item.bonusBeforeCents
        totals.principalConsumed += Math.max(-principalDelta, 0)
        totals.bonusConsumed += Math.max(-bonusDelta, 0)
        totals.principalRefunded += Math.max(principalDelta, 0)
        totals.bonusRefunded += Math.max(bonusDelta, 0)
        return totals
      }, {
        principalConsumed: order.orderConsumption.principalUsedCents,
        bonusConsumed: order.orderConsumption.bonusUsedCents,
        principalRefunded: 0,
        bonusRefunded: 0,
      })
      const refundablePrincipal = Math.max(sourceTotals.principalConsumed - sourceTotals.principalRefunded, 0)
      const principalRefund = Math.min(refundCents, refundablePrincipal)
      const bonusRefund = refundCents - principalRefund
      ensure(bonusRefund <= Math.max(sourceTotals.bonusConsumed - sourceTotals.bonusRefunded, 0), 409, '退款金额超过该订单可退余额')
      principalAfterCents += principalRefund
      bonusAfterCents += bonusRefund
    }

    const adjustment = await tx.orderAdjustment.create({
      data: {
        requestId: body.requestId,
        orderId: order.id,
        afterSaleId: body.afterSaleId || null,
        operatorId: req.user!.id,
        reason: body.reason,
        handlingNote: body.handlingNote || null,
        orderAmountBeforeCents: currentNetAmountCents,
        orderAmountDeltaCents: orderDeltaCents,
        orderAmountAfterCents: netAmountCents,
      },
    })
    for (const staffAmount of staffNetEarnings) {
      const assignment = order.assignments.find((item) => item.id === staffAmount.assignmentId)!
      const earningBeforeCents = currentActualEarning(assignment)
      await tx.staffEarningAdjustment.create({ data: { orderAdjustmentId: adjustment.id, assignmentId: assignment.id, staffId: assignment.staffId!, earningBeforeCents, earningDeltaCents: staffAmount.amountCents - earningBeforeCents, earningAfterCents: staffAmount.amountCents } })
    }
    if (orderDeltaCents !== 0) {
      const updated = await tx.customer.update({ where: { id: customer.id }, data: { principalBalanceCents: principalAfterCents, bonusBalanceCents: bonusAfterCents, balanceCents: principalAfterCents + bonusAfterCents } })
      await tx.fundTransaction.create({ data: { customerId: customer.id, operatorId: req.user!.id, orderId: order.id, type: FundTransactionType.ORDER_ADJUSTMENT, amountCents: -orderDeltaCents, principalBeforeCents: customer.principalBalanceCents, principalAfterCents, bonusBeforeCents: customer.bonusBalanceCents, bonusAfterCents, balanceBeforeCents: customer.balanceCents, balanceAfterCents: updated.balanceCents, note: `订单 ${order.orderNo} 净额调整：${body.reason}` } })
    }
    await logOperation(tx, { operatorId: req.user!.id, action: 'ADJUST_COMPLETED_ORDER', entityType: 'ORDER', entityId: order.id, detail: { requestId: body.requestId, adjustmentId: adjustment.id, orderAmountBeforeCents: currentNetAmountCents, orderAmountDeltaCents: orderDeltaCents, orderAmountAfterCents: netAmountCents, afterSaleId: body.afterSaleId || null } })
    return { adjustment, orderId: order.id, staffIds: order.assignments.map((item) => item.staffId!), idempotent: false }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  const order = await prisma.order.findUnique({ where: { id: result.orderId }, include: orderInclude })
  ensure(order, 404, '订单不存在')
  notifyChange(result.staffIds)
  res.status(result.idempotent ? 200 : 201).json({ item: orderView(order), adjustment: result.adjustment, idempotent: result.idempotent })
}))

router.post('/orders/:id/complete', ...staffOnly, asyncHandler(async (_req, _res) => {
  throw new HttpError(409, '请上传完单凭证并提交审核，员工不能直接完成订单')
}))

router.delete('/orders/:id', ...authenticated, asyncHandler(async (req, res) => {
  ensure(req.user!.role === UserRole.SUPER_ADMIN, 403, '仅超级管理员可以删除订单')
  const body = z.object({ orderNo: z.string().trim().min(1).max(40) }).strict().parse(req.body)
  const result = await deleteOrder(getParam(req), body.orderNo, req.user!.id)
  notifyChange(result.staffIds)
  const cleanup = await cleanupDeletedOrderProofs(result, req.user!.id)
  res.json({ message: '订单已删除，关联账务已回退', restoredPrincipalCents: result.restoredPrincipalCents, restoredBonusCents: result.restoredBonusCents, cleanupPending: cleanup.some(item => item.status === 'pending-cleanup') })
}))

router.get('/order-proofs/:id/file', ...authenticated, asyncHandler(async (req, res) => {
  const proof = await prisma.orderCompletionProof.findUnique({ where: { id: getParam(req) }, include: { assignment: true } })
  ensure(proof, 404, '完单凭证不存在')
  if (req.user!.role === UserRole.STAFF) {
    ensure(req.user!.staffProfileId === proof.staffId && participatingAssignmentStatuses.includes(proof.assignment.assignmentStatus as typeof participatingAssignmentStatuses[number]), 403, '无权查看该完单凭证')
  } else {
    ensure(hasPermission(req.user!, 'orders.view'), 403, '无权查看该完单凭证')
  }
  const absolutePath = path.resolve(process.cwd(), proof.proofPath)
  const allowedPrefix = completionProofDirectory.endsWith(path.sep) ? completionProofDirectory : completionProofDirectory + path.sep
  ensure(absolutePath.startsWith(allowedPrefix), 403, '完单凭证路径无效')
  let resolvedPath: string
  try { resolvedPath = await realpath(absolutePath) } catch { throw new HttpError(404, '完单凭证文件不存在，请联系管理员核查备份') }
  const resolvedRoot = await realpath(completionProofDirectory)
  ensure(resolvedPath.startsWith(resolvedRoot + path.sep), 403, '完单凭证路径无效')
  res.setHeader('Cache-Control', 'private, no-store')
  res.type(proof.mimeType)
  // Apply dotfile checks within the verified upload root, not its parent directories.
  res.sendFile(path.relative(resolvedRoot, resolvedPath), { root: resolvedRoot, dotfiles: 'deny' })
}))

router.get('/workbench/available-orders', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const staff = await getStaff(staffId, false)
  if (staff.accountStatus !== StaffAccountStatus.NORMAL || staff.accepting !== StaffAccepting.ACCEPTING || staff.selfAccepting !== StaffAccepting.ACCEPTING || staff.tier?.isEnabled === false || staff.tier?.canAcceptOrders === false) {
    res.json({ items: [], accepting: staff.accepting, selfAccepting: staff.selfAccepting, tier: staff.tier })
    return
  }
  const where: Prisma.OrderWhereInput = {
    status: { in: [OrderStatus.PENDING_ASSIGNMENT, OrderStatus.IN_PROGRESS] },
    isLocked: false,
    assignments: { some: { assignmentStatus: OrderStaffAssignmentStatus.OPEN } },
    NOT: { assignments: { some: { staffId, assignmentStatus: { in: [...capacityAssignmentStatuses] } } } },
    OR: staff.tierId
      ? [{ requiredTierId: null }, { requiredTier: { level: { lte: staff.tier?.level ?? 0 } } }]
      : [{ requiredTierId: null }],
  }
  const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'asc' }, take: 100, include: orderInclude })
  const available = orders.filter((order) => latestSlotAssignments(order.assignments).some((assignment) => assignment.assignmentStatus === OrderStaffAssignmentStatus.OPEN))
  res.json({ items: available.map((item) => orderView(item, true, staffId, true)), accepting: staff.accepting, selfAccepting: staff.selfAccepting, tier: staff.tier })
}))

/* Legacy single-assignee order routes are kept here only as migration context.
router.get('/orders', ...authenticated, asyncHandler(async (req, res) => {
  const staffId = req.user!.role === UserRole.STAFF ? req.user!.staffProfileId : undefined
  if (!staffId) {
    ensure(isAdminRole(req.user!.role) && hasPermission(req.user!, 'orders.view'), 403, '当前账号没有查看订单的权限')
  }
  const where: Prisma.OrderWhereInput = {}
  if (staffId) where.staffId = staffId
  if (typeof req.query.status === 'string' && Object.values(OrderStatus).includes(req.query.status as OrderStatus)) where.status = req.query.status as OrderStatus
  if (typeof req.query.staffId === 'string' && !staffId) where.staffId = req.query.staffId
  if (typeof req.query.from === 'string' || typeof req.query.to === 'string') where.createdAt = { gte: parseQueryDate(req.query.from, new Date(0)), lte: parseQueryDate(req.query.to, new Date()) }
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
  if (search) where.OR = [{ orderNo: { contains: search } }, { serviceItem: { contains: search } }, { customer: { name: { contains: search } } }, { customer: { phone: { contains: search } } }]
  const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: orderInclude })
  res.json({ items: orders.map((item) => orderView(item, Boolean(staffId))) })
}))
router.get('/orders/export', ...orderRead, asyncHandler(async (req, res) => {
  const where: Prisma.OrderWhereInput = {}
  if (typeof req.query.status === 'string' && Object.values(OrderStatus).includes(req.query.status as OrderStatus)) where.status = req.query.status as OrderStatus
  if (typeof req.query.staffId === 'string') where.staffId = req.query.staffId
  if (typeof req.query.from === 'string' || typeof req.query.to === 'string') where.createdAt = { gte: parseQueryDate(req.query.from, new Date(0)), lte: parseQueryDate(req.query.to, new Date()) }
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
  if (search) where.OR = [{ orderNo: { contains: search } }, { serviceItem: { contains: search } }, { customer: { name: { contains: search } } }, { customer: { phone: { contains: search } } }]
  const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000, include: orderInclude })
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('订单列表')
  sheet.columns = [
    { header: '订单号', key: 'orderNo', width: 24 },
    { header: '客户', key: 'customer', width: 16 },
    { header: '服务项目', key: 'serviceItem', width: 24 },
    { header: '订单金额（元）', key: 'amount', width: 16 },
    { header: '员工金额（元）', key: 'staffAmount', width: 16 },
    { header: '员工', key: 'staff', width: 14 },
    { header: '状态', key: 'status', width: 18 },
    { header: '创建时间', key: 'createdAt', width: 22 },
    { header: '备注', key: 'note', width: 36 },
  ]
  for (const order of orders) sheet.addRow({ orderNo: order.orderNo, customer: order.customer.customerCode, serviceItem: order.serviceItem, amount: (order.amountCents / 100).toFixed(2), staffAmount: (order.staffAmountCents / 100).toFixed(2), staff: order.staff?.name || '待分配', status: orderStatusLabel(order.status), createdAt: order.createdAt.toLocaleString('zh-CN'), note: order.note || '' })
  sheet.getRow(1).font = { bold: true }
  const buffer = await workbook.xlsx.writeBuffer()
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''club-orders-${dateKey(new Date())}.xlsx`)
  res.send(Buffer.from(buffer as unknown as Uint8Array))
}))
router.get('/orders/:id', ...authenticated, asyncHandler(async (req, res) => {
  if (isAdminRole(req.user!.role)) ensure(hasPermission(req.user!, 'orders.view'), 403, '当前账号没有查看订单的权限')
  const order = await getOrderForUser(getParam(req), req)
  res.json({ item: orderView(order, req.user!.role === UserRole.STAFF) })
}))
router.get('/orders/:id/logs', ...orderRead, asyncHandler(async (req, res) => {
  const items = await prisma.operationLog.findMany({ where: { entityType: 'ORDER', entityId: getParam(req) }, orderBy: { createdAt: 'desc' }, include: { operator: { select: { username: true } } } })
  res.json({ items })
}))
router.post('/orders', ...orderCreate, asyncHandler(async (req, res) => {
  const body = orderSchema.parse(req.body)
  const customer = await ensureCustomerCanOrder(body.customerId)
  const staff = body.staffId ? await getStaff(body.staffId) : null
  const tier = await findTier(body.requiredTierId)
  const servicePackage = body.servicePackageId ? await prisma.servicePackage.findUnique({ where: { id: body.servicePackageId } }) : null
  if (body.servicePackageId) ensure(servicePackage, 404, '服务套餐不存在')
  if (servicePackage) ensure(servicePackage.isEnabled, 409, '所选服务套餐已停用')
  if (tier) ensure(tier.isEnabled, 409, '所选员工层级已停用')
  if (staff && tier) ensure(Boolean(staff.tier && staff.tier.level >= tier.level), 409, '所选员工层级不满足订单要求')
  const selectedCoupon = body.customerCouponId ? await prisma.customerCoupon.findUnique({ where: { id: body.customerCouponId }, include: { coupon: true } }) : null
  if (body.customerCouponId) ensure(selectedCoupon, 404, '优惠券不存在')
  const originalAmount = body.originalAmountCents ?? (selectedCoupon ? body.amountCents + selectedCoupon.coupon.amountCents : body.amountCents)
  const discountAmount = body.discountAmountCents ?? Math.max(originalAmount - body.amountCents, 0)
  ensure(originalAmount >= body.amountCents && discountAmount <= originalAmount, 400, '订单金额口径不正确')
  if (selectedCoupon) {
    ensure(discountAmount >= selectedCoupon.coupon.amountCents, 400, '订单金额未正确使用优惠券')
    await getValidCustomerCoupon(prisma, selectedCoupon.id, customer.id, originalAmount)
  }
  const amount = body.amountCents
  const staffAmount = getStaffAmount(amount, body.staffAmountCents, staff?.commissionRateBps)
  const created = await prisma.$transaction(async (tx) => {
    if (selectedCoupon) await getValidCustomerCoupon(tx, selectedCoupon.id, customer.id, originalAmount)
    const order = await tx.order.create({
      data: {
        orderNo: orderNo(),
        customerId: customer.id,
        staffId: staff?.id,
        servicePackageId: body.servicePackageId || null,
        requiredTierId: tier?.id,
        customerCouponId: selectedCoupon?.id ?? null,
        serviceItem: body.serviceItem,
        originalAmountCents: originalAmount,
        discountAmountCents: discountAmount,
        amountCents: amount,
        staffAmountCents: staffAmount,
        status: staff ? OrderStatus.PENDING : OrderStatus.PENDING_ASSIGNMENT,
        note: body.note || null,
        assignedAt: staff ? new Date() : null,
        createdById: req.user!.id,
      },
      include: orderInclude,
    })
    if (selectedCoupon) {
      const used = await tx.customerCoupon.updateMany({ where: { id: selectedCoupon.id, customerId: customer.id, status: 'ISSUED', usedOrderId: null }, data: { status: 'USED', usedAt: new Date(), usedOrderId: order.id } })
      ensure(used.count === 1, 409, '优惠券已被其他订单使用，请刷新后重试')
    }
    return order
  })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'ORDER', entityId: created.id, detail: { orderNo: created.orderNo, amountCents: amount, staffAmountCents: staffAmount, staffId: staff?.id } })
  notifyChange([staff?.id])
  res.status(201).json({ item: orderView(created) })
}))
router.patch('/orders/:id', ...orderEdit, asyncHandler(async (req, res) => {
  const body = orderUpdateSchema.parse(req.body)
  ensure(body.staffId === undefined || hasPermission(req.user!, 'orders.assign'), 403, '没有派单权限')
  const current = await prisma.order.findUnique({ where: { id: getParam(req) }, include: orderInclude })
  ensure(current, 404, '订单不存在')
  ensure(!current.isLocked || req.user!.role === UserRole.SUPER_ADMIN, 409, '订单已锁定，仅超级管理员可以修改')
  if (current.status === OrderStatus.COMPLETED) {
    ensure(body.status === undefined || body.status === OrderStatus.COMPLETED, 400, '已完成订单不能修改状态')
    ensure(body.amountCents === undefined && body.staffAmountCents === undefined && body.staffId === undefined, 400, '已完成订单不能修改金额或员工')
  }
  if (body.status === OrderStatus.COMPLETED && current.status !== OrderStatus.COMPLETED) {
    const updated = await prisma.$transaction((tx) => completeOrderWithBalance(tx, current.id, req.user!.id))
    ensure(updated, 409, '订单完成失败')
    notifyChange([current.staffId])
    res.json({ item: orderView(updated) })
    return
  }
  const customer = await ensureCustomerCanOrder(body.customerId ?? current.customerId)
  const requiredTierId = body.requiredTierId === undefined ? current.requiredTierId : body.requiredTierId
  const tier = await findTier(requiredTierId)
  if (tier) ensure(tier.isEnabled, 409, '所选员工层级已停用')
  const servicePackageId = body.servicePackageId === undefined ? current.servicePackageId : body.servicePackageId
  const servicePackage = servicePackageId ? await prisma.servicePackage.findUnique({ where: { id: servicePackageId } }) : null
  if (servicePackageId) ensure(servicePackage, 404, '服务套餐不存在')
  if (servicePackage) ensure(servicePackage.isEnabled, 409, '所选服务套餐已停用')
  const staff = body.staffId === undefined ? (current.staffId ? await getStaff(current.staffId) : null) : body.staffId ? await getStaff(body.staffId) : null
  if (staff && tier) ensure(Boolean(staff.tier && staff.tier.level >= tier.level), 409, '所选员工层级不满足订单要求')
  const amount = body.amountCents ?? current.amountCents
  const originalAmount = body.originalAmountCents ?? current.originalAmountCents
  const discountAmount = body.discountAmountCents ?? current.discountAmountCents
  ensure(originalAmount >= amount && discountAmount >= 0 && discountAmount <= originalAmount, 400, '订单金额口径不正确')
  const selectedCoupon = body.customerCouponId && body.customerCouponId !== current.customerCouponId
    ? await prisma.customerCoupon.findUnique({ where: { id: body.customerCouponId }, include: { coupon: true } })
    : null
  if (body.customerCouponId !== undefined && body.customerCouponId !== current.customerCouponId) {
    ensure(!current.customerCouponId && Boolean(body.customerCouponId), 409, '已核销优惠券不能更换或移除')
    ensure(selectedCoupon, 404, '优惠券不存在')
    await getValidCustomerCoupon(prisma, selectedCoupon.id, customer.id, originalAmount)
    ensure(discountAmount >= selectedCoupon.coupon.amountCents, 400, '订单金额未正确使用优惠券')
  }
  if (body.customerId && body.customerId !== current.customerId) ensure(!current.customerCouponId, 409, '已使用优惠券的订单不能更换客户')
  const staffAmount = body.staffAmountCents ?? (body.amountCents !== undefined && staff ? calculateStaffAmount(amount, staff.commissionRateBps) : current.staffAmountCents)
  const nextStatus = body.status ?? (body.staffId !== undefined ? (staff ? OrderStatus.PENDING : OrderStatus.PENDING_ASSIGNMENT) : current.status)
  ensure(nextStatus !== OrderStatus.COMPLETED, 400, '完成订单请使用完成操作')
  if (nextStatus === OrderStatus.PENDING_ASSIGNMENT) ensure(!staff, 400, '待分配订单不能绑定员工')
  const updated = await prisma.$transaction(async (tx) => {
    if (selectedCoupon) await getValidCustomerCoupon(tx, selectedCoupon.id, customer.id, originalAmount)
    const result = await tx.order.update({
      where: { id: current.id },
      data: {
        customerId: body.customerId,
        serviceItem: body.serviceItem,
        amountCents: body.amountCents,
        originalAmountCents: body.originalAmountCents,
        discountAmountCents: body.discountAmountCents,
        staffAmountCents: body.staffAmountCents ?? (body.amountCents !== undefined && staff ? staffAmount : undefined),
        staffId: body.staffId === undefined ? undefined : staff?.id ?? null,
        servicePackageId: body.servicePackageId === undefined ? undefined : body.servicePackageId,
        requiredTierId: body.requiredTierId === undefined ? undefined : body.requiredTierId,
        customerCouponId: body.customerCouponId === undefined ? undefined : body.customerCouponId,
        note: body.note === undefined ? undefined : body.note || null,
        status: nextStatus,
        assignedAt: body.staffId !== undefined ? (staff ? new Date() : null) : undefined,
        completedAt: null,
      },
      include: orderInclude,
    })
    if (selectedCoupon) {
      const used = await tx.customerCoupon.updateMany({ where: { id: selectedCoupon.id, customerId: customer.id, status: 'ISSUED', usedOrderId: null }, data: { status: 'USED', usedAt: new Date(), usedOrderId: result.id } })
      ensure(used.count === 1, 409, '优惠券已被其他订单使用，请刷新后重试')
    }
    return result
  })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'ORDER', entityId: updated.id, detail: body })
  notifyChange([current.staffId, updated.staffId])
  res.json({ item: orderView(updated) })
}))
router.post('/orders/:id/assign', ...orderAssign, asyncHandler(async (req, res) => {
  const staffId = z.string().min(1).parse(req.body.staffId)
  const staff = await getStaff(staffId)
  const current = await prisma.order.findUnique({ where: { id: getParam(req) } })
  ensure(current, 404, '订单不存在')
  ensure(!current.isLocked || req.user!.role === UserRole.SUPER_ADMIN, 409, '订单已锁定，仅超级管理员可以重新分配')
  ensure(!([OrderStatus.PENDING_PAYMENT, OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.AFTER_SALE] as OrderStatus[]).includes(current.status), 400, '当前状态不能重新分配')
  if (current.requiredTierId) {
    const required = await findTier(current.requiredTierId)
    ensure(required && staff.tier && staff.tier.level >= required.level, 409, '所选员工层级不满足订单要求')
  }
  const updatedCount = await prisma.order.updateMany({ where: { id: current.id, status: current.status, isLocked: false }, data: { staffId: staff.id, assignedAt: new Date(), status: OrderStatus.PENDING } })
  ensure(updatedCount.count === 1, 409, '订单状态已变化，请刷新后重试')
  const updated = await prisma.order.findUnique({ where: { id: current.id }, include: orderInclude })
  ensure(updated, 404, '订单不存在')
  await logOperation(prisma, { operatorId: req.user!.id, action: 'ASSIGN', entityType: 'ORDER', entityId: current.id, detail: { staffId: staff.id } })
  notifyChange([current.staffId, staff.id])
  res.json({ item: orderView(updated) })
}))
router.post('/orders/:id/lock', ...orderLock, asyncHandler(async (req, res) => {
  const current = await prisma.order.findUnique({ where: { id: getParam(req) } })
  ensure(current, 404, '订单不存在')
  ensure(!([OrderStatus.COMPLETED, OrderStatus.CANCELLED] as OrderStatus[]).includes(current.status), 400, '当前状态不能锁定')
  const updated = await prisma.order.update({ where: { id: current.id }, data: { isLocked: true, lockedAt: new Date(), lockedById: req.user!.id }, include: orderInclude })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'LOCK', entityType: 'ORDER', entityId: current.id })
  notifyChange([current.staffId])
  res.json({ item: orderView(updated) })
}))
router.post('/orders/:id/unlock', ...orderLock, asyncHandler(async (req, res) => {
  const updated = await prisma.order.update({ where: { id: getParam(req) }, data: { isLocked: false, lockedAt: null, lockedById: null }, include: orderInclude })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UNLOCK', entityType: 'ORDER', entityId: updated.id })
  notifyChange([updated.staffId])
  res.json({ item: orderView(updated) })
}))
router.post('/orders/:id/cancel', ...orderCancel, asyncHandler(async (req, res) => {
  const current = await prisma.order.findUnique({ where: { id: getParam(req) } })
  ensure(current, 404, '订单不存在')
  ensure(!current.isLocked || req.user!.role === UserRole.SUPER_ADMIN, 409, '订单已锁定，仅超级管理员可以取消')
  ensure(current.status !== OrderStatus.COMPLETED && current.status !== OrderStatus.AFTER_SALE, 400, '已完成或售后中的订单不能取消')
  const updated = await prisma.order.update({ where: { id: current.id }, data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() }, include: orderInclude })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CANCEL', entityType: 'ORDER', entityId: current.id })
  notifyChange([current.staffId])
  res.json({ item: orderView(updated) })
}))
router.post('/orders/:id/claim', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const staff = await getStaff(staffId)
  ensure(staff.accepting === StaffAccepting.ACCEPTING, 409, '管理员已暂停您的接单权限，如需恢复请联系管理员。')
  ensure(staff.selfAccepting === StaffAccepting.ACCEPTING, 409, '员工当前暂时不接单')
  ensure(staff.tier?.canAcceptOrders !== false, 409, '当前员工层级无权接单')
  const current = await prisma.order.findUnique({ where: { id: getParam(req) } })
  ensure(current, 404, '订单不存在')
  if (current.staffId === staffId && current.status === OrderStatus.PENDING) {
    const assigned = await prisma.order.findUnique({ where: { id: current.id }, include: orderInclude })
    ensure(assigned, 404, '订单不存在')
    res.json({ item: orderView(assigned, true), idempotent: true })
    return
  }
  ensure(!current.staffId && current.status === OrderStatus.PENDING_ASSIGNMENT, 409, '该订单已被其他员工接取')
  ensure(!current.isLocked, 409, '该订单已锁定，暂不能接取')
  ensure(current.status === OrderStatus.PENDING_ASSIGNMENT, 409, '当前订单不可接取')
  if (current.requiredTierId) {
    const required = await findTier(current.requiredTierId)
    ensure(required && staff.tier && staff.tier.level >= required.level, 403, '当前员工层级不满足接单要求')
  }
  const claimed = await prisma.order.updateMany({ where: { id: current.id, staffId: null, status: OrderStatus.PENDING_ASSIGNMENT, isLocked: false }, data: { staffId, assignedAt: new Date(), status: OrderStatus.PENDING } })
  if (claimed.count !== 1) throw new HttpError(409, '该订单已被其他员工接取')
  const updated = await prisma.order.findUnique({ where: { id: current.id }, include: orderInclude })
  ensure(updated, 404, '订单不存在')
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CLAIM', entityType: 'ORDER', entityId: current.id, detail: { staffId } })
  notifyChange([staffId])
  res.json({ item: orderView(updated, true) })
}))
router.post('/orders/:id/start', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const current = await prisma.order.findFirst({ where: { id: getParam(req), staffId } })
  ensure(current, 404, '订单不存在或无权操作')
  ensure(!current.isLocked, 409, '订单已锁定，暂不能开始')
  ensure(current.status === OrderStatus.PENDING, 400, '只有待处理订单可以开始')
  const changed = await prisma.order.updateMany({ where: { id: current.id, staffId, status: OrderStatus.PENDING }, data: { status: OrderStatus.IN_PROGRESS, startedAt: new Date() } })
  ensure(changed.count === 1, 409, '订单状态已变化，请刷新后重试')
  await prisma.staffProfile.update({ where: { id: staffId }, data: { status: StaffStatus.BUSY } })
  const updated = await prisma.order.findUnique({ where: { id: current.id }, include: orderInclude })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'START', entityType: 'ORDER', entityId: current.id })
  notifyChange([staffId])
  res.json({ item: orderView(updated!, true) })
}))
router.post('/orders/:id/complete', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const current = await prisma.order.findFirst({ where: { id: getParam(req), staffId } })
  ensure(current, 404, '订单不存在或无权操作')
  ensure(!current.isLocked, 409, '订单已锁定，暂不能完成')
  const completed = await prisma.$transaction((tx) => completeOrderWithBalance(tx, current.id, req.user!.id))
  ensure(completed, 404, '订单不存在')
  notifyChange([staffId])
  res.json({ item: orderView(completed, true), idempotent: current.status === OrderStatus.COMPLETED })
}))
router.get('/workbench/available-orders', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const staff = await getStaff(staffId, false)
  if (staff.accountStatus !== StaffAccountStatus.NORMAL || staff.accepting !== StaffAccepting.ACCEPTING || staff.selfAccepting !== StaffAccepting.ACCEPTING || staff.tier?.isEnabled === false || staff.tier?.canAcceptOrders === false) {
    res.json({ items: [], accepting: staff.accepting, selfAccepting: staff.selfAccepting, tier: staff.tier })
    return
  }
  const where: Prisma.OrderWhereInput = { status: OrderStatus.PENDING_ASSIGNMENT, staffId: null, isLocked: false, NOT: { status: OrderStatus.PENDING_PAYMENT } }
  where.OR = staff.tierId
    ? [{ requiredTierId: null }, { requiredTier: { level: { lte: staff.tier?.level ?? 0 } } }]
    : [{ requiredTierId: null }]
  const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'asc' }, take: 100, include: orderInclude })
  res.json({ items: orders.map((item) => orderView(item, true)), accepting: staff.accepting, selfAccepting: staff.selfAccepting, tier: staff.tier })
}))

*/
router.get('/stats', ...authenticated, asyncHandler(async (req, res) => {
  const staffId = req.user!.role === UserRole.STAFF ? req.user!.staffProfileId : undefined
  ensure(staffId || (isAdminRole(req.user!.role) && hasPermission(req.user!, 'stats.view')), 403, '没有权限查看统计')
  const from = startOfMonth()
  const orders = await prisma.order.findMany({
    where: {
      ...(staffId ? { assignments: { some: { staffId, assignmentStatus: { in: [...participatingAssignmentStatuses] } } } } : {}),
      createdAt: { gte: from, lte: endOfDay() },
    },
    include: { assignments: { select: { actualEarningCents: true, earningAdjustments: { select: { earningDeltaCents: true } } } } },
  })
  res.json({ item: getStatsForOrders(orders) })
}))

router.get('/stats/overview', ...statsRead, asyncHandler(async (_req, res) => {
  const todayStart = startOfDay()
  const todayEnd = endOfDay()
  const monthStart = startOfMonth()
  const sixMonthsAgo = addMonths(monthStart, -5)
  const statsInclude = { assignments: { select: { actualEarningCents: true, earningAdjustments: { select: { earningDeltaCents: true } } } }, adjustments: { select: { orderAmountDeltaCents: true } } } as const
  const [todayOrders, monthOrders, dailyOrders, monthlyOrders, staff] = await Promise.all([
    prisma.order.findMany({ where: { createdAt: { gte: todayStart, lte: todayEnd } }, include: statsInclude }),
    prisma.order.findMany({ where: { createdAt: { gte: monthStart, lte: todayEnd } }, include: statsInclude }),
    prisma.order.findMany({ where: { createdAt: { gte: startOfDay(addDays(new Date(), -6)), lte: todayEnd } }, include: statsInclude }),
    prisma.order.findMany({ where: { createdAt: { gte: sixMonthsAgo, lte: todayEnd } }, include: statsInclude }),
    prisma.staffProfile.findMany({
      include: {
        orderAssignments: {
          where: { staffId: { not: null } },
          select: { orderId: true, assignmentStatus: true, expectedEarningCents: true, actualEarningCents: true, claimedAt: true, earningAdjustments: { select: { earningDeltaCents: true } }, order: { select: { status: true, amountCents: true, createdAt: true, completedAt: true, adjustments: { select: { orderAmountDeltaCents: true } } } } },
        },
        tier: true,
      },
    }),
  ])
  const dailyStats = Array.from({ length: 7 }, (_, index) => {
    const date = startOfDay(addDays(new Date(), index - 6))
    const key = dateKey(date)
    return { date: key, label: String(date.getMonth() + 1) + '/' + String(date.getDate()), ...getStatsForOrders(dailyOrders.filter((item) => dateKey(item.createdAt) === key)) }
  })
  const monthlyStats = Array.from({ length: 6 }, (_, index) => {
    const date = addMonths(monthStart, index - 5)
    const key = monthKey(date)
    return { month: key, label: String(date.getFullYear()) + '年' + String(date.getMonth() + 1) + '月', ...getStatsForOrders(monthlyOrders.filter((item) => monthKey(item.createdAt) === key)) }
  })
  const byStaff = staff.map((profile) => {
    const monthly = profile.orderAssignments.filter((item) => item.order.createdAt >= monthStart && item.assignmentStatus !== OrderStaffAssignmentStatus.EXITED)
    const orderIds = new Set(monthly.map((item) => item.orderId))
    const completedOrderIds = new Set(monthly.filter((item) => item.assignmentStatus === OrderStaffAssignmentStatus.COMPLETED).map((item) => item.orderId))
    return {
      id: profile.id,
      name: profile.name,
      status: profile.status,
      orderCount: orderIds.size,
      completedOrderCount: completedOrderIds.size,
      revenueCents: sumBy(monthly.filter((item) => orderRevenue(item.order.status)), (item) => orderNetAmount(item.order)),
      staffEarningsCents: sumBy(monthly.filter((item) => item.assignmentStatus === OrderStaffAssignmentStatus.COMPLETED), currentActualEarning),
    }
  })
  res.json({ today: getStatsForOrders(todayOrders), month: getStatsForOrders(monthOrders), dailyStats, monthlyStats, byStaff })
}))

const staffSummary = async (staffId: string) => {
  const todayStart = startOfDay()
  const todayEnd = endOfDay()
  const monthStart = startOfMonth()
  const [profile, assignments, settledAggregate, incidentCounts, welcome] = await Promise.all([
    prisma.staffProfile.findUnique({ where: { id: staffId }, include: { tier: true } }),
    prisma.orderStaffAssignment.findMany({ where: { staffId }, include: { order: true, earningAdjustments: true } }),
    prisma.settlementRecord.aggregate({ where: { staffId }, _sum: { amountCents: true } }),
    prisma.staffIncident.groupBy({ by: ['type'], where: { staffId }, _count: { _all: true } }),
    getWorkbenchWelcome(),
  ])
  ensure(profile, 404, '员工档案不存在')
  const visibleAssignments = assignments.filter((item) => participatingAssignmentStatuses.includes(item.assignmentStatus as typeof participatingAssignmentStatuses[number]))
  const activeAssignments = visibleAssignments.filter((item) => capacityAssignmentStatuses.includes(item.assignmentStatus as typeof capacityAssignmentStatuses[number]))
  const todayAssignments = activeAssignments.filter((item) => item.order.createdAt >= todayStart && item.order.createdAt <= todayEnd)
  const todayCompleted = visibleAssignments.filter((item) => item.assignmentStatus === OrderStaffAssignmentStatus.COMPLETED && item.order.completedAt && item.order.completedAt >= todayStart && item.order.completedAt <= todayEnd)
  const monthCompleted = visibleAssignments.filter((item) => item.assignmentStatus === OrderStaffAssignmentStatus.COMPLETED && item.order.completedAt && item.order.completedAt >= monthStart && item.order.completedAt <= todayEnd)
  const allCompleted = visibleAssignments.filter((item) => item.assignmentStatus === OrderStaffAssignmentStatus.COMPLETED)
  const availableCount = profile.accepting === StaffAccepting.ACCEPTING && profile.selfAccepting === StaffAccepting.ACCEPTING && profile.tier?.isEnabled !== false && profile.tier?.canAcceptOrders !== false
    ? await prisma.order.count({
        where: {
          status: { in: [OrderStatus.PENDING_ASSIGNMENT, OrderStatus.IN_PROGRESS] },
          isLocked: false,
          assignments: { some: { assignmentStatus: OrderStaffAssignmentStatus.OPEN } },
          NOT: { assignments: { some: { staffId, assignmentStatus: { in: [...capacityAssignmentStatuses] } } } },
          OR: profile.tierId ? [{ requiredTierId: null }, { requiredTier: { level: { lte: profile.tier?.level ?? 0 } } }] : [{ requiredTierId: null }],
        },
      })
    : 0
  const netEarning = currentActualEarning
  const totalEarningsCents = sumBy(allCompleted, netEarning)
  const settledCents = settledAggregate._sum.amountCents ?? 0
  return {
    profile: { id: profile.id, name: profile.name, status: profile.status, presence: profile.presence, accepting: profile.accepting, selfAccepting: profile.selfAccepting, accountStatus: profile.accountStatus, tier: profile.tier },
    welcome: { title: renderWorkbenchWelcome(welcome.titleTemplate, profile.name), subtitle: welcome.subtitle },
    todayOrderCount: new Set(todayAssignments.map((item) => item.orderId)).size + new Set(todayCompleted.map((item) => item.orderId)).size,
    todayCompletedCount: new Set(todayCompleted.map((item) => item.orderId)).size,
    todayPendingCount: new Set(todayAssignments.filter((item) => ([OrderStatus.PENDING_ASSIGNMENT, OrderStatus.PENDING] as OrderStatus[]).includes(item.order.status)).map((item) => item.orderId)).size,
    todayInProgressCount: new Set(todayAssignments.filter((item) => ([OrderStatus.IN_PROGRESS, OrderStatus.PENDING_COMPLETION_REVIEW] as OrderStatus[]).includes(item.order.status)).map((item) => item.orderId)).size,
    todayEstimatedCents: sumBy(todayAssignments.filter((item) => !orderRevenue(item.order.status)), (item) => item.expectedEarningCents),
    todayEarningsCents: sumBy(todayCompleted, netEarning),
    monthCompletedCount: new Set(monthCompleted.map((item) => item.orderId)).size,
    monthEarningsCents: sumBy(monthCompleted, netEarning),
    availableOrderCount: availableCount,
    assignedOrderCount: new Set(assignments.map((item) => item.orderId)).size,
    totalCompletedCount: new Set(allCompleted.map((item) => item.orderId)).size,
    totalEarningsCents,
    settledCents,
    pendingSettlementCents: Math.max(totalEarningsCents - settledCents, 0),
    overSettledCents: Math.max(settledCents - totalEarningsCents, 0),
    incidentCounts: Object.fromEntries(incidentCounts.map((item) => [item.type, item._count._all])),
  }
}

router.get('/workbench/summary', ...staffOnly, asyncHandler(async (req, res) => {
  ensure(req.user!.staffProfileId, 403, '员工档案不存在')
  res.json(await staffSummary(req.user!.staffProfileId))
}))

router.get('/workbench/stats', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const summary = await staffSummary(staffId)
  const start = addMonths(startOfMonth(), -5)
  const assignments = await prisma.orderStaffAssignment.findMany({
    where: { staffId, assignmentStatus: OrderStaffAssignmentStatus.COMPLETED, order: { completedAt: { gte: start, lte: endOfDay() } } },
    select: { orderId: true, actualEarningCents: true, earningAdjustments: true, order: { select: { completedAt: true } } },
  })
  const history = Array.from({ length: 6 }, (_, index) => {
    const date = addMonths(startOfMonth(), index - 5)
    const key = monthKey(date)
    const items = assignments.filter((item) => item.order.completedAt && monthKey(item.order.completedAt) === key)
    return { month: key, label: String(date.getFullYear()) + '年' + String(date.getMonth() + 1) + '月', completedOrderCount: new Set(items.map((item) => item.orderId)).size, staffEarningsCents: sumBy(items, currentActualEarning) }
  })
  const selected = req.query.startDate !== undefined || req.query.endDate !== undefined || req.query.period !== undefined
    ? await staffStatistics(staffId, req.query) : null
  res.json({ item: { ...summary, history, selected: selected ? { range: selected.range, ...selected.summary } : null } })
}))

router.get('/workbench/stats/details', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const result = await staffStatistics(staffId, req.query)
  res.json({ item: result })
}))

router.get('/workbench/aftersales', ...staffOnly, asyncHandler(async (req, res) => {
  const staffId = req.user!.staffProfileId
  ensure(staffId, 403, '员工档案不存在')
  const items = await prisma.afterSaleCase.findMany({
    where: { order: { assignments: { some: { staffId, assignmentStatus: { in: [...participatingAssignmentStatuses] } } } } },
    orderBy: { createdAt: 'desc' },
    include: { order: { include: orderInclude }, supplementaryOrder: { select: { id: true, orderNo: true } }, messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { author: { select: { username: true, role: true, staffProfile: { select: { name: true } } } } } } },
  })
  res.json({ items: items.map((item) => ({ ...item, order: orderView(item.order, true, staffId) })) })
}))

/* Legacy single-assignee statistics and workbench summaries.
router.get('/stats-legacy', ...authenticated, asyncHandler(async (req, res) => {
  const staffId = req.user!.role === UserRole.STAFF ? req.user!.staffProfileId : undefined
  ensure(staffId || (isAdminRole(req.user!.role) && hasPermission(req.user!, 'stats.view')), 403, '没有权限查看统计')
  const from = startOfMonth()
  const orders = await prisma.order.findMany({ where: { ...(staffId ? { staffId } : {}), createdAt: { gte: from, lte: endOfDay() } } })
  res.json({ item: getStatsForOrders(orders) })
}))
router.get('/stats/overview', ...statsRead, asyncHandler(async (_req, res) => {
  const todayStart = startOfDay()
  const todayEnd = endOfDay()
  const monthStart = startOfMonth()
  const sixMonthsAgo = addMonths(monthStart, -5)
  const [todayOrders, monthOrders, dailyOrders, monthlyOrders, staff] = await Promise.all([
    prisma.order.findMany({ where: { createdAt: { gte: todayStart, lte: todayEnd } } }),
    prisma.order.findMany({ where: { createdAt: { gte: monthStart, lte: todayEnd } } }),
    prisma.order.findMany({ where: { createdAt: { gte: startOfDay(addDays(new Date(), -6)), lte: todayEnd } } }),
    prisma.order.findMany({ where: { createdAt: { gte: sixMonthsAgo, lte: todayEnd } } }),
    prisma.staffProfile.findMany({ include: { orders: { select: { status: true, amountCents: true, staffAmountCents: true, createdAt: true } }, tier: true } }),
  ])
  const dailyStats = Array.from({ length: 7 }, (_, index) => {
    const date = startOfDay(addDays(new Date(), index - 6))
    const key = dateKey(date)
    return { date: key, label: String(date.getMonth() + 1) + '/' + String(date.getDate()), ...getStatsForOrders(dailyOrders.filter((item) => dateKey(item.createdAt) === key)) }
  })
  const monthlyStats = Array.from({ length: 6 }, (_, index) => {
    const date = addMonths(monthStart, index - 5)
    const key = monthKey(date)
    return { month: key, label: String(date.getFullYear()) + '年' + String(date.getMonth() + 1) + '月', ...getStatsForOrders(monthlyOrders.filter((item) => monthKey(item.createdAt) === key)) }
  })
  const byStaff = staff.map((profile) => {
    const monthly = profile.orders.filter((item) => item.createdAt >= monthStart && item.status !== OrderStatus.CANCELLED)
    return { id: profile.id, name: profile.name, status: profile.status, orderCount: monthly.length, completedOrderCount: monthly.filter((item) => item.status === OrderStatus.COMPLETED).length, revenueCents: sumBy(monthly.filter((item) => orderRevenue(item.status)), (item) => item.amountCents), staffEarningsCents: sumBy(monthly.filter((item) => item.status === OrderStatus.COMPLETED), (item) => item.staffAmountCents) }
  })
  res.json({ today: getStatsForOrders(todayOrders), month: getStatsForOrders(monthOrders), dailyStats, monthlyStats, byStaff })
}))

const staffSummary = async (staffId: string) => {
  const todayStart = startOfDay()
  const todayEnd = endOfDay()
  const monthStart = startOfMonth()
  const [profile, todayOrders, monthOrders, assignedCount, completedAggregate, settledAggregate, incidentCounts] = await Promise.all([
    prisma.staffProfile.findUnique({ where: { id: staffId }, include: { tier: true } }),
    prisma.order.findMany({ where: { staffId, createdAt: { gte: todayStart, lte: todayEnd } } }),
    prisma.order.findMany({ where: { staffId, createdAt: { gte: monthStart, lte: todayEnd } } }),
    prisma.order.count({ where: { staffId } }),
    prisma.order.aggregate({ where: { staffId, status: OrderStatus.COMPLETED }, _count: { _all: true }, _sum: { staffAmountCents: true } }),
    prisma.settlementRecord.aggregate({ where: { staffId }, _sum: { amountCents: true } }),
    prisma.staffIncident.groupBy({ by: ['type'], where: { staffId }, _count: { _all: true } }),
  ])
  ensure(profile, 404, '员工档案不存在')
  const availableCount = profile.accepting === StaffAccepting.ACCEPTING && profile.tier?.isEnabled !== false && profile.tier?.canAcceptOrders !== false
    ? await prisma.order.count({ where: { staffId: null, status: OrderStatus.PENDING_ASSIGNMENT, isLocked: false, OR: profile.tierId ? [{ requiredTierId: null }, { requiredTier: { level: { lte: profile.tier?.level ?? 0 } } }] : [{ requiredTierId: null }] } })
    : 0
  return {
    profile: { id: profile.id, name: profile.name, status: profile.status, presence: profile.presence, accepting: profile.accepting, selfAccepting: profile.selfAccepting, accountStatus: profile.accountStatus, tier: profile.tier },
    todayOrderCount: todayOrders.length,
    todayCompletedCount: todayOrders.filter((item) => item.status === OrderStatus.COMPLETED).length,
    todayPendingCount: todayOrders.filter((item) => item.status === OrderStatus.PENDING).length,
    todayInProgressCount: todayOrders.filter((item) => item.status === OrderStatus.IN_PROGRESS).length,
    todayEstimatedCents: sumBy(todayOrders.filter((item) => item.status !== OrderStatus.COMPLETED && item.status !== OrderStatus.CANCELLED), (item) => item.staffAmountCents),
    todayEarningsCents: sumBy(todayOrders.filter((item) => item.status === OrderStatus.COMPLETED), (item) => item.staffAmountCents),
    monthCompletedCount: monthOrders.filter((item) => item.status === OrderStatus.COMPLETED).length,
    monthEarningsCents: sumBy(monthOrders.filter((item) => item.status === OrderStatus.COMPLETED), (item) => item.staffAmountCents),
    availableOrderCount: profile.accepting === StaffAccepting.ACCEPTING && profile.tier?.isEnabled !== false && profile.tier?.canAcceptOrders !== false ? availableCount : 0,
    assignedOrderCount: assignedCount,
    totalCompletedCount: completedAggregate._count._all,
    totalEarningsCents: completedAggregate._sum.staffAmountCents ?? 0,
    settledCents: settledAggregate._sum.amountCents ?? 0,
    pendingSettlementCents: Math.max((completedAggregate._sum.staffAmountCents ?? 0) - (settledAggregate._sum.amountCents ?? 0), 0),
    incidentCounts: Object.fromEntries(incidentCounts.map((item) => [item.type, item._count._all])),
  }
}
router.get('/workbench/summary', ...staffOnly, asyncHandler(async (req, res) => {
  ensure(req.user!.staffProfileId, 403, '员工档案不存在')
  res.json(await staffSummary(req.user!.staffProfileId))
}))
router.get('/workbench/stats', ...staffOnly, asyncHandler(async (req, res) => {
  ensure(req.user!.staffProfileId, 403, '员工档案不存在')
  const summary = await staffSummary(req.user!.staffProfileId)
  const start = addMonths(startOfMonth(), -5)
  const orders = await prisma.order.findMany({ where: { staffId: req.user!.staffProfileId, status: OrderStatus.COMPLETED, completedAt: { gte: start, lte: endOfDay() } }, select: { staffAmountCents: true, completedAt: true } })
  const history = Array.from({ length: 6 }, (_, index) => {
    const date = addMonths(startOfMonth(), index - 5)
    const key = monthKey(date)
    const items = orders.filter((item) => item.completedAt && monthKey(item.completedAt) === key)
    return { month: key, label: String(date.getFullYear()) + '年' + String(date.getMonth() + 1) + '月', completedOrderCount: items.length, staffEarningsCents: sumBy(items, (item) => item.staffAmountCents) }
  })
  const selected = req.query.startDate !== undefined || req.query.endDate !== undefined || req.query.period !== undefined
    ? await staffStatistics(staffId, req.query) : null
  res.json({ item: { ...summary, history, selected: selected ? { range: selected.range, ...selected.summary } : null } })
}))
router.get('/workbench/aftersales', ...staffOnly, asyncHandler(async (req, res) => {
  ensure(req.user!.staffProfileId, 403, '员工档案不存在')
  const items = await prisma.afterSaleCase.findMany({ where: { staffId: req.user!.staffProfileId }, orderBy: { createdAt: 'desc' }, include: { order: { include: orderInclude }, supplementaryOrder: { select: { id: true, orderNo: true } }, messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { author: { select: { username: true, role: true, staffProfile: { select: { name: true } } } } } } } })
  res.json({ items: items.map((item) => ({ ...item, order: orderView(item.order, true) })) })
}))

*/
router.get('/finance/staff-settlement-summary', ...financeRead, asyncHandler(async (req, res) => {
  res.json({ item: await financeStaffSettlements(req.query as Record<string, unknown>) })
}))

router.get('/finance/overview', ...financeRead, asyncHandler(async (req, res) => {
  const dateRange = parseDateRange(req.query.startDate, req.query.endDate)
  const dateFilter = dateRange ? { gte: dateRange.start, lte: dateRange.end } : undefined
  const [completed, staff, orderAdjustments, staffAdjustments, afterSales, allCompletedStaff, allStaffAdjustments, allSettlements, recharges, bonus, consumption, legacyConsumption] = await Promise.all([
    prisma.order.aggregate({ where: { status: { in: [...finalizedOrderStatuses] }, ...(dateFilter ? { completedAt: dateFilter } : {}) }, _count: { _all: true }, _sum: { amountCents: true } }),
    prisma.orderStaffAssignment.aggregate({ where: { assignmentStatus: OrderStaffAssignmentStatus.COMPLETED, ...(dateFilter ? { order: { completedAt: dateFilter } } : {}) }, _sum: { actualEarningCents: true } }),
    prisma.orderAdjustment.aggregate({ where: dateFilter ? { createdAt: dateFilter } : undefined, _sum: { orderAmountDeltaCents: true } }),
    prisma.staffEarningAdjustment.aggregate({ where: { assignment: { assignmentStatus: OrderStaffAssignmentStatus.COMPLETED, ...(dateFilter ? { order: { completedAt: dateFilter } } : {}) } }, _sum: { earningDeltaCents: true } }),
    prisma.afterSaleCase.aggregate({ where: { status: AfterSaleStatus.COMPLETED, ...(dateFilter ? { handledAt: dateFilter } : {}) }, _sum: { compensationCents: true, refundCents: true } }),
    prisma.orderStaffAssignment.aggregate({ where: { assignmentStatus: OrderStaffAssignmentStatus.COMPLETED }, _sum: { actualEarningCents: true } }),
    prisma.staffEarningAdjustment.aggregate({ _sum: { earningDeltaCents: true } }),
    prisma.settlementRecord.aggregate({ _sum: { amountCents: true } }),
    prisma.rechargeRecord.aggregate({ where: dateFilter ? { createdAt: dateFilter } : undefined, _sum: { principalAmountCents: true } }),
    prisma.rechargeRecord.aggregate({ where: dateFilter ? { createdAt: dateFilter } : undefined, _sum: { bonusAmountCents: true } }),
    prisma.orderConsumption.findMany({ where: dateFilter ? { createdAt: dateFilter } : undefined, select: { orderId: true, totalAmountCents: true } }),
    prisma.consumptionRecord.findMany({ where: dateFilter ? { createdAt: dateFilter } : undefined, select: { orderId: true, amountCents: true } }),
  ])
  const revenueCents = (completed._sum.amountCents ?? 0) + (orderAdjustments._sum.orderAmountDeltaCents ?? 0)
  const staffEarningsCents = currentActualEarning({ actualEarningCents: staff._sum.actualEarningCents ?? 0, earningAdjustments: [{ earningDeltaCents: staffAdjustments._sum.earningDeltaCents ?? 0 }] })
  const afterSaleExpenseCents = (afterSales._sum.compensationCents ?? 0) + (afterSales._sum.refundCents ?? 0)
  const totalExpenseCents = staffEarningsCents + afterSaleExpenseCents
  const allStaffEarningsCents = currentActualEarning({ actualEarningCents: allCompletedStaff._sum.actualEarningCents ?? 0, earningAdjustments: [{ earningDeltaCents: allStaffAdjustments._sum.earningDeltaCents ?? 0 }] })
  const settledStaffEarningsCents = allSettlements._sum.amountCents ?? 0
  const newConsumptionOrderIds = new Set(consumption.map((item) => item.orderId))
  const consumptionCents = sumBy(consumption, (item) => item.totalAmountCents) + sumBy(legacyConsumption.filter((item) => !newConsumptionOrderIds.has(item.orderId)), (item) => item.amountCents)
  res.json({ item: { completedOrderCount: completed._count._all, revenueCents, staffEarningsCents, afterSaleExpenseCents, totalExpenseCents, profitCents: revenueCents - totalExpenseCents, pendingStaffEarningsCents: Math.max(allStaffEarningsCents - settledStaffEarningsCents, 0), overSettledCents: Math.max(settledStaffEarningsCents - allStaffEarningsCents, 0), principalRechargeCents: recharges._sum.principalAmountCents ?? 0, bonusRechargeCents: bonus._sum.bonusAmountCents ?? 0, consumptionCents, settlementMode: '线下人工结算' } })
}))
router.get('/finance/settlement-options', ...settlementManage, asyncHandler(async (_req, res) => {
  const staff = await prisma.staffProfile.findMany({ where: { accountStatus: { not: StaffAccountStatus.RETIRED } }, orderBy: { name: 'asc' }, select: { id: true, name: true, accountStatus: true } })
  const items = await Promise.all(staff.map(async (item) => ({ ...item, ...await currentStaffEarnings(prisma, item.id) })))
  res.json({ items })
}))
router.get('/finance/settlements', ...financeRead, asyncHandler(async (req, res) => {
  const dateRange = parseDateRange(req.query.startDate, req.query.endDate)
  const dateFilter = dateRange ? { gte: dateRange.start, lte: dateRange.end } : undefined
  const items = await prisma.settlementRecord.findMany({ where: dateFilter ? { settledAt: dateFilter } : undefined, orderBy: { settledAt: 'desc' }, take: 200, include: { staff: { select: { name: true } }, operator: { select: { username: true } } } })
  res.json({ items })
}))
router.get('/finance/export', ...financeRead, asyncHandler(async (req, res) => {
  const dateRange = parseDateRange(req.query.startDate, req.query.endDate)
  const dateFilter = dateRange ? { gte: dateRange.start, lte: dateRange.end } : undefined
  const [completedOrders, fundTransactions, settlements, afterSales] = await Promise.all([
    prisma.order.findMany({ where: { status: { in: [...finalizedOrderStatuses] }, ...(dateFilter ? { completedAt: dateFilter } : {}) }, orderBy: { completedAt: 'desc' }, include: { customer: { select: { customerCode: true } }, assignments: { where: { assignmentStatus: OrderStaffAssignmentStatus.COMPLETED }, include: { staff: { select: { name: true } } } } } }),
    prisma.fundTransaction.findMany({ where: dateFilter ? { createdAt: dateFilter } : undefined, orderBy: { createdAt: 'desc' }, take: 5000, include: { customer: { select: { customerCode: true } }, order: { select: { orderNo: true } }, operator: { select: { username: true } } } }),
    prisma.settlementRecord.findMany({ where: dateFilter ? { settledAt: dateFilter } : undefined, orderBy: { settledAt: 'desc' }, take: 200, include: { staff: { select: { name: true } }, operator: { select: { username: true } } } }),
    prisma.afterSaleCase.findMany({ where: { status: AfterSaleStatus.COMPLETED, ...(dateFilter ? { handledAt: dateFilter } : {}) }, orderBy: { handledAt: 'desc' }, include: { customer: { select: { customerCode: true } }, order: { select: { orderNo: true } } } }),
  ])
  const workbook = new ExcelJS.Workbook()
  const summary = workbook.addWorksheet('经营摘要')
  summary.columns = [{ header: '项目', key: 'label', width: 26 }, { header: '金额（元）', key: 'amount', width: 18 }, { header: '说明', key: 'note', width: 48 }]
  const adjustmentRange = dateRange ? { createdAt: { gte: dateRange.start, lte: dateRange.end } } : {}
  const [orderAdjustmentAggregate, staffAdjustmentAggregate] = await Promise.all([
    prisma.orderAdjustment.aggregate({ where: adjustmentRange, _sum: { orderAmountDeltaCents: true } }),
    prisma.staffEarningAdjustment.aggregate({ where: { assignment: { assignmentStatus: OrderStaffAssignmentStatus.COMPLETED, ...(dateFilter ? { order: { completedAt: dateFilter } } : {}) } }, _sum: { earningDeltaCents: true } }),
  ])
  const revenueCents = sumBy(completedOrders, (item) => item.amountCents) + (orderAdjustmentAggregate._sum.orderAmountDeltaCents ?? 0)
  const staffEarningsCents = currentActualEarning({ actualEarningCents: sumBy(completedOrders, (item) => sumBy(item.assignments, (assignment) => assignment.actualEarningCents)), earningAdjustments: [{ earningDeltaCents: staffAdjustmentAggregate._sum.earningDeltaCents ?? 0 }] })
  const afterSaleExpenseCents = sumBy(afterSales, (item) => item.compensationCents + item.refundCents)
  const totalExpenseCents = staffEarningsCents + afterSaleExpenseCents
  summary.addRows([
    { label: '已完成订单收入', amount: (revenueCents / 100).toFixed(2), note: '系统经营口径' },
    { label: '总支出', amount: (totalExpenseCents / 100).toFixed(2), note: '员工实际应得 + 售后费用' },
    { label: '员工实际应得', amount: (staffEarningsCents / 100).toFixed(2), note: '仅统计已完成订单' },
    { label: '售后费用', amount: (afterSaleExpenseCents / 100).toFixed(2), note: '赔付与退款登记' },
    { label: '经营利润', amount: ((revenueCents - totalExpenseCents) / 100).toFixed(2), note: '系统经营口径：收入 - 总支出' },
  ])
  summary.getRow(1).font = { bold: true }
  const funds = workbook.addWorksheet('资金流水')
  funds.columns = [{ header: '客户', key: 'customer', width: 18 }, { header: '类型', key: 'type', width: 22 }, { header: '金额（元）', key: 'amount', width: 16 }, { header: '关联订单', key: 'orderNo', width: 22 }, { header: '操作人', key: 'operator', width: 16 }, { header: '时间', key: 'createdAt', width: 22 }, { header: '备注', key: 'note', width: 36 }]
  const fundLabels: Record<FundTransactionType, string> = { PRINCIPAL_RECHARGE: '本金充值', BONUS_RECHARGE: '活动赠金', PRINCIPAL_CONSUMPTION: '本金消费', BONUS_CONSUMPTION: '赠金消费', ADJUSTMENT: '账户调整', AFTER_SALE: '售后补偿', ORDER_ADJUSTMENT: '订单净额调整' }
  funds.addRows(fundTransactions.map((item) => ({ customer: item.customer.customerCode, type: fundLabels[item.type], amount: (item.amountCents / 100).toFixed(2), orderNo: item.order?.orderNo || '', operator: item.operator?.username || '系统', createdAt: item.createdAt.toLocaleString('zh-CN'), note: item.note || '' })))
  funds.getRow(1).font = { bold: true }
  const settlementSheet = workbook.addWorksheet('员工结算')
  settlementSheet.columns = [{ header: '员工', key: 'staff', width: 18 }, { header: '金额（元）', key: 'amount', width: 16 }, { header: '结算方式', key: 'method', width: 20 }, { header: '操作人', key: 'operator', width: 16 }, { header: '时间', key: 'createdAt', width: 22 }, { header: '备注', key: 'note', width: 36 }]
  settlementSheet.addRows(settlements.map((item) => ({ staff: item.staff.name, amount: (item.amountCents / 100).toFixed(2), method: item.settlementMethod, operator: item.operator.username, createdAt: item.settledAt.toLocaleString('zh-CN'), note: item.note || '' })))
  settlementSheet.getRow(1).font = { bold: true }
  const afterSaleSheet = workbook.addWorksheet('售后费用')
  afterSaleSheet.columns = [{ header: '售后编号', key: 'caseNo', width: 20 }, { header: '订单号', key: 'orderNo', width: 22 }, { header: '客户', key: 'customer', width: 18 }, { header: '赔付（元）', key: 'compensation', width: 16 }, { header: '退款登记（元）', key: 'refund', width: 18 }, { header: '处理时间', key: 'handledAt', width: 22 }, { header: '处理备注', key: 'note', width: 36 }]
  afterSaleSheet.addRows(afterSales.map((item) => ({ caseNo: item.caseNo, orderNo: item.order.orderNo, customer: item.customer.customerCode, compensation: (item.compensationCents / 100).toFixed(2), refund: (item.refundCents / 100).toFixed(2), handledAt: item.handledAt?.toLocaleString('zh-CN') || '', note: item.handlingNote || '' })))
  afterSaleSheet.getRow(1).font = { bold: true }
  const buffer = await workbook.xlsx.writeBuffer()
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''club-finance-${dateKey(new Date())}.xlsx`)
  res.send(Buffer.from(buffer as unknown as Uint8Array))
}))

router.get('/after-sales', ...afterSaleRead, asyncHandler(async (req, res) => {
  const where: Prisma.AfterSaleCaseWhereInput = hasPermission(req.user!, 'aftersales.manage') ? {} : { OR: [{ createdById: req.user!.id }, { order: { createdById: req.user!.id } }, { orderId: { in: (await prisma.operationLog.findMany({ where: { operatorId: req.user!.id, entityType: 'ORDER', action: 'ASSIGN' }, select: { entityId: true }, distinct: ['entityId'] })).flatMap(l => l.entityId ? [l.entityId] : []) } }] }
  if (typeof req.query.status === 'string' && Object.values(AfterSaleStatus).includes(req.query.status as AfterSaleStatus)) where.status = req.query.status as AfterSaleStatus
  const items = await prisma.afterSaleCase.findMany({ where, orderBy: { createdAt: 'desc' }, include: { order: { include: orderInclude }, supplementaryOrder: { select: { id: true, orderNo: true } }, customer: { select: { id: true, customerCode: true, teamCode: true } }, staff: { select: { name: true } }, createdBy: { select: { username: true } }, handler: { select: { username: true } }, messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { author: { select: { username: true, role: true, staffProfile: { select: { name: true } } } } } } } })
  res.json({ items: items.map((item) => ({ ...item, order: orderView(item.order) })) })
}))
router.post('/after-sales', ...authenticated, asyncHandler(async (req, res) => {
  if (isAdminRole(req.user!.role)) ensure(hasPermission(req.user!, 'aftersales.create'), 403, '当前账号没有创建售后的权限')
  const body = afterSaleCreateSchema.parse(req.body)
  const order = await getOrderForUser(body.orderId, req)
  const item = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, order.id)
    const current = await tx.order.findUnique({ where: { id: order.id }, include: { orderConsumption: { select: { id: true } }, afterSaleCase: { select: { id: true } } } })
    ensure(current, 404, '订单不存在')
    ensure(finalizedOrderStatuses.includes(current.status as typeof finalizedOrderStatuses[number]) && current.completedAt && current.completionReviewStatus === CompletionReviewStatus.APPROVED && current.orderConsumption, 409, '订单尚未完成最终审核和结算，暂不能创建正式售后。')
    ensure(!current.afterSaleCase, 409, '该订单已经存在售后记录')
    const created = await tx.afterSaleCase.create({ data: { caseNo: caseNo(), orderId: current.id, customerId: current.customerId, staffId: current.staffId, createdById: req.user!.id, issueType: body.issueType, description: body.description } })
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.AFTER_SALE, afterSaleAt: new Date() } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'CREATE', entityType: 'AFTER_SALE', entityId: created.id, detail: { orderId: order.id, caseNo: created.caseNo } })
    return created
  })
  notifyChange(order.assignments.map((assignment) => assignment.staffId))
  res.status(201).json({ item })
}))
router.patch('/after-sales/:id', ...afterSaleManage, asyncHandler(async (req, res) => {
  const body = afterSaleUpdateSchema.parse(req.body)
  const current = await prisma.afterSaleCase.findUnique({ where: { id: getParam(req) }, include: { fundTransactions: true, supplementaryOrder: { select: { id: true, orderNo: true, customerId: true, status: true } }, order: { include: { assignments: { select: { staffId: true } } } } } })
  ensure(current, 404, '售后记录不存在')
  const compensationCents = body.compensationAmount === undefined ? current.compensationCents : parseYuanToCents(body.compensationAmount, '补偿金额')
  const refundCents = body.refundAmount === undefined ? current.refundCents : parseYuanToCents(body.refundAmount, '退款记录金额')
  const nextStatus = body.status ?? current.status
  const nextResultType = body.resultType === undefined ? current.resultType : body.resultType
  const supplementaryOrderId = nextResultType === AfterSaleResultType.SUPPLEMENTARY_ORDER ? body.supplementaryOrderId ?? current.supplementaryOrderId : null
  if (nextResultType === AfterSaleResultType.SUPPLEMENTARY_ORDER) {
    ensure(supplementaryOrderId, 400, '补单结果必须关联新订单')
    const supplementaryOrder = await prisma.order.findUnique({ where: { id: supplementaryOrderId } })
    ensure(supplementaryOrder, 404, '关联补单不存在')
    ensure(supplementaryOrder.id !== current.orderId && supplementaryOrder.customerId === current.customerId, 400, '补单必须是同一客户的其他订单')
    ensure(supplementaryOrder.status !== OrderStatus.CANCELLED, 400, '已取消订单不能作为补单关联')
  }
  if (current.fundTransactions.some((item) => item.type === FundTransactionType.AFTER_SALE)) {
    ensure(compensationCents === current.compensationCents, 409, '售后补偿已入账，不能直接修改金额')
  }
  const item = await prisma.$transaction(async (tx) => {
    if (nextStatus === AfterSaleStatus.COMPLETED && compensationCents > 0 && current.fundTransactions.length === 0) {
      const customer = await tx.customer.findUnique({ where: { id: current.customerId } })
      ensure(customer, 404, '客户不存在')
      const updated = await tx.customer.update({ where: { id: customer.id }, data: { principalBalanceCents: { increment: compensationCents }, balanceCents: { increment: compensationCents } } })
      await tx.fundTransaction.create({ data: { customerId: customer.id, operatorId: req.user!.id, afterSaleCaseId: current.id, type: FundTransactionType.AFTER_SALE, amountCents: compensationCents, principalBeforeCents: customer.principalBalanceCents, principalAfterCents: updated.principalBalanceCents, bonusBeforeCents: customer.bonusBalanceCents, bonusAfterCents: customer.bonusBalanceCents, balanceBeforeCents: customer.balanceCents, balanceAfterCents: updated.balanceCents, note: body.handlingNote || '售后补偿' } })
    }
    if (body.handlingNote?.trim() && body.handlingNote.trim() !== current.handlingNote?.trim()) {
      await tx.afterSaleMessage.create({ data: { caseId: current.id, authorId: req.user!.id, content: body.handlingNote.trim() } })
    }
    const updated = await tx.afterSaleCase.update({ where: { id: current.id }, data: { issueType: body.issueType, description: body.description, status: nextStatus, resultType: body.resultType === undefined ? undefined : body.resultType, supplementaryOrderId, compensationCents, refundCents, handlingNote: body.handlingNote === undefined ? undefined : body.handlingNote || null, handlerId: req.user!.id, handledAt: nextStatus === AfterSaleStatus.COMPLETED ? new Date() : null } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'AFTER_SALE', entityId: current.id, detail: { ...body, compensationCents, refundCents } })
    return updated
  })
  notifyChange(current.order.assignments.map((assignment) => assignment.staffId))
  res.json({ item })
}))
router.post('/after-sales/:id/messages', ...authenticated, asyncHandler(async (req, res) => {
  if (isAdminRole(req.user!.role)) ensure(hasPermission(req.user!, 'aftersales.manage'), 403, '当前账号没有处理售后的权限')
  const body = messageSchema.parse(req.body)
  const item = await prisma.afterSaleCase.findUnique({ where: { id: getParam(req) }, include: { order: { include: { assignments: true } } } })
  ensure(item, 404, '售后记录不存在')
  if (req.user!.role === UserRole.STAFF) ensure(item.order.assignments.some((assignment) => assignment.staffId === req.user!.staffProfileId && participatingAssignmentStatuses.includes(assignment.assignmentStatus as typeof participatingAssignmentStatuses[number])), 403, '只能操作与本人相关的售后记录')
  const message = await prisma.afterSaleMessage.create({ data: { caseId: item.id, authorId: req.user!.id, content: body.content } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'MESSAGE', entityType: 'AFTER_SALE', entityId: item.id })
  notifyChange(item.order.assignments.map((assignment) => assignment.staffId))
  res.status(201).json({ item: message })
}))

router.get('/packages', ...authenticated, asyncHandler(async (req, res) => {
  ensure(isAdminRole(req.user!.role) && (hasPermission(req.user!, 'packages.manage') || hasPermission(req.user!, 'orders.create') || hasPermission(req.user!, 'orders.view')), 403, '当前账号没有查看服务套餐的权限')
  res.json({ items: await prisma.servicePackage.findMany({ orderBy: [{ isEnabled: 'desc' }, { sort: 'asc' }, { createdAt: 'desc' }] }) })
}))
router.post('/packages', ...packageManage, asyncHandler(async (req, res) => {
  const body = packageSchema.parse(req.body)
  const item = await prisma.servicePackage.create({ data: { ...body, category: body.category || null, description: body.description || null, note: body.note || null, createdById: req.user!.id } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'PACKAGE', entityId: item.id, detail: body })
  notifyChange()
  res.status(201).json({ item })
}))
router.patch('/packages/:id', ...packageManage, asyncHandler(async (req, res) => {
  const body = packageSchema.partial().parse(req.body)
  const item = await prisma.servicePackage.update({ where: { id: getParam(req) }, data: { name: body.name, category: body.category === undefined ? undefined : body.category || null, description: body.description === undefined ? undefined : body.description || null, basePriceCents: body.basePriceCents, isEnabled: body.isEnabled, sort: body.sort, note: body.note === undefined ? undefined : body.note || null } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'PACKAGE', entityId: item.id, detail: body })
  notifyChange()
  res.json({ item })
}))

router.get('/recharge-activities', ...activityManage, asyncHandler(async (_req, res) => {
  const items = await prisma.rechargeActivity.findMany({ orderBy: { createdAt: 'desc' }, include: { tiers: { orderBy: { thresholdCents: 'asc' } } } })
  res.json({ items: items.map((item) => ({ ...item, status: getScheduleStatus(item) })) })
}))
router.post('/recharge-activities', ...activityManage, asyncHandler(async (req, res) => {
  const body = activitySchema.parse(req.body)
  ensure(body.endAt > body.startAt, 400, '活动结束时间必须晚于开始时间')
  const item = await prisma.rechargeActivity.create({ data: { name: body.name, startAt: body.startAt, endAt: body.endAt, isEnabled: body.isEnabled ?? true, note: body.note || null, createdById: req.user!.id, tiers: { create: body.tiers } }, include: { tiers: true } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'RECHARGE_ACTIVITY', entityId: item.id, detail: { name: item.name } })
  notifyChange()
  res.status(201).json({ item })
}))
router.patch('/recharge-activities/:id', ...activityManage, asyncHandler(async (req, res) => {
  const body = activitySchema.partial().parse(req.body)
  const item = await prisma.$transaction(async (tx) => {
    const updated = await tx.rechargeActivity.update({ where: { id: getParam(req) }, data: { name: body.name, startAt: body.startAt, endAt: body.endAt, isEnabled: body.isEnabled, note: body.note === undefined ? undefined : body.note || null } })
    if (body.tiers) {
      await tx.rechargeActivityTier.deleteMany({ where: { activityId: updated.id } })
      await tx.rechargeActivityTier.createMany({ data: body.tiers.map((tier) => ({ ...tier, activityId: updated.id })) })
    }
    return tx.rechargeActivity.findUnique({ where: { id: updated.id }, include: { tiers: true } })
  })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'RECHARGE_ACTIVITY', entityId: getParam(req), detail: body })
  notifyChange()
  res.json({ item })
}))

router.get('/coupons', ...couponManage, asyncHandler(async (_req, res) => {
  const items = await prisma.coupon.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { customerCoupons: true } } } })
  res.json({ items: items.map((item) => ({ ...item, status: getScheduleStatus(item) })) })
}))
router.post('/coupons', ...couponManage, asyncHandler(async (req, res) => {
  const body = couponSchema.parse(req.body)
  ensure(body.endAt > body.startAt, 400, '优惠券结束时间必须晚于开始时间')
  const item = await prisma.coupon.create({ data: { name: body.name, type: CouponType.FIXED, amountCents: body.amountCents, minSpendCents: body.minSpendCents ?? 0, startAt: body.startAt, endAt: body.endAt, isEnabled: body.isEnabled ?? true, note: body.note || null, createdById: req.user!.id } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'COUPON', entityId: item.id, detail: body })
  notifyChange()
  res.status(201).json({ item })
}))
router.patch('/coupons/:id', ...couponManage, asyncHandler(async (req, res) => {
  const body = couponSchema.partial().parse(req.body)
  const item = await prisma.coupon.update({ where: { id: getParam(req) }, data: { name: body.name, amountCents: body.amountCents, minSpendCents: body.minSpendCents, startAt: body.startAt, endAt: body.endAt, isEnabled: body.isEnabled, note: body.note === undefined ? undefined : body.note || null } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'COUPON', entityId: item.id, detail: body })
  notifyChange()
  res.json({ item })
}))
router.post('/coupons/:id/issue', ...couponManage, asyncHandler(async (req, res) => {
  const customerId = z.string().min(1).parse(req.body.customerId)
  const coupon = await prisma.coupon.findUnique({ where: { id: getParam(req) } })
  const now = new Date()
  ensure(coupon && coupon.isEnabled && coupon.startAt <= now && coupon.endAt >= now, 404, '优惠券不存在、未开始、已停用或已过期')
  const customer = await getCustomer(customerId)
  const item = await prisma.customerCoupon.create({ data: { couponId: coupon.id, customerId: customer.id, issuedById: req.user!.id } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'ISSUE', entityType: 'COUPON', entityId: coupon.id, detail: { customerId } })
  notifyChange()
  res.status(201).json({ item })
}))
router.get('/campaigns', ...campaignManage, asyncHandler(async (_req, res) => {
  const items = await prisma.marketingActivity.findMany({ orderBy: { createdAt: 'desc' } })
  res.json({ items: items.map((item) => ({ ...item, status: getScheduleStatus(item) })) })
}))
router.post('/campaigns', ...campaignManage, asyncHandler(async (req, res) => {
  const body = campaignSchema.parse(req.body)
  ensure(body.endAt > body.startAt, 400, '活动结束时间必须晚于开始时间')
  const item = await prisma.marketingActivity.create({ data: { name: body.name, type: body.type, rule: body.rule as Prisma.InputJsonValue | undefined, startAt: body.startAt, endAt: body.endAt, isEnabled: body.isEnabled ?? true, note: body.note || null, createdById: req.user!.id } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'CAMPAIGN', entityId: item.id, detail: { name: item.name, type: item.type } })
  notifyChange()
  res.status(201).json({ item })
}))
router.patch('/campaigns/:id', ...campaignManage, asyncHandler(async (req, res) => {
  const body = campaignSchema.partial().parse(req.body)
  const item = await prisma.marketingActivity.update({ where: { id: getParam(req) }, data: { name: body.name, type: body.type, rule: body.rule as Prisma.InputJsonValue | undefined, startAt: body.startAt, endAt: body.endAt, isEnabled: body.isEnabled, note: body.note === undefined ? undefined : body.note || null } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'CAMPAIGN', entityId: item.id, detail: { name: body.name ?? null, type: body.type ?? null } })
  notifyChange()
  res.json({ item })
}))
router.get('/notices', ...noticeManage, asyncHandler(async (_req, res) => {
  res.json({ items: await prisma.notice.findMany({ orderBy: { createdAt: 'desc' } }) })
}))
router.post('/notices', ...noticeManage, asyncHandler(async (req, res) => {
  const body = noticeSchema.parse(req.body)
  const item = await prisma.notice.create({ data: { type: body.type === 'RISK' ? 'RISK' : 'ANNOUNCEMENT', title: body.title, content: body.content, isEnabled: body.isEnabled ?? true, createdById: req.user!.id } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'CREATE', entityType: 'NOTICE', entityId: item.id, detail: { type: body.type, title: body.title } })
  notifyChange()
  res.status(201).json({ item })
}))
router.patch('/notices/:id', ...noticeManage, asyncHandler(async (req, res) => {
  const body = noticeSchema.partial().parse(req.body)
  const item = await prisma.notice.update({ where: { id: getParam(req) }, data: { type: body.type as 'ANNOUNCEMENT' | 'RISK' | undefined, title: body.title, content: body.content, isEnabled: body.isEnabled } })
  await logOperation(prisma, { operatorId: req.user!.id, action: 'UPDATE', entityType: 'NOTICE', entityId: item.id, detail: body })
  notifyChange()
  res.json({ item })
}))

router.get('/admin/permissions', ...rbacManage, asyncHandler(async (req, res) => {
  res.json({ role: req.user!.role, permissions: req.user!.permissions })
}))
router.get('/admin/role-permissions', ...rbacManage, asyncHandler(async (req, res) => {
  const roles = await Promise.all(manageableRoles(req.user!.role).map(async (role) => {
    const setting = await prisma.systemSetting.findUnique({ where: { key: rolePermissionKey(role) }, select: { updatedAt: true, updatedById: true } })
    return { role, permissions: await getRolePermissions(role), defaults: [...defaultRolePermissions[role]], customized: Boolean(setting), updatedAt: setting?.updatedAt ?? null }
  }))
  res.setHeader('Cache-Control', 'no-store')
  res.json({ catalog: permissionCatalog.map(item => ({ ...item, configurable: item.configurable !== false && (req.user!.role === 'SUPER_ADMIN' || hasPermission(req.user!, item.key)) })), roles })
}))
router.patch('/admin/role-permissions/:role', ...rbacManage, asyncHandler(async (req, res) => {
  assertRoleConfigScope(req.user!.role, String(req.params.role))
  const role = z.enum(configurableRoles).parse(req.params.role)
  const body = z.object({ permissions: z.array(z.enum(allPermissions)).max(allPermissions.length) }).strict().parse(req.body)
  const item = await saveRolePermissions(role, body.permissions, req.user!.id)
  notifyChange()
  res.json({ item })
}))
router.post('/admin/role-permissions/:role/reset', ...rbacManage, asyncHandler(async (req, res) => {
  assertRoleConfigScope(req.user!.role, String(req.params.role))
  const role = z.enum(configurableRoles).parse(req.params.role)
  const item = await saveRolePermissions(role, null, req.user!.id)
  notifyChange()
  res.json({ item })
}))
router.get('/admin/roles', ...rbacManage, asyncHandler(async (req, res) => {
  const items = await prisma.adminRole.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { users: true } } } })
  const allowed = delegatedPermissions.filter(key => req.user!.role === UserRole.SUPER_ADMIN || hasPermission(req.user!, key))
  res.setHeader('Cache-Control', 'no-store')
  res.json({ items: items.map(item => ({ ...item, manageable: !item.isSystem && item.authorityLevel >= 2 && Array.isArray(item.permissions) && item.permissions.every(key => allowed.includes(key as typeof allowed[number])) })), catalog: permissionCatalog.filter(item => allowed.includes(item.key)) })
}))
router.post('/admin/roles', ...rbacManage, asyncHandler(async (req, res) => {
  const item = await saveAdminRole(req.user!.id, undefined, adminRoleSchema.parse(req.body))
  notifyChange(); res.status(201).json({ item })
}))
router.patch('/admin/roles/:id', ...rbacManage, asyncHandler(async (req, res) => {
  const item = await saveAdminRole(req.user!.id, getParam(req), adminRoleUpdateSchema.parse(req.body))
  notifyChange(); res.json({ item })
}))
router.delete('/admin/roles/:id', ...rbacManage, asyncHandler(async (req, res) => {
  await deleteAdminRole(req.user!.id, getParam(req))
  notifyChange(); res.json({ ok: true })
}))
router.get('/admin/users', ...rbacManage, asyncHandler(async (req, res) => {
  const items = await prisma.user.findMany({ where: { role: req.user!.role === UserRole.SUPER_ADMIN ? { not: UserRole.STAFF } : { in: [...subordinateRoles] } }, orderBy: { createdAt: 'asc' }, select: { id: true, username: true, role: true, adminRoleId: true, adminRole: { select: { id: true, name: true, isActive: true } }, isActive: true, createdAt: true } })
  res.json({ items })
}))
router.post('/admin/users', ...rbacManage, asyncHandler(async (req, res) => {
  const body = z.object({ username: z.string().trim().min(2).max(64), password: z.string().min(6).max(72), role: z.nativeEnum(UserRole), adminRoleId: z.string().min(1).max(191).nullable().optional(), isActive: z.boolean().optional() }).strict().parse(req.body)
  ensure(body.role !== UserRole.STAFF, 400, '管理账号不能设置为员工角色')
  assertAccountScope(req.user!.role, body.role, body.role)
  const passwordHash = await hashPassword(body.password)
  const item = await prisma.$transaction(async tx => {
    const adminRoleId = await validateJobAssignment(tx, req.user!.id, body.role, body.adminRoleId)
    const created = await tx.user.create({ data: { username: body.username, passwordHash, role: body.role, adminRoleId, isActive: body.isActive ?? true }, select: { id: true, username: true, role: true, adminRoleId: true, adminRole: { select: { id: true, name: true, isActive: true } }, isActive: true } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'CREATE', entityType: 'ADMIN_USER', entityId: created.id, detail: { username: created.username, role: created.role, targetRoleId: adminRoleId, before: null, after: created, addedPermissions: await getUserPermissions(created, tx), removedPermissions: [], time: new Date().toISOString() } })
    return created
  }, { isolationLevel: 'Serializable' })
  notifyChange()
  res.status(201).json({ item })
}))
router.patch('/admin/users/:id', ...rbacManage, asyncHandler(async (req, res) => {
  const body = adminAccountUpdateSchema.parse(req.body)
  const targetUserId = getParam(req)
  ensure(body.role !== UserRole.STAFF, 400, '管理账号不能设置为员工角色')
  try {
    const item = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { id: true, username: true, role: true, adminRoleId: true, adminRole: { select: { id: true, name: true, isActive: true } }, isActive: true } })
      ensure(target, 404, '管理账号不存在')
      ensure(target.role !== UserRole.STAFF, 400, '只能修改管理账号')
      const actor = await checkRoleOperator(tx, req.user!.id)
      assertAccountScope(actor.role, target.role, body.role)
      const nextRole = body.role ?? target.role
      if (target.adminRoleId) await validateJobAssignment(tx, req.user!.id, target.role, target.adminRoleId, target.adminRoleId)
      const nextJob = body.adminRoleId !== undefined ? body.adminRoleId : nextRole === target.role ? target.adminRoleId : null
      const adminRoleId = await validateJobAssignment(tx, req.user!.id, nextRole, nextJob, target.adminRoleId)
      const beforePermissions = await getUserPermissions(target, tx)
      ensure(body.role === undefined || targetUserId !== req.user!.id || body.role === UserRole.SUPER_ADMIN, 400, '不能移除当前账号的超级管理员权限')
      if (body.username !== undefined) {
        const existing = await tx.user.findUnique({ where: { username: body.username }, select: { id: true } })
        ensure(!existing || existing.id === target.id, 409, '登录账号已存在，请使用其他账号')
      }
      const updated = await tx.user.update({ where: { id: target.id }, data: { ...body, adminRoleId }, select: { id: true, username: true, role: true, adminRoleId: true, adminRole: { select: { id: true, name: true, isActive: true } }, isActive: true } })
      const afterPermissions = await getUserPermissions(updated, tx)
      const renamed = target.username !== updated.username
      await logOperation(tx, {
        operatorId: req.user!.id, action: 'UPDATE', entityType: 'ADMIN_USER', entityId: target.id,
        detail: {
          ...body, targetUserId: target.id, oldUsername: target.username, newUsername: updated.username,
          targetRoleId: adminRoleId, before: target, after: updated, addedPermissions: afterPermissions.filter(key => !beforePermissions.includes(key)), removedPermissions: beforePermissions.filter(key => !afterPermissions.includes(key)), time: new Date().toISOString(),
          ...(renamed ? { message: `登录账号修改：${target.username} → ${updated.username}` } : {}),
        },
      })
      return updated
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    notifyChange()
    res.json({ item })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, '登录账号已存在，请使用其他账号')
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      throw new HttpError(409, '账号信息刚刚发生变化，请刷新后重试')
    }
    throw error
  }
}))
router.post('/admin/users/:id/reset-password', ...rbacManage, asyncHandler(async (req, res) => {
  const body = z.object({ password: z.string().min(6).max(72) }).parse(req.body)
  const passwordHash = await hashPassword(body.password)
  const item = await prisma.$transaction(async tx => {
    const target = await tx.user.findUnique({ where: { id: getParam(req) }, select: { id: true, username: true, role: true, adminRoleId: true } })
    ensure(target && target.role !== UserRole.STAFF, 404, '管理账号不存在')
    const actor = await checkRoleOperator(tx, req.user!.id)
    assertAccountScope(actor.role, target.role)
    if (target.adminRoleId) await validateJobAssignment(tx, req.user!.id, target.role, target.adminRoleId, target.adminRoleId)
    const updated = await tx.user.update({ where: { id: target.id }, data: { passwordHash, authVersion: { increment: 1 } }, select: { id: true, username: true, role: true, isActive: true, authVersion: true } })
    await logOperation(tx, { operatorId: req.user!.id, action: 'RESET_PASSWORD', entityType: 'ADMIN_USER', entityId: updated.id, detail: { username: updated.username, role: updated.role } })
    return updated
  }, { isolationLevel: 'Serializable' })
  revokeUserSockets(item.id, item.authVersion)
  const { authVersion: _authVersion, ...view } = item
  res.json({ item: view })
}))

router.get('/imports/template', ...importManage, asyncHandler(async (req, res) => {
  const type = req.query.type === 'orders' ? 'orders' : 'customers'
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(type === 'orders' ? '订单导入模板' : '客户导入模板')
  if (type === 'customers') {
    sheet.columns = [{ header: '客户ID', key: 'customerCode', width: 24 }, { header: '客户组队码', key: 'teamCode', width: 24 }, { header: '备注', key: 'note', width: 36 }]
    sheet.addRow({ customerCode: 'PLAYER-10001', teamCode: 'TEAM-8888', note: '客户备注（请删除示例行）' })
  } else {
    sheet.columns = [{ header: '客户ID', key: 'customerCode', width: 24 }, { header: '客户组队码', key: 'teamCode', width: 24 }, { header: '服务套餐名称', key: 'servicePackageName', width: 32 }, { header: '订单金额（元）', key: 'amountYuan', width: 18 }, { header: '员工账号（可空）', key: 'staffUsername', width: 20 }, { header: '备注', key: 'note', width: 36 }]
    sheet.addRow({ customerCode: 'PLAYER-10001', teamCode: 'TEAM-8888', servicePackageName: '英雄联盟赛事护航', amountYuan: 328, staffUsername: 'lin', note: '订单备注（请删除示例行）' })
  }
  sheet.getRow(1).font = { bold: true }
  const buffer = await workbook.xlsx.writeBuffer()
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', 'attachment; filename=' + encodeURIComponent(type === 'orders' ? '订单导入模板.xlsx' : '客户导入模板.xlsx'))
  res.send(Buffer.from(buffer))
}))
router.post('/imports', ...importManage, upload.single('file'), asyncHandler(async (req, res) => {
  ensure(req.file, 400, '请选择要导入的 Excel 文件')
  const type = req.body.type === 'orders' ? 'orders' : 'customers'
  const workbook = new ExcelJS.Workbook()
  try {
    const fileBuffer = req.file.buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]
    await workbook.xlsx.load(fileBuffer)
  } catch {
    throw new HttpError(400, 'Excel 文件无法读取，请上传 .xlsx 文件')
  }
  const sheet = workbook.worksheets[0]
  ensure(sheet, 400, 'Excel 文件没有工作表')
  const errors: Array<{ row: number; reason: string }> = []
  let successCount = 0
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const value = (key: string) => String(row.getCell(key).value ?? '').trim()
    try {
      if (type === 'customers') {
        const customerCode = value('A')
        const teamCode = value('B')
        const note = value('C')
        ensure(customerCode && teamCode, 400, '客户ID、客户组队码不能为空')
        await prisma.customer.create({ data: { customerCode, teamCode, name: customerCode, phone: null, note: note || null } })
      } else {
        const customerCode = value('A')
        const teamCode = value('B')
        const servicePackageName = value('C')
        const amountText = value('D')
        const staffUsername = value('E')
        const note = value('F')
        ensure(customerCode && teamCode && servicePackageName && amountText, 400, '客户ID、客户组队码、服务套餐名称、订单金额不能为空')
        const amountCents = parseYuanToCents(amountText, '订单金额')
        const customer = await prisma.customer.upsert({ where: { customerCode }, update: { teamCode, name: customerCode }, create: { customerCode, teamCode, name: customerCode, phone: null } })
        const staff = staffUsername ? await prisma.staffProfile.findFirst({ where: { user: { username: staffUsername, isActive: true } } }) : null
        if (staffUsername) ensure(staff, 404, `员工账号 ${staffUsername} 不存在或已停用`)
        const servicePackage = await prisma.servicePackage.findFirst({ where: { name: servicePackageName, isEnabled: true } })
        ensure(servicePackage, 404, `未找到启用的服务套餐：${servicePackageName}`)
        const commissionRateBps = staff?.commissionRateBps ?? config.defaultCommissionRateBps
        const expectedEarningCents = calculateStaffAmount(amountCents, commissionRateBps)
        const now = new Date()
        const created = await prisma.order.create({
          data: {
            orderNo: orderNo(),
            customerId: customer.id,
            staffId: staff?.id,
            servicePackageId: servicePackage.id,
            serviceItem: servicePackage.name,
            originalAmountCents: amountCents,
            amountCents,
            staffAmountCents: expectedEarningCents,
            requiredStaffCount: 1,
            status: staff ? OrderStatus.PENDING : OrderStatus.PENDING_ASSIGNMENT,
            assignedAt: staff ? now : null,
            note: note || null,
            createdById: req.user!.id,
            assignments: { create: { slotIndex: 1, commissionRateBps, expectedEarningCents, staffId: staff?.id ?? null, assignmentStatus: staff ? OrderStaffAssignmentStatus.CLAIMED : OrderStaffAssignmentStatus.OPEN, claimedAt: staff ? now : null } },
          },
        })
        await logOperation(prisma, { operatorId: req.user!.id, action: 'IMPORT_CREATE', entityType: 'ORDER', entityId: created.id, detail: { row: rowNumber } })
      }
      successCount += 1
    } catch (error) {
      errors.push({ row: rowNumber, reason: error instanceof Error ? error.message : '数据格式不正确' })
    }
  }
  notifyChange()
  res.json({ total: Math.max(sheet.rowCount - 1, 0), successCount, failureCount: errors.length, errors })
}))

export const permissionFor = (permission: Permission) => permission

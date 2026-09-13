export type Role = 'SUPER_ADMIN' | 'STORE_MANAGER' | 'CUSTOMER_SERVICE' | 'DISPATCHER' | 'FINANCE' | 'CUSTOM_ADMIN' | 'STAFF' | 'ADMIN'
export type StaffStatus = 'IDLE' | 'BUSY'
export type StaffAccountStatus = 'NORMAL' | 'FROZEN' | 'RETIRED'
export type StaffPresence = 'ONLINE' | 'OFFLINE'
export type StaffAccepting = 'ACCEPTING' | 'PAUSED'
export type IdentityReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
export type OrderStatus = 'PENDING_PAYMENT' | 'PENDING_ASSIGNMENT' | 'PENDING' | 'IN_PROGRESS' | 'PENDING_COMPLETION_REVIEW' | 'COMPLETED' | 'AFTER_SALE' | 'CANCELLED'
export type OrderStaffAssignmentStatus = 'OPEN' | 'CLAIMED' | 'ACTIVE' | 'EXIT_REQUESTED' | 'EXITED' | 'COMPLETED'
export type CompletionReviewStatus = 'NOT_SUBMITTED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
export type ExitReviewStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'
export type User = {
  adminRoleId?: string | null
  adminRole?: { id: string; name: string; isActive: boolean } | null
  id: string
  username: string
  permissions?: string[]
  role: Role
  isActive: boolean
  staffProfile: {
    id: string
    name: string
    status: StaffStatus
    presence?: StaffPresence
    accepting?: StaffAccepting; selfAccepting?: StaffAccepting
    accountStatus?: StaffAccountStatus
    tierId?: string | null
  } | null
}
export type StaffTier = {
  id: string
  name: string
  description?: string | null
  level: number
  priceMultiplierBps: number
  canAcceptOrders: boolean
  isEnabled: boolean
  sort?: number
}
export type Staff = {
  id: string
  userId: string
  username: string
  name: string
  phone: string | null
  contact?: string | null
  status: StaffStatus
  accountStatus?: StaffAccountStatus
  presence?: StaffPresence
  accepting?: StaffAccepting; selfAccepting?: StaffAccepting
  isActive: boolean
  commissionRateBps: number
  inProgressCount: number
  completedCount: number
  assignedOrderCount?: number
  completionRate?: number
  totalEarningsCents: number
  settledCents?: number
  pendingSettlementCents?: number
  overSettledCents?: number
  realName?: string | null
  idNumberMasked?: string | null
  identityStatus?: IdentityReviewStatus
  identityReviewNote?: string | null
  note?: string | null
  tier?: StaffTier | null
  incidentCounts?: { BAD_REVIEW: number; ROLLOVER: number; COMPLAINT: number }
  incidents?: Array<{ id: string; type: string; note: string; createdAt: string }>
}
export type StaffOption = {
  id: string
  name: string
  status: StaffStatus
  presence?: StaffPresence
  accepting?: StaffAccepting; selfAccepting?: StaffAccepting
  accountStatus?: StaffAccountStatus
  currentInProgressCount: number
  tier?: Pick<StaffTier, 'id' | 'name' | 'level' | 'canAcceptOrders'> | null
}
export type Customer = {
  id: string
  customerCode: string
  teamCode: string
  name: string
  phone: string | null
  balanceCents: number
  principalBalanceCents?: number
  bonusBalanceCents?: number
  fundingPolicy?: 'PRINCIPAL_FIRST' | 'BONUS_FIRST'
  isBlacklisted?: boolean
  tags?: string | null
  note: string | null
  createdAt: string
  updatedAt: string
  totalRechargeCents?: number
  totalPrincipalRechargeCents?: number
  totalBonusCents?: number
  totalConsumptionCents?: number
  consumptionCount?: number
  _count?: { orders: number; rechargeRecords: number; consumptionRecords: number; orderConsumptions?: number }
}
export type Order = {
  afterSaleCase?: { id: string; messages: import('./components/AfterSaleMessages').AfterSaleMessage[] } | null
  id: string
  orderNo: string
  serviceItem: string
  originalAmountCents?: number
  discountAmountCents?: number
  amountCents: number
  adjustmentTotalCents?: number
  currentNetAmountCents?: number
  staffAmountCents: number
  currentStaffEarningTotalCents?: number
  requiredStaffCount: number
  activeStaffCount: number
  missingStaffCount: number
  isTeamFull: boolean
  completionSubmittedCount: number
  completionRequiredCount: number
  completionReviewStatus: CompletionReviewStatus
  completionReviewReason?: string | null
  completionSubmittedAt?: string | null
  completionReviewedAt?: string | null
  status: OrderStatus
  note: string | null
  isLocked?: boolean
  assignedAt: string | null
  startedAt?: string | null
  completedAt: string | null
  hasOriginalSettlement?: boolean
  afterSaleAt?: string | null
  createdAt: string
  updatedAt: string
  customer: { id?: string; customerCode: string | null; teamCode: string | null; name?: string; phone?: string | null; balanceCents?: number; principalBalanceCents?: number; bonusBalanceCents?: number; isBlacklisted?: boolean }
  staff: { id: string; name: string; status: StaffStatus; presence?: StaffPresence; accepting?: StaffAccepting; selfAccepting?: StaffAccepting; accountStatus?: StaffAccountStatus; tierId?: string | null } | null
  servicePackage?: { id: string; name: string; category?: string | null; description?: string | null; basePriceCents?: number } | null
  requiredTier?: { id: string; name: string; level: number; priceMultiplierBps?: number } | null
  customerCoupon?: { id: string; status: string; coupon?: { name: string; amountCents: number } } | null
  assignments: Array<{
    id?: string
    orderId?: string
    staffId?: string | null
    slotIndex: number
    commissionRateBps: number
    expectedEarningCents: number
    actualEarningCents?: number
    currentNetEarningCents?: number
    assignmentStatus: OrderStaffAssignmentStatus
    claimedAt?: string | null
    exitedAt?: string | null
    startedAt?: string | null
    completionSubmittedAt?: string | null
    completionReviewStatus?: CompletionReviewStatus
    completionReviewReason?: string | null
    exitReviewStatus?: ExitReviewStatus
    exitRequestedAt?: string | null
    exitReason?: string | null
    exitReviewNote?: string | null
    occupied?: boolean
    staff?: { id: string; name: string; status?: StaffStatus; presence?: StaffPresence; accepting?: StaffAccepting; selfAccepting?: StaffAccepting; accountStatus?: StaffAccountStatus; tierId?: string | null } | null
    completionProofs?: Array<{ id: string; mimeType: string; sizeBytes: number; note?: string | null; submittedAt: string; reviewStatus: CompletionReviewStatus; fileUrl: string }>
  }>
  adjustments?: Array<{
    id: string
    requestId: string
    afterSaleId?: string | null
    reason: string
    handlingNote?: string | null
    orderAmountBeforeCents: number
    orderAmountDeltaCents: number
    orderAmountAfterCents: number
    createdAt: string
    afterSale?: { id: string; caseNo: string } | null
    operator?: { username: string }
    staffAdjustments: Array<{ id: string; assignmentId: string; staffId: string; earningBeforeCents: number; earningDeltaCents: number; earningAfterCents: number; staff: { id: string; name: string } }>
  }>
}
export type CustomerDetail = Customer & {
  rechargeRecords: Array<{ id: string; amountCents: number; principalAmountCents?: number; bonusAmountCents?: number; note: string | null; createdAt: string; operator: { username: string } }>
  consumptionRecords: Array<{ id: string; amountCents: number; balanceBeforeCents: number; balanceAfterCents: number; note: string | null; createdAt: string; order: { orderNo: string }; operator: { username: string } }>
  orderConsumptions?: Array<{ id: string; orderId: string; totalAmountCents: number; principalUsedCents: number; bonusUsedCents: number; principalBeforeCents: number; principalAfterCents: number; bonusBeforeCents: number; bonusAfterCents: number; createdAt: string; order: { orderNo: string }; operator: { username: string } }>
  fundTransactions?: Array<{ id: string; type: string; amountCents: number; balanceBeforeCents: number; balanceAfterCents: number; principalBeforeCents: number; principalAfterCents: number; bonusBeforeCents: number; bonusAfterCents: number; note: string | null; createdAt: string; order?: { orderNo: string } | null; operator?: { username: string } | null }>
  customerCoupons?: Array<{ id: string; status: 'ISSUED' | 'USED' | 'EXPIRED'; issuedAt: string; usedAt: string | null; coupon: { name: string; amountCents: number; minSpendCents: number; startAt: string; endAt: string; isEnabled: boolean } }>
  orders: Array<Order & { staff: { name: string } | null }>
}
export const orderStatusMeta: Record<OrderStatus, { label: string; color: string }> = {
  PENDING_PAYMENT: { label: '待付款', color: 'warning' },
  PENDING_ASSIGNMENT: { label: '待接单', color: 'default' },
  PENDING: { label: '待处理', color: 'blue' },
  IN_PROGRESS: { label: '进行中', color: 'cyan' },
  PENDING_COMPLETION_REVIEW: { label: '待完单审核', color: 'blue' },
  COMPLETED: { label: '已完成', color: 'success' },
  AFTER_SALE: { label: '售后中', color: 'warning' },
  CANCELLED: { label: '已取消', color: 'error' },
}

export type OrderDisplayStatus = {
  label: string
  tagLabel: string
  color: string
  progress: string | null
}

export const getOrderDisplayStatus = (
  order: Pick<Order, 'status' | 'requiredStaffCount' | 'activeStaffCount' | 'completionSubmittedCount' | 'completionRequiredCount' | 'startedAt'>,
): OrderDisplayStatus => {
  const fallback = orderStatusMeta[order.status]
  const requiredStaffCount = Math.max(order.requiredStaffCount || 1, 1)
  const activeStaffCount = Math.max(Math.min(order.activeStaffCount || 0, requiredStaffCount), 0)
  const progress = `${activeStaffCount}/${requiredStaffCount}`

  if (order.status === 'COMPLETED' || order.status === 'AFTER_SALE' || order.status === 'CANCELLED' || order.status === 'PENDING_PAYMENT') {
    return { ...fallback, tagLabel: fallback.label, progress: null }
  }

  const completionRequiredCount = order.completionRequiredCount || activeStaffCount
  const allParticipantsSubmitted = completionRequiredCount > 0 && order.completionSubmittedCount >= completionRequiredCount
  if (order.status === 'PENDING_COMPLETION_REVIEW' || ((order.status === 'IN_PROGRESS' || Boolean(order.startedAt)) && allParticipantsSubmitted)) {
    const review = orderStatusMeta.PENDING_COMPLETION_REVIEW
    return { ...review, tagLabel: review.label, progress }
  }

  if (order.status === 'IN_PROGRESS' || Boolean(order.startedAt)) {
    const inProgress = orderStatusMeta.IN_PROGRESS
    return { ...inProgress, tagLabel: inProgress.label, progress }
  }

  if (order.status === 'PENDING_ASSIGNMENT' || order.status === 'PENDING') {
    if (activeStaffCount === 0) {
      return { ...orderStatusMeta.PENDING_ASSIGNMENT, label: '待接单', tagLabel: `待接单 ${progress}`, progress }
    }
    if (activeStaffCount < requiredStaffCount) {
      return { label: '待补员', tagLabel: `待补员 ${progress}`, color: 'default', progress }
    }
    return { ...orderStatusMeta.PENDING, label: '待处理', tagLabel: '待处理', progress }
  }

  return { ...fallback, tagLabel: fallback.label, progress: null }
}

export const getStaffAmountLabel = (status: OrderStatus) => {
  if (status === 'COMPLETED' || status === 'AFTER_SALE') return '实际应得'
  if (status === 'CANCELLED') return '不计入'
  return '预计应得'
}
export const getAdminStaffAmountLabel = (status: OrderStatus) => {
  const label = getStaffAmountLabel(status)
  return label === '预计应得' ? '预计员工总应得' : label
}
export const staffStatusMeta: Record<StaffStatus, { label: string; color: string }> = {
  IDLE: { label: '空闲', color: 'success' },
  BUSY: { label: '忙碌', color: 'processing' },
}
export const roleMeta: Record<Exclude<Role, 'ADMIN'>, string> = {
  SUPER_ADMIN: '超级管理员',
  STORE_MANAGER: '店长',
  CUSTOMER_SERVICE: '客服',
  CUSTOM_ADMIN: '自定义职位',
  DISPATCHER: '派单员',
  FINANCE: '财务',
  STAFF: '员工',
}
const adminSectionPermissions: Record<string, string[]> = {
  dashboard: ['dashboard.view'], orders: ['orders.view'], staff: ['staff.view'], customers: ['customers.view'],
  stats: ['stats.view', 'dispatch.view'], finance: ['finance.view'], 'after-sales': ['aftersales.view'],
  config: ['staff.manage', 'packages.manage', 'activities.manage', 'coupons.manage', 'campaigns.manage', 'notices.manage', 'funds.adjust'],
  permissions: ['rbac.manage'], imports: ['imports.manage'],
}
export const hasUserPermission = (user: User | null | undefined, permission: string) => Boolean(user && user.role !== 'STAFF' && (user.role === 'SUPER_ADMIN' || ((!['rbac.manage', 'dispatch.view'].includes(permission) || user.role === 'STORE_MANAGER') && user.permissions?.includes(permission))))
export const canViewAdminSection = (user: User | null | undefined, section: string) => (adminSectionPermissions[section] ?? []).some((permission) => hasUserPermission(user, permission))
export const staffAccountMeta: Record<StaffAccountStatus, string> = { NORMAL: '正常', FROZEN: '已冻结', RETIRED: '已清退' }
export const staffPresenceMeta: Record<StaffPresence, string> = { ONLINE: '在线', OFFLINE: '离线' }
export const staffAcceptingMeta: Record<StaffAccepting, string> = { ACCEPTING: '允许接单', PAUSED: '暂停接单' }
export const staffSelfAcceptingMeta: Record<StaffAccepting, string> = { ACCEPTING: '可接单', PAUSED: '暂时不接单' }
export type Stats = {
  orderCount: number
  completedOrderCount: number
  revenueCents: number
  staffEarningsCents: number
  daily: Array<{ date: string; orderCount: number; completedOrderCount: number; revenueCents: number; staffEarningsCents: number }>
}

export const adminLandingPath = (user: User | null | undefined) => '/admin/' + (['dashboard', 'orders', 'finance', 'after-sales', 'staff', 'customers', 'stats', 'config', 'permissions', 'imports'].find(section => canViewAdminSection(user, section)) ?? 'orders')

import 'dotenv/config'
import {
  ActivityType,
  AfterSaleStatus,
  CompletionReviewStatus,
  FundTransactionType,
  FundingPolicy,
  OrderStaffAssignmentStatus,
  PrismaClient,
  OrderStatus,
  StaffStatus,
  UserRole,
} from '@prisma/client'
import bcrypt from 'bcryptjs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

const prisma = new PrismaClient()

const passwordForSeed = (name: string, fallback: string) => {
  const value = process.env[name]?.trim()
  if (process.env.NODE_ENV === 'production' && !value) {
    throw new Error(`生产环境运行种子前必须配置 ${name}`)
  }
  return value || fallback
}

const dateDaysAgo = (days: number, hour = 10, minute = 0) => {
  const value = new Date()
  value.setDate(value.getDate() - days)
  value.setHours(hour, minute, 0, 0)
  return value
}

const orderNumber = (sequence: number, daysAgo = 0) => {
  const value = dateDaysAgo(daysAgo)
  const date = `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`
  return `DEMO${date}${String(sequence).padStart(3, '0')}`
}

const main = async () => {
  const url = new URL(process.env.DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['/club_management_showcase', '/club_management_showcase_test'].includes(url.pathname) || process.env.NODE_ENV === 'production') throw new Error('Seed only permits local showcase databases')
  if (await prisma.user.count() > 0) throw new Error('Seed requires an empty demo database; existing accounts will not be overwritten')
  const adminPassword = await bcrypt.hash(passwordForSeed('SEED_ADMIN_PASSWORD', 'Demo-Local-Only!2026'), 10)
  const staffPassword = await bcrypt.hash(passwordForSeed('SEED_STAFF_PASSWORD', 'Demo-Local-Only!2026'), 10)

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: { passwordHash: adminPassword, role: UserRole.SUPER_ADMIN, isActive: true },
    create: { username: 'admin', passwordHash: adminPassword, role: UserRole.SUPER_ADMIN },
  })
  const demoAdminUsers = [
    { username: 'manager', role: UserRole.STORE_MANAGER },
    { username: 'service', role: UserRole.CUSTOMER_SERVICE },
    { username: 'dispatcher', role: UserRole.DISPATCHER },
    { username: 'finance', role: UserRole.FINANCE },
  ]
  for (const demoUser of demoAdminUsers) {
    await prisma.user.upsert({
      where: { username: demoUser.username },
      update: { passwordHash: adminPassword, role: demoUser.role, isActive: true },
      create: { username: demoUser.username, passwordHash: adminPassword, role: demoUser.role },
    })
  }
  await prisma.systemSetting.upsert({
    where: { key: 'funding_policy_default' },
    update: { value: FundingPolicy.PRINCIPAL_FIRST, updatedById: admin.id },
    create: { id: 'phase2-setting-funding-policy', key: 'funding_policy_default', value: FundingPolicy.PRINCIPAL_FIRST, updatedById: admin.id },
  })
  const baseTier = await prisma.staffTier.upsert({
    where: { id: 'phase2-tier-base' },
    update: { name: '标准服务级', description: '首版员工默认服务层级', level: 1, priceMultiplierBps: 10000, canAcceptOrders: true, isEnabled: true, sort: 1 },
    create: { id: 'phase2-tier-base', name: '标准服务级', description: '首版员工默认服务层级', level: 1, priceMultiplierBps: 10000, canAcceptOrders: true, isEnabled: true, sort: 1 },
  })
  const linUser = await prisma.user.upsert({
    where: { username: 'lin' },
    update: { passwordHash: staffPassword, role: UserRole.STAFF, isActive: true },
    create: { username: 'lin', passwordHash: staffPassword, role: UserRole.STAFF },
  })
  const lin = await prisma.staffProfile.upsert({
    where: { userId: linUser.id },
    update: { name: '阿凯', status: StaffStatus.IDLE, accountStatus: 'NORMAL', accepting: 'ACCEPTING', tierId: baseTier.id, commissionRateBps: 3000 },
    create: { userId: linUser.id, name: '阿凯', status: StaffStatus.IDLE, accountStatus: 'NORMAL', accepting: 'ACCEPTING', tierId: baseTier.id, commissionRateBps: 3000 },
  })
  const chenUser = await prisma.user.upsert({
    where: { username: 'chen' },
    update: { passwordHash: staffPassword, role: UserRole.STAFF, isActive: true },
    create: { username: 'chen', passwordHash: staffPassword, role: UserRole.STAFF },
  })
  const chen = await prisma.staffProfile.upsert({
    where: { userId: chenUser.id },
    update: { name: '小宇', status: StaffStatus.BUSY, accountStatus: 'NORMAL', accepting: 'ACCEPTING', tierId: baseTier.id, commissionRateBps: 3200 },
    create: { userId: chenUser.id, name: '小宇', status: StaffStatus.BUSY, accountStatus: 'NORMAL', accepting: 'ACCEPTING', tierId: baseTier.id, commissionRateBps: 3200 },
  })

  const customers = await Promise.all([
    prisma.customer.upsert({ where: { customerCode: 'DEMO001' }, update: { customerCode: 'DEMO001', teamCode: 'DEMO-TEAM-001', name: 'DEMO001', note: '常用客户' }, create: { customerCode: 'DEMO001', teamCode: 'DEMO-TEAM-001', name: 'DEMO001', phone: null, balanceCents: 0, note: '常用客户', createdAt: dateDaysAgo(15, 9, 30) } }),
    prisma.customer.upsert({ where: { customerCode: 'DEMO002' }, update: { customerCode: 'DEMO002', teamCode: 'DEMO-TEAM-002', name: 'DEMO002', note: '预约客户' }, create: { customerCode: 'DEMO002', teamCode: 'DEMO-TEAM-002', name: 'DEMO002', phone: null, balanceCents: 0, note: '预约客户', createdAt: dateDaysAgo(10, 11, 20) } }),
    prisma.customer.upsert({ where: { customerCode: 'DEMO003' }, update: { customerCode: 'DEMO003', teamCode: 'DEMO-TEAM-003', name: 'DEMO003', note: '重点客户' }, create: { customerCode: 'DEMO003', teamCode: 'DEMO-TEAM-003', name: 'DEMO003', phone: null, balanceCents: 0, note: '重点客户', createdAt: dateDaysAgo(7, 14, 10) } }),
  ])
  const [zhou, zhao, chenCustomer] = customers

  const seededRecharges = [
    { customerId: zhou.id, amountCents: 50000, note: '线下充值', createdAt: dateDaysAgo(2, 9, 30) },
    { customerId: zhou.id, amountCents: 36000, note: '历史充值', createdAt: dateDaysAgo(12, 14, 10) },
    { customerId: zhao.id, amountCents: 42000, note: '历史充值', createdAt: dateDaysAgo(8, 11, 20) },
    { customerId: chenCustomer.id, amountCents: 65000, note: '历史充值', createdAt: dateDaysAgo(5, 16, 40) },
  ]
  for (const recharge of seededRecharges) {
    const existing = await prisma.rechargeRecord.findFirst({ where: { customerId: recharge.customerId, amountCents: recharge.amountCents, note: recharge.note } })
    if (!existing) {
      await prisma.rechargeRecord.create({ data: { ...recharge, operatorId: admin.id, principalAmountCents: recharge.amountCents, bonusAmountCents: 0 } })
    }
  }
  const demoPackages = [
    { id: 'phase2-package-lol', name: '英雄联盟赛事护航', category: '英雄联盟', description: '赛前准备、现场陪练与赛事流程保障', basePriceCents: 26800, sort: 1, note: '演示套餐' },
    { id: 'phase2-package-valorant', name: '无畏契约设备调试', category: '无畏契约', description: '设备检查、画面调试与赛事前置保障', basePriceCents: 39600, sort: 2, note: '演示套餐' },
    { id: 'phase2-package-pubg', name: '绝地求生赛前保障', category: '绝地求生', description: '赛前设备与流程检查，确保现场顺利开始', basePriceCents: 31200, sort: 3, note: '演示套餐' },
    { id: 'phase2-package-honor', name: '王者荣耀赛事护航', category: '王者荣耀', description: '赛前调试、现场配合与赛后结果核对', basePriceCents: 18800, sort: 4, note: '演示套餐' },
  ]
  for (const item of demoPackages) await prisma.servicePackage.upsert({ where: { id: item.id }, update: { ...item, createdById: admin.id }, create: { ...item, createdById: admin.id } })
  const activityStart = new Date()
  activityStart.setDate(activityStart.getDate() - 30)
  const activityEnd = new Date()
  activityEnd.setDate(activityEnd.getDate() + 365)
  const rechargeActivity = await prisma.rechargeActivity.upsert({ where: { id: 'phase2-activity-demo' }, update: { name: '俱乐部充值礼遇', startAt: activityStart, endAt: activityEnd, isEnabled: true, note: '后台线下充值自动匹配最高档赠金', createdById: admin.id }, create: { id: 'phase2-activity-demo', name: '俱乐部充值礼遇', startAt: activityStart, endAt: activityEnd, isEnabled: true, note: '后台线下充值自动匹配最高档赠金', createdById: admin.id } })
  await prisma.rechargeActivityTier.deleteMany({ where: { activityId: rechargeActivity.id } })
  await prisma.rechargeActivityTier.createMany({ data: [{ activityId: rechargeActivity.id, thresholdCents: 50000, bonusCents: 5000 }, { activityId: rechargeActivity.id, thresholdCents: 100000, bonusCents: 15000 }] })
  const demoCoupon = await prisma.coupon.upsert({ where: { id: 'phase2-coupon-demo' }, update: { name: '电竞服务体验券', type: 'FIXED', amountCents: 3000, minSpendCents: 20000, startAt: activityStart, endAt: activityEnd, isEnabled: true, note: '仅用于后台订单核销演示', createdById: admin.id }, create: { id: 'phase2-coupon-demo', name: '电竞服务体验券', type: 'FIXED', amountCents: 3000, minSpendCents: 20000, startAt: activityStart, endAt: activityEnd, isEnabled: true, note: '仅用于后台订单核销演示', createdById: admin.id } })
  await prisma.customerCoupon.upsert({ where: { id: 'phase2-customer-coupon-demo' }, update: { couponId: demoCoupon.id, customerId: chenCustomer.id, issuedById: admin.id, status: 'ISSUED', usedOrderId: null, usedAt: null }, create: { id: 'phase2-customer-coupon-demo', couponId: demoCoupon.id, customerId: chenCustomer.id, issuedById: admin.id } })
  await prisma.marketingActivity.upsert({ where: { id: 'phase2-campaign-demo' }, update: { name: '新客赛事服务礼遇', type: ActivityType.NEW_CUSTOMER, rule: { description: '新客户完成首笔电竞护航订单后，由客服核验并登记服务礼遇。' }, startAt: activityStart, endAt: activityEnd, isEnabled: true, note: '后台规则配置示例，不提供前台领取', createdById: admin.id }, create: { id: 'phase2-campaign-demo', name: '新客赛事服务礼遇', type: ActivityType.NEW_CUSTOMER, rule: { description: '新客户完成首笔电竞护航订单后，由客服核验并登记服务礼遇。' }, startAt: activityStart, endAt: activityEnd, isEnabled: true, note: '后台规则配置示例，不提供前台领取', createdById: admin.id } })
  await prisma.notice.upsert({ where: { id: 'phase2-notice-demo' }, update: { type: 'ANNOUNCEMENT', title: '赛事服务排期提醒', content: '请在服务开始前确认客户需求与现场安排。', isEnabled: true, createdById: admin.id }, create: { id: 'phase2-notice-demo', type: 'ANNOUNCEMENT', title: '赛事服务排期提醒', content: '请在服务开始前确认客户需求与现场安排。', isEnabled: true, createdById: admin.id } })
  const seededOrders = [
    {
      orderNo: orderNumber(1), customerId: zhou.id, staffId: lin.id, servicePackageId: 'phase2-package-lol', requiredTierId: baseTier.id,
      serviceItem: '英雄联盟赛事护航', originalAmountCents: 26800, discountAmountCents: 0, amountCents: 26800, staffAmountCents: 8040,
      requiredStaffCount: 1, status: OrderStatus.PENDING, completionReviewStatus: CompletionReviewStatus.NOT_SUBMITTED,
      completionReviewReason: null, completionSubmittedAt: null, completionReviewedAt: null, completionReviewedById: null,
      note: '已确认 09:30 赛事时间', assignedAt: dateDaysAgo(0, 9, 30), startedAt: null, completedAt: null, createdAt: dateDaysAgo(0, 9, 30),
      slots: [{ slotIndex: 1, staffId: lin.id, commissionRateBps: 3000, expectedEarningCents: 8040, actualEarningCents: 0, assignmentStatus: OrderStaffAssignmentStatus.CLAIMED, claimedAt: dateDaysAgo(0, 9, 30), startedAt: null, completionSubmittedAt: null, completionReviewStatus: CompletionReviewStatus.NOT_SUBMITTED }],
    },
    {
      orderNo: orderNumber(2, 1), customerId: zhao.id, staffId: chen.id, servicePackageId: 'phase2-package-valorant', requiredTierId: baseTier.id,
      serviceItem: '无畏契约设备调试', originalAmountCents: 39600, discountAmountCents: 0, amountCents: 39600, staffAmountCents: 12672,
      requiredStaffCount: 1, status: OrderStatus.IN_PROGRESS, completionReviewStatus: CompletionReviewStatus.NOT_SUBMITTED,
      completionReviewReason: null, completionSubmittedAt: null, completionReviewedAt: null, completionReviewedById: null,
      note: '完成后登记赛事状态', assignedAt: dateDaysAgo(1, 11, 20), startedAt: dateDaysAgo(1, 11, 40), completedAt: null, createdAt: dateDaysAgo(1, 11, 20),
      slots: [{ slotIndex: 1, staffId: chen.id, commissionRateBps: 3200, expectedEarningCents: 12672, actualEarningCents: 0, assignmentStatus: OrderStaffAssignmentStatus.ACTIVE, claimedAt: dateDaysAgo(1, 11, 20), startedAt: dateDaysAgo(1, 11, 40), completionSubmittedAt: null, completionReviewStatus: CompletionReviewStatus.NOT_SUBMITTED }],
    },
    {
      orderNo: orderNumber(3), customerId: chenCustomer.id, staffId: lin.id, servicePackageId: 'phase2-package-honor', requiredTierId: baseTier.id,
      serviceItem: '王者荣耀赛事护航', originalAmountCents: 18800, discountAmountCents: 0, amountCents: 18800, staffAmountCents: 15040,
      requiredStaffCount: 2, status: OrderStatus.PENDING_ASSIGNMENT, completionReviewStatus: CompletionReviewStatus.NOT_SUBMITTED,
      completionReviewReason: null, completionSubmittedAt: null, completionReviewedAt: null, completionReviewedById: null,
      note: '双人协作赛事，已接 1 人，尚缺 1 人', assignedAt: dateDaysAgo(0, 14, 10), startedAt: null, completedAt: null, createdAt: dateDaysAgo(0, 14, 10),
      slots: [
        { slotIndex: 1, staffId: lin.id, commissionRateBps: 4000, expectedEarningCents: 7520, actualEarningCents: 0, assignmentStatus: OrderStaffAssignmentStatus.CLAIMED, claimedAt: dateDaysAgo(0, 14, 10), startedAt: null, completionSubmittedAt: null, completionReviewStatus: CompletionReviewStatus.NOT_SUBMITTED },
        { slotIndex: 2, staffId: null, commissionRateBps: 4000, expectedEarningCents: 7520, actualEarningCents: 0, assignmentStatus: OrderStaffAssignmentStatus.OPEN, claimedAt: null, startedAt: null, completionSubmittedAt: null, completionReviewStatus: CompletionReviewStatus.NOT_SUBMITTED },
      ],
    },
    {
      orderNo: orderNumber(4, 1), customerId: zhou.id, staffId: lin.id, servicePackageId: 'phase2-package-valorant', requiredTierId: baseTier.id,
      serviceItem: '无畏契约赛后复盘', originalAmountCents: 22600, discountAmountCents: 0, amountCents: 22600, staffAmountCents: 6780,
      requiredStaffCount: 1, status: OrderStatus.COMPLETED, completionReviewStatus: CompletionReviewStatus.APPROVED,
      completionReviewReason: null, completionSubmittedAt: dateDaysAgo(1, 18, 50), completionReviewedAt: dateDaysAgo(1, 19, 15), completionReviewedById: admin.id,
      note: '客户已确认完成', assignedAt: dateDaysAgo(1, 16, 40), startedAt: dateDaysAgo(1, 17, 0), completedAt: dateDaysAgo(1, 19, 15), createdAt: dateDaysAgo(1, 16, 40),
      slots: [{ slotIndex: 1, staffId: lin.id, commissionRateBps: 3000, expectedEarningCents: 6780, actualEarningCents: 6780, assignmentStatus: OrderStaffAssignmentStatus.COMPLETED, claimedAt: dateDaysAgo(1, 16, 40), startedAt: dateDaysAgo(1, 17, 0), completionSubmittedAt: dateDaysAgo(1, 18, 50), completionReviewStatus: CompletionReviewStatus.APPROVED }],
    },
    {
      orderNo: orderNumber(5, 3), customerId: zhao.id, staffId: chen.id, servicePackageId: 'phase2-package-pubg', requiredTierId: baseTier.id,
      serviceItem: '绝地求生赛前保障', originalAmountCents: 31200, discountAmountCents: 0, amountCents: 31200, staffAmountCents: 9984,
      requiredStaffCount: 1, status: OrderStatus.COMPLETED, completionReviewStatus: CompletionReviewStatus.APPROVED,
      completionReviewReason: null, completionSubmittedAt: dateDaysAgo(3, 11, 50), completionReviewedAt: dateDaysAgo(3, 12, 10), completionReviewedById: admin.id,
      note: '赛事保障记录已归档', assignedAt: dateDaysAgo(3, 10, 40), startedAt: dateDaysAgo(3, 11, 0), completedAt: dateDaysAgo(3, 12, 10), createdAt: dateDaysAgo(3, 10, 40),
      slots: [{ slotIndex: 1, staffId: chen.id, commissionRateBps: 3200, expectedEarningCents: 9984, actualEarningCents: 9984, assignmentStatus: OrderStaffAssignmentStatus.COMPLETED, claimedAt: dateDaysAgo(3, 10, 40), startedAt: dateDaysAgo(3, 11, 0), completionSubmittedAt: dateDaysAgo(3, 11, 50), completionReviewStatus: CompletionReviewStatus.APPROVED }],
    },
    {
      orderNo: orderNumber(6, 3), customerId: chenCustomer.id, staffId: lin.id, servicePackageId: 'phase2-package-honor', requiredTierId: baseTier.id,
      serviceItem: '王者荣耀赛前调试', originalAmountCents: 18800, discountAmountCents: 2000, amountCents: 16800, staffAmountCents: 5040,
      requiredStaffCount: 1, status: OrderStatus.COMPLETED, completionReviewStatus: CompletionReviewStatus.APPROVED,
      completionReviewReason: null, completionSubmittedAt: dateDaysAgo(3, 20, 40), completionReviewedAt: dateDaysAgo(3, 21, 0), completionReviewedById: admin.id,
      note: '月度赛事保障记录', assignedAt: dateDaysAgo(3, 19, 15), startedAt: dateDaysAgo(3, 19, 35), completedAt: dateDaysAgo(3, 21, 0), createdAt: dateDaysAgo(3, 19, 15),
      slots: [{ slotIndex: 1, staffId: lin.id, commissionRateBps: 3000, expectedEarningCents: 5040, actualEarningCents: 5040, assignmentStatus: OrderStaffAssignmentStatus.COMPLETED, claimedAt: dateDaysAgo(3, 19, 15), startedAt: dateDaysAgo(3, 19, 35), completionSubmittedAt: dateDaysAgo(3, 20, 40), completionReviewStatus: CompletionReviewStatus.APPROVED }],
    },
    {
      orderNo: orderNumber(7), customerId: zhou.id, staffId: lin.id, servicePackageId: 'phase2-package-lol', requiredTierId: baseTier.id,
      serviceItem: '英雄联盟双人协作护航', originalAmountCents: 26800, discountAmountCents: 0, amountCents: 26800, staffAmountCents: 21440,
      requiredStaffCount: 2, status: OrderStatus.PENDING_COMPLETION_REVIEW, completionReviewStatus: CompletionReviewStatus.SUBMITTED,
      completionReviewReason: null, completionSubmittedAt: dateDaysAgo(0, 13, 50), completionReviewedAt: null, completionReviewedById: null,
      note: '两位员工均已提交完单凭证，等待后台审核', assignedAt: dateDaysAgo(0, 10, 20), startedAt: dateDaysAgo(0, 10, 40), completedAt: null, createdAt: dateDaysAgo(0, 10, 20),
      slots: [
        { slotIndex: 1, staffId: lin.id, commissionRateBps: 4000, expectedEarningCents: 10720, actualEarningCents: 0, assignmentStatus: OrderStaffAssignmentStatus.ACTIVE, claimedAt: dateDaysAgo(0, 10, 20), startedAt: dateDaysAgo(0, 10, 40), completionSubmittedAt: dateDaysAgo(0, 13, 40), completionReviewStatus: CompletionReviewStatus.SUBMITTED },
        { slotIndex: 2, staffId: chen.id, commissionRateBps: 4000, expectedEarningCents: 10720, actualEarningCents: 0, assignmentStatus: OrderStaffAssignmentStatus.ACTIVE, claimedAt: dateDaysAgo(0, 10, 30), startedAt: dateDaysAgo(0, 10, 40), completionSubmittedAt: dateDaysAgo(0, 13, 50), completionReviewStatus: CompletionReviewStatus.SUBMITTED },
      ],
    },
  ]

  const seededAssignments = new Map<string, { id: string; orderId: string; staffId: string | null }>()
  for (const seededOrder of seededOrders) {
    const { slots, ...order } = seededOrder
    const existing = await prisma.order.findFirst({
      where: {
        OR: [
          { orderNo: order.orderNo },
          { customerId: order.customerId, serviceItem: order.serviceItem, amountCents: order.amountCents, staffAmountCents: order.staffAmountCents },
        ],
      },
      orderBy: { createdAt: 'desc' },
    })
    const saved = existing
      ? await prisma.order.update({ where: { id: existing.id }, data: order })
      : await prisma.order.create({ data: order })
    for (const slot of slots) {
      const currentAssignment = await prisma.orderStaffAssignment.findFirst({
        where: { orderId: saved.id, slotIndex: slot.slotIndex, assignmentStatus: { not: OrderStaffAssignmentStatus.EXITED } },
        orderBy: { createdAt: 'desc' },
      })
      const assignmentData = {
        ...slot,
        orderId: saved.id,
        completionReviewReason: null,
        exitReviewStatus: 'NONE' as const,
        exitRequestedAt: null,
        exitReason: null,
        exitReviewedAt: null,
        exitReviewNote: null,
        exitReviewedById: null,
      }
      const assignment = currentAssignment
        ? await prisma.orderStaffAssignment.update({ where: { id: currentAssignment.id }, data: assignmentData })
        : await prisma.orderStaffAssignment.create({ data: assignmentData })
      seededAssignments.set(`${saved.orderNo}:${slot.slotIndex}`, assignment)
    }
    if (saved.status === OrderStatus.COMPLETED) {
      await prisma.consumptionRecord.updateMany({ where: { orderId: saved.id }, data: { note: `演示订单 ${saved.orderNo} 完成消费`, createdAt: saved.completedAt ?? saved.createdAt } })
    }
  }

  const proofDirectory = path.resolve(process.cwd(), 'uploads', 'order-proofs')
  const proofSource = path.resolve(process.cwd(), 'scripts', 'fixtures', 'demo-proof.png')
  await mkdir(proofDirectory, { recursive: true })
  const proofSize = (await stat(proofSource)).size
  for (const [slotIndex, staff] of [[1, lin], [2, chen]] as const) {
    const assignment = seededAssignments.get(`${orderNumber(7)}:${slotIndex}`)
    if (!assignment) throw new Error(`完单审核演示名额 ${slotIndex} 初始化失败`)
    const filename = `phase2-review-proof-${slotIndex}.png`
    const proofPath = `uploads/order-proofs/${filename}`
    await copyFile(proofSource, path.join(proofDirectory, filename))
    await prisma.orderCompletionProof.upsert({
      where: { id: `phase2-review-proof-${slotIndex}` },
      update: { assignmentId: assignment.id, orderId: assignment.orderId, staffId: staff.id, proofPath, mimeType: 'image/png', sizeBytes: proofSize, note: slotIndex === 1 ? '已完成赛事陪练与结果核对。' : '已完成设备保障与现场流程确认。', submittedAt: dateDaysAgo(0, 13, slotIndex === 1 ? 40 : 50), reviewStatus: CompletionReviewStatus.SUBMITTED },
      create: { id: `phase2-review-proof-${slotIndex}`, assignmentId: assignment.id, orderId: assignment.orderId, staffId: staff.id, proofPath, mimeType: 'image/png', sizeBytes: proofSize, note: slotIndex === 1 ? '已完成赛事陪练与结果核对。' : '已完成设备保障与现场流程确认。', submittedAt: dateDaysAgo(0, 13, slotIndex === 1 ? 40 : 50), reviewStatus: CompletionReviewStatus.SUBMITTED },
    })
  }

  const reconcileBalances = async () => {
    for (const customer of customers) {
      const [rechargeTotal, consumptionTotal] = await Promise.all([
        prisma.rechargeRecord.aggregate({ where: { customerId: customer.id }, _sum: { amountCents: true } }),
        prisma.consumptionRecord.aggregate({ where: { customerId: customer.id }, _sum: { amountCents: true } }),
      ])
      const balanceCents = (rechargeTotal._sum.amountCents ?? 0) - (consumptionTotal._sum.amountCents ?? 0)
      if (balanceCents < 0) throw new Error(`客户 ${customer.name} 的演示余额不能为负数`)
      await prisma.customer.update({ where: { id: customer.id }, data: { balanceCents, principalBalanceCents: balanceCents, bonusBalanceCents: 0 } })
    }
  }

  await reconcileBalances()

  const reconcileFundTransactions = async () => {
    for (const customer of customers) {
      const [recharges, consumptions] = await Promise.all([
        prisma.rechargeRecord.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'asc' } }),
        prisma.consumptionRecord.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'asc' } }),
      ])
      const events = [
        ...recharges.map((item) => ({ kind: 'recharge' as const, item, at: item.createdAt })),
        ...consumptions.map((item) => ({ kind: 'consumption' as const, item, at: item.createdAt })),
      ].sort((a, b) => a.at.getTime() - b.at.getTime())
      let principal = 0
      let bonus = 0
      for (const event of events) {
        const beforePrincipal = principal
        const beforeBonus = bonus
        const amount = event.kind === 'recharge' ? event.item.principalAmountCents : -event.item.amountCents
        principal += amount
        const existing = event.kind === 'consumption'
          ? await prisma.fundTransaction.findFirst({ where: { orderId: event.item.orderId, type: FundTransactionType.PRINCIPAL_CONSUMPTION } })
          : await prisma.fundTransaction.findFirst({ where: { customerId: customer.id, type: FundTransactionType.PRINCIPAL_RECHARGE, amountCents: event.item.principalAmountCents, createdAt: event.item.createdAt } })
        const data = {
          customerId: customer.id,
          operatorId: admin.id,
          orderId: event.kind === 'consumption' ? event.item.orderId : null,
          type: event.kind === 'recharge' ? FundTransactionType.PRINCIPAL_RECHARGE : FundTransactionType.PRINCIPAL_CONSUMPTION,
          amountCents: amount,
          principalBeforeCents: beforePrincipal,
          principalAfterCents: principal,
          bonusBeforeCents: beforeBonus,
          bonusAfterCents: bonus,
          balanceBeforeCents: beforePrincipal + beforeBonus,
          balanceAfterCents: principal + bonus,
          note: event.kind === 'recharge' ? event.item.note || '演示本金充值' : event.item.note || '历史订单消费',
          createdAt: event.at,
        }
        if (existing) await prisma.fundTransaction.update({ where: { id: existing.id }, data })
        else await prisma.fundTransaction.create({ data })
      }
    }
  }
  const seededOrderNos = seededOrders.map((order) => order.orderNo)
  const completedSeedOrders = await prisma.order.findMany({
    where: { orderNo: { in: seededOrderNos }, status: OrderStatus.COMPLETED },
    select: { id: true, orderNo: true, customerId: true, amountCents: true, completedAt: true, createdAt: true },
  })
  for (const order of completedSeedOrders) {
    const existing = await prisma.consumptionRecord.findUnique({ where: { orderId: order.id } })
    if (existing) continue
    await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: order.customerId }, select: { balanceCents: true } })
      if (!customer || customer.balanceCents < order.amountCents) throw new Error(`客户余额不足，无法初始化订单 ${order.orderNo} 的消费流水`)
      const balanceBeforeCents = customer.balanceCents
      const balanceAfterCents = balanceBeforeCents - order.amountCents
      await tx.customer.update({ where: { id: order.customerId }, data: { balanceCents: balanceAfterCents, principalBalanceCents: balanceAfterCents, bonusBalanceCents: 0 } })
      const record = await tx.consumptionRecord.create({
        data: {
          customerId: order.customerId,
          orderId: order.id,
          operatorId: admin.id,
          amountCents: order.amountCents,
          balanceBeforeCents,
          balanceAfterCents,
          note: `演示订单 ${order.orderNo} 完成消费`,
          createdAt: order.completedAt ?? order.createdAt,
        },
      })
      // Complete the current ledger fixture as well as the retained compatibility record.
      // Demo recharges are principal-only, so the split is explicit and lossless.
      await tx.orderConsumption.create({ data: {
        orderId: order.id, customerId: order.customerId, operatorId: admin.id,
        totalAmountCents: order.amountCents, principalUsedCents: order.amountCents, bonusUsedCents: 0,
        principalBeforeCents: balanceBeforeCents, principalAfterCents: balanceAfterCents,
        bonusBeforeCents: 0, bonusAfterCents: 0, createdAt: order.completedAt ?? order.createdAt,
      } })
      await tx.operationLog.create({
        data: {
          operatorId: admin.id,
          action: 'CONSUME',
          entityType: 'CUSTOMER',
          entityId: order.customerId,
          detail: { orderId: order.id, orderNo: order.orderNo, amountCents: order.amountCents, balanceBeforeCents, balanceAfterCents, recordId: record.id, seeded: true },
          createdAt: order.completedAt ?? order.createdAt,
        },
      })
    })
  }

  await reconcileBalances()
  await reconcileFundTransactions()

  const demoAfterSaleOrder = await prisma.order.findUnique({ where: { orderNo: orderNumber(4, 1) }, select: { id: true, orderNo: true, customerId: true, staffId: true, completedAt: true, createdAt: true } })
  if (demoAfterSaleOrder?.staffId) {
    const messageContent = '已登记服务异常，等待进一步处理。'
    const afterSaleData = {
      caseNo: 'AS20260902001',
      orderId: demoAfterSaleOrder.id,
      customerId: demoAfterSaleOrder.customerId,
      staffId: demoAfterSaleOrder.staffId,
      createdById: admin.id,
      issueType: '服务异常',
      description: '客户反馈服务过程中出现异常，已登记待处理。',
      status: AfterSaleStatus.PROCESSING,
      resultType: null,
      compensationCents: 0,
      refundCents: 0,
      handlingNote: '已登记说明，等待处理',
      handlerId: null,
      handledAt: null,
      createdAt: demoAfterSaleOrder.completedAt ?? demoAfterSaleOrder.createdAt,
    }
    const existingByOrder = await prisma.afterSaleCase.findUnique({ where: { orderId: demoAfterSaleOrder.id } })
    const stableCase = existingByOrder ?? await prisma.afterSaleCase.findUnique({ where: { id: 'phase2-after-sale-demo' } })
    const demoAfterSale = stableCase
      ? await prisma.afterSaleCase.update({ where: { id: stableCase.id }, data: afterSaleData })
      : await prisma.afterSaleCase.create({ data: { id: 'phase2-after-sale-demo', ...afterSaleData } })
    const existingMessage = await prisma.afterSaleMessage.findFirst({ where: { caseId: demoAfterSale.id, content: messageContent } })
    if (!existingMessage) await prisma.afterSaleMessage.create({ data: { caseId: demoAfterSale.id, authorId: admin.id, content: messageContent, createdAt: afterSaleData.createdAt } })
  }

  console.log(`Seeded ${admin.username}, ${linUser.username}, ${chenUser.username} and ${seededOrders.length} demo orders`)
}

main().catch((error) => {
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Demo seed failed; check the local database configuration')
  process.exitCode = 1
}).finally(() => prisma.$disconnect())

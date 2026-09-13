import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { testEnvironment } from './feedback-isolated-env.mjs'

const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const evidence = { database: 'club_management_showcase_test', checks: [] }
try {
  const admin = await db.user.findUniqueOrThrow({ where: { username: 'admin' } })
  const staff = await db.staffProfile.findFirstOrThrow({ where: { accountStatus: 'NORMAL', user: { role: 'STAFF' } } })
  const marker = randomUUID().slice(0, 8)
  const customer = await db.customer.create({ data: { name: '独立状态机验收', customerCode: `LC-${marker}`, teamCode: `LC-${marker}`, principalBalanceCents: 100000, balanceCents: 100000 } })
  const token = jwt.sign({ userId: admin.id }, env.JWT_SECRET)
  const request = async (route, body, expected, method = 'POST', userToken = token) => {
    const r = await fetch(`http://127.0.0.1:4210/api${route}`, { method, headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await r.json()
    assert.equal(r.status, expected, JSON.stringify(data))
    return data
  }
  const make = (status, review, suffix, extra = {}) => db.order.create({ data: {
    orderNo: `LC-${marker}-${suffix}`, customerId: customer.id, staffId: staff.id, createdById: admin.id,
    serviceItem: '独立状态机验收', originalAmountCents: 20000, amountCents: 20000, staffAmountCents: 10000,
    status, startedAt: new Date(), completionReviewStatus: review,
    assignments: { create: { staffId: staff.id, slotIndex: 1, commissionRateBps: 5000, expectedEarningCents: 10000, actualEarningCents: 0, assignmentStatus: 'ACTIVE', completionReviewStatus: review } },
    ...extra,
  } })
  const bodyFor = orderId => ({ orderId, issueType: '独立回归', description: '只在独立验证库执行' })
  const reject = async (order, userToken = token) => {
    const before = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    const r = await request('/after-sales', bodyFor(order.id), 409, 'POST', userToken)
    assert.equal(r.message, '订单尚未完成最终审核和结算，暂不能创建正式售后。')
    assert.deepEqual(await db.order.findUniqueOrThrow({ where: { id: order.id } }), before)
    assert.equal(await db.afterSaleCase.count({ where: { orderId: order.id } }), 0)
    assert.equal(await db.fundTransaction.count({ where: { orderId: order.id } }), 0)
  }
  const inProgress = await make('IN_PROGRESS', 'NOT_SUBMITTED', 'INPROGRESS')
  await reject(inProgress)
  await reject(inProgress, jwt.sign({ userId: staff.userId }, env.JWT_SECRET))
  evidence.checks.push('服务中：管理员/参与员工绕过前端直接调用均被拒绝，主状态和账务不变')
  const pending = await make('PENDING_COMPLETION_REVIEW', 'SUBMITTED', 'PENDING')
  await reject(pending)
  await request(`/orders/${pending.id}/completion-review`, { approved: false, reason: '独立回归退回' }, 200)
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).status, 'IN_PROGRESS')
  await reject(pending)
  evidence.checks.push('待审核不能创建售后，管理员正常驳回；驳回后仍不能创建售后')
  const settled = await make('PENDING_COMPLETION_REVIEW', 'SUBMITTED', 'SETTLED')
  await reject(settled)
  await request(`/orders/${settled.id}/completion-review`, { approved: true }, 200)
  const finalized = await db.order.findUniqueOrThrow({ where: { id: settled.id } })
  const consumption = await db.orderConsumption.findUniqueOrThrow({ where: { orderId: settled.id } })
  const funds = await db.fundTransaction.findMany({ where: { orderId: settled.id }, orderBy: { id: 'asc' } })
  const assignments = await db.orderStaffAssignment.findMany({ where: { orderId: settled.id } })
  const balance = (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balanceCents
  assert.equal(balance, 80000)
  const sale = (await request('/after-sales', bodyFor(settled.id), 201)).item
  const after = await db.order.findUniqueOrThrow({ where: { id: settled.id } })
  assert.equal(after.status, 'AFTER_SALE')
  assert.equal(after.completionReviewStatus, 'APPROVED')
  assert.deepEqual(after.completedAt, finalized.completedAt)
  assert.deepEqual(after.completionReviewedAt, finalized.completionReviewedAt)
  evidence.checks.push('真实审核结算后可创建售后，兼容 AFTER_SALE 标记，completedAt/审核结果/原始结算保留')
  await request(`/after-sales/${sale.id}`, { status: 'PROCESSING', handlingNote: '独立回归处理中' }, 200, 'PATCH')
  assert.equal((await db.afterSaleCase.findUniqueOrThrow({ where: { id: sale.id } })).status, 'PROCESSING')
  const finish = { status: 'COMPLETED', handlingNote: '独立回归完成，不涉及补偿' }
  await request(`/after-sales/${sale.id}`, finish, 200, 'PATCH')
  await request(`/after-sales/${sale.id}`, finish, 200, 'PATCH')
  assert.equal((await db.afterSaleCase.findUniqueOrThrow({ where: { id: sale.id } })).status, 'COMPLETED')
  assert.deepEqual((await db.order.findUniqueOrThrow({ where: { id: settled.id } })).completedAt, finalized.completedAt)
  assert.deepEqual(await db.orderConsumption.findUniqueOrThrow({ where: { orderId: settled.id } }), consumption)
  assert.deepEqual(await db.fundTransaction.findMany({ where: { orderId: settled.id }, orderBy: { id: 'asc' } }), funds)
  assert.deepEqual(await db.orderStaffAssignment.findMany({ where: { orderId: settled.id } }), assignments)
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balanceCents, balance)
  assert.equal(await db.fundTransaction.count({ where: { afterSaleCaseId: sale.id } }), 0)
  evidence.checks.push('售后处理/完成独立变化；重复完成售后不重复结算，不改原流水、余额或员工收益')
  await request('/after-sales', bodyFor(settled.id), 409)
  assert.equal(await db.afterSaleCase.count({ where: { orderId: settled.id } }), 1)
  const noRecord = await make('COMPLETED', 'APPROVED', 'NO-RECORD', { completedAt: new Date() })
  await reject(noRecord)
  const noDate = await make('COMPLETED', 'APPROVED', 'NO-DATE')
  await reject(noDate)
  evidence.checks.push('伪完成/缺结算/缺 completedAt 均拒绝；同一订单不可重复建售后')
  // Separate finalized order remains eligible for browser selector checks.
  const eligible = await make('PENDING_COMPLETION_REVIEW', 'SUBMITTED', 'ELIGIBLE')
  await request(`/orders/${eligible.id}/completion-review`, { approved: true }, 200)
  Object.assign(evidence, { inProgressId: inProgress.id, pendingId: pending.id, settledId: settled.id, eligibleId: eligible.id, eligibleNo: eligible.orderNo, unsettledNo: inProgress.orderNo })
  fs.writeFileSync('output/after-sale-lifecycle-20260908/state-machine-tests.json', JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally { await db.$disconnect() }

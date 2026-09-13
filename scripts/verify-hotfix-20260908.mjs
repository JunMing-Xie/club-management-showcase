import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { testEnvironment } from './feedback-isolated-env.mjs'

const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const results = []
try {
  const admin = await db.user.findUniqueOrThrow({ where: { username: 'admin' } })
  const staff = await db.staffProfile.findFirstOrThrow({ where: { user: { role: 'STAFF' }, accountStatus: 'NORMAL' } })
  const token = jwt.sign({ userId: admin.id }, env.JWT_SECRET)
  const request = async (route, body, expected) => {
    const r = await fetch(`http://127.0.0.1:4210/api${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await r.json()
    assert.equal(r.status, expected, JSON.stringify(data))
    return data
  }
  const marker = randomUUID().slice(0, 8)
  const customer = await db.customer.create({ data: { name: '独立修复验收', customerCode: `HF-${marker}`, teamCode: `HF-${marker}`, principalBalanceCents: 100000, balanceCents: 100000 } })
  const make = (status, suffix) => db.order.create({ data: {
    orderNo: `HF-${marker}-${suffix}`, customerId: customer.id, staffId: staff.id, createdById: admin.id,
    serviceItem: '独立修复验收', originalAmountCents: 20000, amountCents: 20000, staffAmountCents: 10000,
    status, startedAt: new Date(), completionReviewStatus: 'SUBMITTED', completionSubmittedAt: new Date(),
    assignments: { create: { staffId: staff.id, slotIndex: 1, commissionRateBps: 5000, expectedEarningCents: 10000, actualEarningCents: 0, assignmentStatus: 'ACTIVE', completionReviewStatus: 'SUBMITTED', startedAt: new Date(), completionSubmittedAt: new Date() } },
  }, include: { assignments: true } })
  const unsettled = await make('AFTER_SALE', 'UNSETTLED')
  const before = await db.customer.findUniqueOrThrow({ where: { id: customer.id } })
  const rejected = await request(`/orders/${unsettled.id}/adjustments`, { requestId: randomUUID(), netAmount: 150, staffNetEarnings: [], reason: '独立验收' }, 409)
  assert.equal(rejected.message, '该订单尚未完成最终审核和结算，暂不能进行售后金额调整。')
  assert.equal(await db.fundTransaction.count({ where: { orderId: unsettled.id } }), 0)
  assert.equal(await db.orderAdjustment.count({ where: { orderId: unsettled.id } }), 0)
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balanceCents, before.balanceCents)
  results.push('未结算订单拒绝调整，无资金或调整记录，无余额变化')
  const settled = await make('PENDING_COMPLETION_REVIEW', 'SETTLED')
  await request(`/orders/${settled.id}/completion-review`, { approved: true }, 200)
  const original = await db.orderConsumption.findUniqueOrThrow({ where: { orderId: settled.id } })
  assert.equal(original.totalAmountCents, 20000)
  const originalFunds = await db.fundTransaction.findMany({ where: { orderId: settled.id } })
  const balanceAfterCompletion = (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balanceCents
  assert.equal(balanceAfterCompletion, before.balanceCents - 20000)
  const body = { requestId: randomUUID(), netAmount: 150, staffNetEarnings: [{ assignmentId: settled.assignments[0].id, amount: 75 }], reason: '独立验证 200 到 150' }
  const first = await request(`/orders/${settled.id}/adjustments`, body, 201)
  assert.equal(first.adjustment.orderAmountDeltaCents, -5000)
  assert.equal(first.item.currentNetAmountCents, 15000)
  assert.equal(first.item.currentStaffEarningTotalCents, 7500)
  const again = await request(`/orders/${settled.id}/adjustments`, body, 200)
  assert.equal(again.idempotent, true)
  assert.deepEqual(await db.orderConsumption.findUniqueOrThrow({ where: { orderId: settled.id } }), original)
  for (const fund of originalFunds) assert.deepEqual(await db.fundTransaction.findUniqueOrThrow({ where: { id: fund.id } }), fund)
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balanceCents, balanceAfterCompletion + 5000)
  assert.equal(await db.orderAdjustment.count({ where: { orderId: settled.id } }), 1)
  const delta = await db.fundTransaction.findMany({ where: { orderId: settled.id, type: 'ORDER_ADJUSTMENT' } })
  assert.equal(delta.length, 1)
  assert.equal(delta[0].amountCents, 5000)
  results.push('原 200 消费保留，净额 150，差额 -50，账户返还 50，员工净收益 75，重复提交不重复退款')
  fs.writeFileSync('output/hotfix-20260908/financial-validation.json', JSON.stringify({ database: 'club_management_showcase_test', results, unsettledId: unsettled.id, settledId: settled.id, staffUsername: (await db.user.findUniqueOrThrow({ where: { id: staff.userId } })).username }, null, 2))
  console.log(JSON.stringify(results))
} finally { await db.$disconnect() }

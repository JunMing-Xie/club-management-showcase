import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { testEnvironment } from './feedback-isolated-env.mjs'

const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const checks = []
try {
  const admin = await p.user.findUniqueOrThrow({ where: { username: 'admin' } })
  const token = jwt.sign({ userId: admin.id }, env.JWT_SECRET)
  const get = async (query, path = '/finance/staff-settlement-summary') => {
    const r = await fetch('http://127.0.0.1:4210/api' + path + '?' + new URLSearchParams(query), { headers: { Authorization: `Bearer ${token}` } })
    const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data.item
  }
  const current = await get({ period: 'week' })
  assert.equal(current.range.timeZone, 'Asia/Shanghai')
  const monday = new Date(current.range.startDate + 'T00:00:00+08:00')
  const sundayEnd = new Date(current.range.endDate + 'T23:59:59.999+08:00')
  const before = new Date(monday.getTime() - 1)
  const inside = new Date(monday.getTime() + 3600000)
  const query = { period: 'custom', startDate: current.range.startDate, endDate: current.range.endDate }
  const marker = randomUUID().slice(0, 6)
  const customer = await p.customer.create({ data: { name: '独立工资统计验收', customerCode: `PAY-${marker}`, teamCode: `PAY-${marker}`, balanceCents: 1000000, principalBalanceCents: 1000000 } })
  const staff = async label => (await p.user.create({ data: { username: `PAY-${marker}-${label}`, role: 'STAFF', passwordHash: 'isolated-no-login', staffProfile: { create: { name: `工资验收 ${label} ${marker}`, accountStatus: 'NORMAL' } } }, include: { staffProfile: true } })).staffProfile
  const a = await staff('A'), b = await staff('B'), c = await staff('C'), d1 = await staff('D1'), d2 = await staff('D2'), e = await staff('E'), f = await staff('F')
  let sequence = 0
  const order = (people, amount, earnings, at) => p.order.create({ data: {
    orderNo: `PAY-${marker}-${++sequence}`, customerId: customer.id, createdById: admin.id, serviceItem: '独立工资统计订单',
    amountCents: amount, originalAmountCents: amount, staffAmountCents: earnings.reduce((a, b) => a + b, 0), requiredStaffCount: people.length,
    status: 'COMPLETED', completionReviewStatus: 'APPROVED', completedAt: at, completionReviewedAt: at,
    assignments: { create: people.map((s, index) => ({ staffId: s.id, slotIndex: index + 1, commissionRateBps: Math.round(earnings[index] / amount * 10000), expectedEarningCents: earnings[index], actualEarningCents: earnings[index], assignmentStatus: 'COMPLETED', completionReviewStatus: 'APPROVED', completedAt: at })) },
    orderConsumption: { create: { customerId: customer.id, operatorId: admin.id, totalAmountCents: amount, principalUsedCents: amount, principalBeforeCents: 1000000, principalAfterCents: 1000000 - amount, bonusBeforeCents: 0, bonusAfterCents: 0 } },
  }, include: { assignments: true } })
  const pay = (s, amount, at) => p.settlementRecord.create({ data: { requestId: randomUUID(), staffId: s.id, operatorId: admin.id, amountCents: amount, settlementMethod: '独立统计样本', settledAt: at } })
  const adjust = (o, employee, delta, at) => p.orderAdjustment.create({ data: {
    requestId: randomUUID(), orderId: o.id, operatorId: admin.id, reason: '独立统计调整', orderAmountBeforeCents: o.amountCents, orderAmountDeltaCents: 0, orderAmountAfterCents: o.amountCents, createdAt: at,
    staffAdjustments: { create: { assignmentId: o.assignments[0].id, staffId: employee.id, earningBeforeCents: o.assignments[0].actualEarningCents, earningDeltaCents: delta, earningAfterCents: o.assignments[0].actualEarningCents + delta, createdAt: at } },
  } })
  const aOrder = await order([a], 100000, [80000], inside); await pay(a, 50000, inside)
  await order([b], 10000, [10000], before); await order([b], 40000, [40000], inside); await pay(b, 35000, inside)
  const cOrder = await order([c], 50000, [50000], before); await pay(c, 50000, before); await adjust(cOrder, c, -3000, inside)
  const revenueBefore = (await get({ startDate: current.range.startDate, endDate: current.range.endDate }, '/finance/overview')).revenueCents
  await order([d1, d2], 50000, [20000, 20000], inside)
  const revenueAfter = (await get({ startDate: current.range.startDate, endDate: current.range.endDate }, '/finance/overview')).revenueCents
  assert.equal(revenueAfter - revenueBefore, 50000)
  await order([e], 50000, [50000], before); await pay(e, 50000, inside)
  const endOrder = await order([f], 10000, [7000], sundayEnd)
  await adjust(endOrder, f, -1000, new Date(sundayEnd.getTime() + 1))
  const g = await staff('G')
  const monthRange = (await get({ period: 'month' })).range
  const previousMonthEnd = new Date(new Date(monthRange.startDate + 'T00:00:00+08:00').getTime() - 1)
  await order([g], 10000, [7000], previousMonthEnd)
  await p.order.create({ data: {
    orderNo: `PAY-${marker}-LEGACY`, customerId: customer.id, createdById: admin.id, serviceItem: '旧消费记录只读兼容', amountCents: 10000, originalAmountCents: 10000, staffAmountCents: 4000,
    status: 'COMPLETED', completionReviewStatus: 'APPROVED', completedAt: inside,
    assignments: { create: { staffId: g.id, slotIndex: 1, commissionRateBps: 4000, expectedEarningCents: 4000, actualEarningCents: 4000, assignmentStatus: 'COMPLETED', completionReviewStatus: 'APPROVED', completedAt: inside } },
    consumptionRecord: { create: { customerId: customer.id, operatorId: admin.id, amountCents: 10000, balanceBeforeCents: 1000000, balanceAfterCents: 990000 } },
  } })
  const report = await get(query)
  const row = s => report.items.find(i => i.staffId === s.id)
  assert.deepEqual([row(g).orderCount, row(g).participationAmountCents, row(g).periodNetEarningCents], [1, 10000, 4000])
  assert.equal((await get({ period: 'lastMonth' })).items.find(i => i.staffId === g.id).periodNetEarningCents, 7000)
  checks.push('旧消费记录完单工资不遗漏；上月末收益70归上月，本月旧模型收益40归本月')
  assert.deepEqual([row(a).participationAmountCents, row(a).periodNetEarningCents, row(a).periodSettledCents, row(a).pendingCents], [100000, 80000, 50000, 30000]); checks.push('A：参与1000/净800/付500/待300')
  assert.deepEqual([row(b).openingPendingCents, row(b).periodNetEarningCents, row(b).periodSettledCents, row(b).pendingCents], [10000, 40000, 35000, 15000]); checks.push('B：期初100+本期400-付款350=期末150')
  assert.deepEqual([row(c).cumulativeEarningCents, row(c).cumulativeSettledCents, row(c).pendingCents, row(c).offsetCents, row(c).adjustmentCents], [47000, 50000, 0, 3000, -3000]); checks.push('C：售后-30形成待冲抵30，不出现负待结算')
  for (const s of [d1, d2]) assert.deepEqual([row(s).orderCount, row(s).participationAmountCents, row(s).periodNetEarningCents], [1, 50000, 20000])
  checks.push('D：双人各参与500/净200，公司收入只增加500')
  const previous = await get({ period: 'lastWeek' }); const priorE = previous.items.find(i => i.staffId === e.id)
  assert.deepEqual([priorE.periodNetEarningCents, priorE.periodSettledCents, priorE.pendingCents], [50000, 0, 50000])
  assert.deepEqual([row(e).periodNetEarningCents, row(e).periodSettledCents, row(e).pendingCents], [0, 50000, 0]); checks.push('E：周日收益归上周，周一付款归本周')
  assert.equal(row(f).periodNetEarningCents, 7000)
  assert.equal(row(f).adjustmentCents, 0); checks.push('结束日23:59:59.999计入，下一毫秒调整不倒灌')
  for (const period of ['month', 'lastMonth', 'week', 'lastWeek']) {
    const fast = await get({ period }); const custom = await get({ period: 'custom', startDate: fast.range.startDate, endDate: fast.range.endDate })
    assert.deepEqual(fast, custom)
  }
  checks.push('F：本月/上月/本周/上周与相同自定义区间一致')
  const thisMonth = await get({ period: 'month' })
  const nextWeekStart = new Date(sundayEnd.getTime() + 1)
  const nextQuery = { period: 'custom', startDate: nextWeekStart.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), endDate: new Date(nextWeekStart.getTime() + 6 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) }
  const next = await get(nextQuery); const nextC = next.items.find(i => i.staffId === c.id)
  assert.equal(nextC.openingOffsetCents, 3000); assert.equal(nextC.offsetCents, 3000)
  checks.push('期初待冲抵正确带入下期，不被截断丢失')
  for (const field of ['pendingCents', 'offsetCents']) assert.equal(report.summary[field], report.items.reduce((sum, r) => sum + r[field], 0))
  assert.equal(thisMonth.range.startDate.slice(-2), '01')
  const denied = await fetch('http://127.0.0.1:4210/api/finance/staff-settlement-summary', { headers: { Authorization: 'Bearer ' + jwt.sign({ userId: a.userId }, env.JWT_SECRET) } }); assert.equal(denied.status, 403)
  const invalid = await fetch('http://127.0.0.1:4210/api/finance/staff-settlement-summary?period=custom&startDate=2026-09-08', { headers: { Authorization: 'Bearer ' + token } }); assert.equal(invalid.status, 400)
  checks.push('员工角色403；不完整自定义日期400；汇总逐人匹配，冲抵不跨员工抵销')
  fs.writeFileSync('output/finance-settlement-20260908/api-tests.json', JSON.stringify({ checks, aId: a.id, aName: a.name, aOrderId: aOrder.id, aAssignmentId: aOrder.assignments[0].id, range: report.range }, null, 2))
  console.log(JSON.stringify(checks))
} finally { await p.$disconnect() }

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { io } from 'socket.io-client'
import { testEnvironment, isolatedDatabase } from './feedback-isolated-env.mjs'
const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).pathname, '/' + isolatedDatabase)
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const base = env.BASE_URL
const token = (user) => jwt.sign({ userId: user.id }, env.JWT_SECRET, { expiresIn: '2h' })
const request = async (url, user, method = 'GET', body, status = 200) => {
  const r = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token(user), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const data = await r.json()
  assert.equal(r.status, status, `${method} ${url}: ${JSON.stringify(data)}`)
  return data
}
const marker = Date.now().toString().slice(-7)
const admin = await p.user.findUniqueOrThrow({ where: { username: 'admin' } })
const staff = await p.user.create({ data: { username: 'FB' + marker, passwordHash: 'isolated-fixture-no-login', role: 'STAFF', staffProfile: { create: { name: '净值验证员工', presence: 'ONLINE' } } }, include: { staffProfile: true } })
const weekStaff = await p.user.create({ data: { username: 'WK' + marker, passwordHash: 'isolated-fixture-no-login', role: 'STAFF', staffProfile: { create: { name: '本周验证员工', presence: 'ONLINE' } } }, include: { staffProfile: true } })
const customer = await p.customer.create({ data: { name: '独立专项客户', customerCode: 'FB-C-' + marker, teamCode: 'FB-TEAM', balanceCents: 100000, principalBalanceCents: 100000 } })
const makeOrder = async (name, employee, original, date) => p.order.create({ data: {
  orderNo: `FB${marker}-${name}`, customerId: customer.id, staffId: employee.staffProfile.id, createdById: admin.id,
  serviceItem: '专项服务套餐', amountCents: 100000, staffAmountCents: original, status: 'COMPLETED', completionReviewStatus: 'APPROVED', completedAt: date,
  assignments: { create: { staffId: employee.staffProfile.id, slotIndex: 1, commissionRateBps: 5000, expectedEarningCents: original, actualEarningCents: original, assignmentStatus: 'COMPLETED', completedAt: date, completionReviewStatus: 'APPROVED' } },
  orderConsumption: { create: { customerId: customer.id, operatorId: admin.id, totalAmountCents: 100000, principalUsedCents: 100000, principalBeforeCents: 200000, principalAfterCents: 100000, bonusBeforeCents: 0, bonusAfterCents: 0 } },
}, include: { assignments: true } })
try {
 const positive = await makeOrder('UP', staff, 41160, new Date())
 const negative = await makeOrder('DOWN', staff, 50000, new Date())
 const afterSale = (await request('/after-sales', admin, 'POST', { orderId: positive.id, issueType: '收益核对', description: '独立验证：客户实际应得与跟进同步' }, 201)).item
 const adjust = (order, amount) => request(`/orders/${order.id}/adjustments`, admin, 'POST', { requestId: randomUUID(), netAmount: 1000, staffNetEarnings: [{ assignmentId: order.assignments[0].id, amount }], reason: '专项净值验证', ...(order.id === positive.id ? { afterSaleId: afterSale.id } : {}) }, 201)
 const beforeFinance = (await request('/finance/overview', admin)).item
 await adjust(positive, 500)
 const detail = (await request('/orders/' + positive.id, admin)).item
 assert.equal(detail.currentStaffEarningTotalCents, 50000)
 assert.equal(detail.assignments[0].actualEarningCents, 41160)
 assert.equal(detail.assignments[0].currentNetEarningCents, 50000)
 const list = (await request('/orders?search=' + positive.orderNo, admin)).items
 assert.equal(list[0].currentStaffEarningTotalCents, 50000)
 const own = (await request('/orders/' + positive.id, staff)).item
 assert.equal(own.assignments[0].currentNetEarningCents, 50000)
 assert.equal((await request('/finance/overview', admin)).item.staffEarningsCents - beforeFinance.staffEarningsCents, 8840)
 await adjust(negative, 400)
 assert.equal((await request('/orders/' + negative.id, admin)).item.assignments[0].currentNetEarningCents, 40000)
 assert.equal((await p.orderStaffAssignment.findUniqueOrThrow({ where: { id: negative.assignments[0].id } })).actualEarningCents, 50000)
 const [adminSocket, staffSocket] = [admin, staff].map(u => io('http://127.0.0.1:4210', { auth: { token: token(u) } }))
 await Promise.all([adminSocket, staffSocket].map(s => new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject) })))
 const changed = (socket) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Realtime change timeout')), 10000); socket.once('data:changed', () => { clearTimeout(timer); resolve() }) })
 const adminChanged = changed(adminSocket)
 await request(`/after-sales/${afterSale.id}/messages`, staff, 'POST', { content: '对局没有出现辱骂' }, 201)
 await adminChanged
 const adminCase = (await request('/after-sales', admin)).items.find(c => c.id === afterSale.id)
 assert.equal(adminCase.messages[0].content, '对局没有出现辱骂'); assert.equal(adminCase.messages[0].author.role, 'STAFF')
 assert.equal(adminCase.messages[0].author.username, staff.username)
 const staffChanged = changed(staffSocket)
 await request(`/after-sales/${afterSale.id}`, admin, 'PATCH', { handlingNote: '管理员已核对服务说明' })
 await staffChanged
 assert.equal((await request('/workbench/aftersales', staff)).items.find(c => c.id === afterSale.id).messages.length, 2)
 await request(`/after-sales/${afterSale.id}/messages`, weekStaff, 'POST', { content: '越权测试' }, 403)
 await request('/orders/' + positive.id, weekStaff, 'GET', undefined, 404)
 adminSocket.disconnect(); staffSocket.disconnect()
 const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7)
 const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6); sunday.setHours(23, 59, 59, 999)
 await makeOrder('W1', weekStaff, 10000, monday)
 await makeOrder('W2', weekStaff, 20000, sunday)
 const outside = new Date(sunday.getTime() + 1)
 await makeOrder('NEXT', weekStaff, 99999, outside)
 const dayKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
 const qs = `startDate=${dayKey(monday)}&endDate=${dayKey(sunday)}`
 const week = (await request('/workbench/stats?period=week', weekStaff)).item.selected
 const manual = (await request('/workbench/stats?' + qs, weekStaff)).item.selected
 assert.equal(week.completedCount, 2); assert.equal(week.earningsCents, 30000); assert.deepEqual(week, manual)
 await request('/workbench/stats?startDate=2026-02-30&endDate=2026-03-01', weekStaff, 'GET', undefined, 400)
 await p.settlementRecord.create({ data: { requestId: randomUUID(), staffId: staff.staffProfile.id, operatorId: admin.id, amountCents: 55000, settlementMethod: '线下转账', settledAt: new Date(), note: '仅独立验证库' } })
 const drill = (await request('/workbench/stats/details?period=all', staff)).item
 assert.equal(drill.summary.earningsCents, 90000)
 assert.equal(drill.summary.settledCents, 55000)
 assert.equal(drill.summary.pendingSettlementCents, 35000)
 assert.equal(drill.orders.reduce((n,o)=>n+o.currentActualEarningCents,0),drill.summary.earningsCents)
 assert.equal(drill.orders.reduce((n,o)=>n+o.pendingSettlementCents,0),drill.summary.pendingSettlementCents)
 await adjust(negative, 0)
 const over = (await request('/workbench/stats/details?period=all', staff)).item
 assert.equal(over.summary.pendingSettlementCents, 0);assert.equal(over.summary.overSettledCents, 5000)
 await adjust(negative, 400)
 const summary = (await request('/workbench/stats', staff)).item
 assert.equal(summary.totalEarningsCents, 90000)
 const fixture = { staffUsername: staff.username, weekUsername: weekStaff.username, positiveId: positive.id, negativeId: negative.id, positiveOrderNo: positive.orderNo, afterSaleId: afterSale.id, caseNo: afterSale.caseNo }
 fs.mkdirSync('output/client-feedback-20260907', { recursive: true })
 fs.writeFileSync('output/client-feedback-20260907/fixtures.json',JSON.stringify(fixture,null,2))
 fs.writeFileSync('output/client-feedback-20260907/api-tests.json',JSON.stringify({pass:true,positive41160To50000:true,negativeOriginalPreserved:true,realtimeBothDirections:true,nonParticipantForbidden:true,weekTwoOrders30000:true,inclusiveEndMilliseconds:true,drillTotals:true,overSettlementClamped:true,isolatedDatabase},null,2))
 console.log('SPECIALIZED_API_TESTS_PASS')
} finally { await p.$disconnect() }

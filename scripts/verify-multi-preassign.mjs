import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { testEnvironment } from './feedback-isolated-env.mjs'
const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const base = 'http://127.0.0.1:4210/api', origin = 'http://127.0.0.1:8280', out = 'output/multi-preassign-20260912'
const marker = `PRE_${Date.now()}`, password = randomBytes(20).toString('hex'), users = [], orders = [], tiers = [], checks = []
let pack, customer, browser
const request = async (url, token, body, expected = 200, method = body === undefined ? 'GET' : 'POST') => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await r.json(); assert.equal(r.status, expected, `${url}: ${r.status} ${data.message ?? ''}`); return data
}
const active = order => order.assignments.filter(a => a.assignmentStatus !== 'EXITED')
try {
  for (const level of [1, 2]) tiers.push(await p.staffTier.create({ data: { name: `${marker}_tier${level}`, level } }))
  for (const role of ['SUPER_ADMIN', 'STAFF', 'STAFF', 'STAFF', 'STAFF']) users.push(await p.user.create({ data: { username: `${marker}_${users.length}`, passwordHash: await bcrypt.hash(password, 10), role, ...(role === 'STAFF' ? { staffProfile: { create: { name: `预分配演示${users.length}`, tierId: tiers[users.length === 1 ? 0 : 1].id } } } : {}) }, include: { staffProfile: true } }))
  const tokens = []
  for (const user of users) tokens.push((await request('/auth/login', null, { username: user.username, password })).token)
  const [admin, a, b, c, d] = tokens, staffIds = users.slice(1).map(u => u.staffProfile.id)
  pack = await p.servicePackage.create({ data: { name: `${marker}_套餐`, basePriceCents: 20000 } })
  customer = await p.customer.create({ data: { name: '演示客户001', customerCode: `${marker}_DEMO001`, teamCode: 'TEAM001' } })
  const body = (count, selected, extra = {}) => ({ customerId: customer.id, servicePackageId: pack.id, amountCents: 20000, requiredStaffCount: count, collaborationSlots: Array.from({ length: count }, (_, i) => ({ slotIndex: i + 1, commissionRateBps: count === 3 ? [3000, 2000, 1000][i] : [4000, 3000][i] })), preassignedStaffIds: selected, ...extra })
  const create = async (count, selected, extra) => { const item = (await request('/orders', admin, body(count, selected, extra), 201)).item; orders.push(item.id); return item }
  const pool = async token => (await request('/workbench/available-orders', token)).items
  const claim = (o, token, expected = 200) => request(`/orders/${o.id}/claim`, token, {}, expected)
  const legacy = await create(1, undefined, { staffId: staffIds[0] })
  assert.equal(legacy.activeStaffCount, 1); assert.equal(legacy.status, 'PENDING')
  const single = await create(1, [staffIds[0]]); assert.equal(single.activeStaffCount, 1)
  checks.push('A: old staffId contract and new single selection both occupy slot 1')
  const empty = await create(2, [])
  assert.equal(empty.activeStaffCount, 0); assert.equal(active(empty).filter(s => s.assignmentStatus === 'OPEN').length, 2); assert((await pool(a)).some(o => o.id === empty.id))
  checks.push('B: 0/2 leaves both slots in the pool')
  const partial = await create(2, [staffIds[0]])
  assert.equal(partial.activeStaffCount, 1); assert.equal(partial.status, 'PENDING_ASSIGNMENT'); assert((await pool(b)).some(o => o.id === partial.id))
  const own = (await request('/orders', a)).items; assert(own.some(o => o.id === partial.id))
  const visible = (await request(`/orders/${partial.id}`, a)).item
  assert.equal(visible.customer.customerCode, customer.customerCode); assert.equal(visible.customer.teamCode, 'TEAM001')
  const stranger = (await pool(b)).find(o => o.id === partial.id)
  assert(!JSON.stringify(stranger).includes(customer.customerCode)); assert(!JSON.stringify(stranger).includes('TEAM001'))
  await request(`/orders/${partial.id}`, b, undefined, 404)
  await request(`/orders/${partial.id}/start`, a, {}, 400)
  const filled = (await claim(partial, b)).item
  assert.equal(filled.activeStaffCount, 2); assert.equal(filled.status, 'PENDING')
  assert.equal(active(filled)[0].commissionRateBps, undefined, 'Other employee commission stays private')
  const adminFilled = (await request(`/orders/${partial.id}`, admin)).item
  assert.deepEqual(active(adminFilled).map(s => [s.staffId, s.commissionRateBps, s.expectedEarningCents]), [[staffIds[0], 4000, 8000], [staffIds[1], 3000, 6000]])
  assert.equal((await claim(partial, a)).idempotent, true); await claim(partial, c, 409)
  checks.push('C/L/M/N: partial pool, private participant access, incomplete start rejection, slot commission, idempotency and capacity verified')
  const full = await create(2, [staffIds[1], staffIds[0]])
  assert.equal(full.status, 'PENDING'); assert.equal(full.activeStaffCount, 2); assert(!(await pool(c)).some(o => o.id === full.id))
  assert.deepEqual(active(full).map(s => s.staffId), [staffIds[1], staffIds[0]])
  const audit = await p.operationLog.findMany({ where: { entityId: full.id, entityType: 'ORDER', action: { in: ['CREATE', 'ASSIGN'] } } })
  assert.equal(audit.length, 2); assert.equal(new Set(audit.map(l => l.detail.slotIndex)).size, 2)
  checks.push('D: 2/2 excluded from pool; selection order binds slots; dispatch logs count each assignment once')
  const three = await create(3, staffIds.slice(0, 2)); assert.equal(three.activeStaffCount, 2)
  const attempts = await Promise.all([c, d].map(token => fetch(base + `/orders/${three.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })))
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]); const rows = await p.orderStaffAssignment.findMany({ where: { orderId: three.id } }); assert.equal(rows.filter(s => s.staffId).length, 3)
  checks.push('E/J: 2/3 retains exactly one slot; concurrent final claims have one winner')
  for (const [selected, extra, status] of [[[staffIds[0], staffIds[0]], {}, 400], [staffIds.slice(0, 3), {}, 400], [[staffIds[0]], { requiredTierId: tiers[1].id }, 409], [[staffIds[1], 'missing-staff'], {}, 409], [[staffIds[0]], { staffId: staffIds[1] }, 400]]) await request('/orders', admin, body(2, selected, extra), status)
  await request('/orders', admin, body(2, [], { collaborationSlots: [{ slotIndex: 1, commissionRateBps: 8000 }, { slotIndex: 2, commissionRateBps: 8000 }] }), 400)
  await request('/orders', a, body(2, [staffIds[0]]), 403)
  checks.push('F/G/H: duplicates, excess people, wrong tier, missing staff, mixed legacy fields, excessive commission and staff privilege rejected')
  const unrestricted = await create(2, staffIds.slice(0, 2)); assert.equal(unrestricted.activeStaffCount, 2)
  checks.push('I: unrestricted order accepts different tiers')
  const countSnapshot = async () => ({ orders: await p.order.count(), customers: await p.customer.count(), recharge: await p.rechargeRecord.count(), funds: await p.fundTransaction.count(), logs: await p.operationLog.count() })
  for (const invalid of [{ accepting: 'PAUSED' }, { selfAccepting: 'PAUSED' }, { accountStatus: 'FROZEN' }, { accountStatus: 'RETIRED' }]) {
    await p.staffProfile.update({ where: { id: staffIds[1] }, data: invalid })
    const before = await countSnapshot()
    await request('/orders', admin, body(2, staffIds.slice(0, 2), { customerId: undefined, newCustomer: { customerCode: `${marker}_rollback`, teamCode: 'DEMO' }, rechargeAmountCents: 20000 }), 409)
    assert.deepEqual(await countSnapshot(), before)
    await p.staffProfile.update({ where: { id: staffIds[1] }, data: { accepting: 'ACCEPTING', selfAccepting: 'ACCEPTING', accountStatus: 'NORMAL' } })
  }
  await p.user.update({ where: { id: users[2].id }, data: { isActive: false } }); await request('/orders', admin, body(2, staffIds.slice(0, 2)), 409); await p.user.update({ where: { id: users[2].id }, data: { isActive: true } })
  checks.push('Invalid eligibility leaves no customer/recharge/order/assignment/log partial writes; both pause controls retained')
  const exit = (await request(`/orders/${full.id}/exit`, b, {})).item
  assert.equal(exit.activeStaffCount, 1); assert.equal(exit.status, 'PENDING_ASSIGNMENT'); assert((await pool(c)).some(o => o.id === full.id))
  await claim(full, c); await request(`/orders/${full.id}/start`, a, {})
  await request(`/orders/${full.id}`, admin, { requiredStaffCount: 3 }, 409, 'PATCH')
  await request(`/orders/${partial.id}`, admin, { requiredStaffCount: 3 }, 409, 'PATCH')
  checks.push('K: preassigned exit releases slot; replacement and full start work; editing cannot overwrite occupied or started team')
  const { chromium } = createRequire(import.meta.url)('playwright')
  browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await ctx.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()) })
  await page.goto(origin + '/admin/login'); await page.getByLabel('账号', { exact: true }).fill(users[0].username); await page.getByLabel('密码', { exact: true }).fill(password)
  await page.locator('button').filter({ hasText: '进入管理后台' }).click(); await page.waitForURL(url => !url.pathname.endsWith('/login'))
  await page.goto(origin + '/admin/orders'); await page.locator('button').filter({ hasText: '新增订单' }).click()
  const dialog = page.getByRole('dialog', { name: '新增订单' }), count = dialog.getByLabel('需要协作人数'), select = dialog.getByLabel('预先分配员工（可选）')
  await count.fill('2'); await count.blur(); await select.click()
  for (const name of ['预分配演示1', '预分配演示2']) { await select.fill(name); await page.locator('.ant-select-item-option').filter({ hasText: name }).click() }
  await select.press('Escape'); assert.equal(await dialog.locator('.ant-select-selection-item').filter({ hasText: '预分配演示' }).count(), 2)
  await count.fill('1'); await count.blur()
  await dialog.getByText('已选人数超过需要协作人数，请移除多余员工后保存', { exact: true }).waitFor()
  assert.equal(await dialog.locator('.ant-select-selection-item').filter({ hasText: '预分配演示' }).count(), 2)
  await count.fill('2'); await count.blur()
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await select.scrollIntoViewIfNeeded(); await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: `${out}/preassign-${viewport.width}.png`, animations: 'disabled' })
  }
  assert.equal(errors.length, 0, JSON.stringify(errors))
  checks.push('PC/mobile multi-select visible; 0/1/2 selectable, shrinking preserves selections and shows blocking validation, no overflow/console errors')
  fs.writeFileSync(`${out}/tests.json`, JSON.stringify({ result: 'PASS', checks, consoleErrors: errors, isolated: true }, null, 2)); console.log(JSON.stringify({ result: 'PASS', checks: checks.length }))
} finally {
  if (browser) await browser.close()
  const ids = users.map(u => u.id)
  await p.operationLog.deleteMany({ where: { operatorId: { in: ids } } })
  await p.orderStaffAssignment.deleteMany({ where: { orderId: { in: orders } } }); await p.order.deleteMany({ where: { id: { in: orders } } })
  if (customer) await p.customer.delete({ where: { id: customer.id } })
  if (pack) await p.servicePackage.delete({ where: { id: pack.id } })
  await p.staffProfile.deleteMany({ where: { userId: { in: ids } } }); await p.user.deleteMany({ where: { id: { in: ids } } }); await p.staffTier.deleteMany({ where: { id: { in: tiers.map(t => t.id) } } }); await p.$disconnect()
}

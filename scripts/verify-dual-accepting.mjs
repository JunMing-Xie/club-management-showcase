import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { testEnvironment } from './feedback-isolated-env.mjs'
const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const marker = Date.now(), password = randomBytes(20).toString('hex'), users = [], orders = [], checks = []
let customer, pack, browser
const base = 'http://127.0.0.1:4210/api'
const call = async (url, status, token, body, method = 'POST') => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  assert.equal(r.status, status, `${url}: ${r.status}`)
  return r.json()
}
try {
  const admin = await p.user.create({ data: { username: `DEMO_DUAL_ADMIN_${marker}`, passwordHash: await bcrypt.hash(password, 10), role: 'SUPER_ADMIN' } }); users.push(admin)
  const staff = await p.user.create({ data: { username: `DEMO_DUAL_STAFF_${marker}`, passwordHash: await bcrypt.hash(password, 10), role: 'STAFF', staffProfile: { create: { name: '双层接单演示员工' } } }, include: { staffProfile: true } }); users.push(staff)
  const login = async username => (await call('/auth/login', 200, null, { username, password })).token
  const adminToken = await login(admin.username), token = await login(staff.username)
  customer = (await call('/customers', 201, adminToken, { customerCode: `DEMO_DUAL_${marker}`, teamCode: `DEMO_TEAM_${marker}`, note: '双层接单隔离测试' })).item
  pack = (await call('/packages', 201, adminToken, { name: `双层接单演示${marker}`, basePriceCents: 18800, isEnabled: true })).item
  const order = async () => {
    const item = (await call('/orders', 201, adminToken, { customerId: customer.id, servicePackageId: pack.id, amountCents: 18800, requiredStaffCount: 1, collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }] })).item
    orders.push(item.id); return item
  }
  const own = (accepting, status = 200, extra = {}) => call('/staff/me/accepting', status, token, { accepting, ...extra }, 'PATCH')
  const manager = accepting => call(`/staff/${staff.staffProfile.id}`, 200, adminToken, { accepting }, 'PATCH')
  const profile = () => p.staffProfile.findUnique({ where: { userId: staff.id } })
  const first = await order(); await call(`/orders/${first.id}/claim`, 200, token, {})
  checks.push('admin allows + personal accepting: claim succeeds')
  const second = await order(); await own('PAUSED'); await call(`/orders/${second.id}/claim`, 409, token, {})
  assert.equal((await profile()).accepting, 'ACCEPTING'); checks.push('personal pause does not change admin permission; claim denied')
  await own('ACCEPTING'); await manager('PAUSED'); await call(`/orders/${second.id}/claim`, 409, token, {})
  assert.equal((await profile()).selfAccepting, 'ACCEPTING'); checks.push('admin pause + personal accepting: claim denied')
  assert.equal((await own('ACCEPTING', 403)).message, '管理员已暂停您的接单权限，如需恢复请联系管理员。')
  await own('ACCEPTING', 400, { userId: admin.id, adminAccepting: 'ACCEPTING' })
  await call(`/staff/${staff.staffProfile.id}`, 403, token, { accepting: 'ACCEPTING' }, 'PATCH')
  assert.equal((await profile()).accepting, 'PAUSED'); checks.push('employee cannot override pause by old endpoint or forged management fields')
  const { chromium } = createRequire(import.meta.url)('playwright')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  const page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()) })
  await page.goto('http://127.0.0.1:8280/workbench/login')
  await page.getByLabel('账号', { exact: true }).fill(staff.username); await page.getByLabel('密码', { exact: true }).fill(password)
  await page.locator('button').filter({ hasText: '进入工作台' }).click(); await page.waitForURL('**/workbench')
  await page.getByText('管理员已暂停您的接单权限，如需恢复请联系管理员。', { exact: true }).waitFor()
  assert(await page.getByRole('combobox', { name: '员工接单状态' }).isDisabled())
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.waitForTimeout(1200); await page.screenshot({ path: 'output/workbench-password-20260912/admin-paused-mobile.png', animations: 'disabled' })
  await manager('ACCEPTING')
  await page.waitForFunction(() => !document.querySelector('[aria-label="员工接单状态"]')?.hasAttribute('disabled'))
  assert.equal((await profile()).selfAccepting, 'ACCEPTING')
  await call(`/orders/${second.id}/claim`, 200, token, {})
  checks.push('admin restore preserves personal value; workbench updates and claim succeeds')
  await own('PAUSED'); await manager('PAUSED'); await manager('ACCEPTING')
  assert.equal((await profile()).selfAccepting, 'PAUSED')
  const third = await order(); await call(`/orders/${third.id}/claim`, 409, token, {})
  checks.push('admin restore does not override a retained personal pause')
  await own('ACCEPTING')
  await p.user.update({ where: { id: staff.id }, data: { isActive: false } })
  await call(`/orders/${third.id}/claim`, 401, token, {})
  await p.user.update({ where: { id: staff.id }, data: { isActive: true } })
  checks.push('disabled account still rejected')
  const list = await call('/staff', 200, adminToken, undefined, 'GET')
  const row = list.items.find(s => s.id === staff.staffProfile.id)
  assert.equal(row.accepting, 'ACCEPTING'); assert.equal(row.selfAccepting, 'ACCEPTING')
  assert.equal(errors.length, 0, JSON.stringify(errors))
  fs.writeFileSync('output/workbench-password-20260912/dual-accepting-tests.json', JSON.stringify({ result: 'PASS', checks, consoleErrors: errors, ui: '390×844: administrator pause warning + disabled selector + realtime restore' }, null, 2))
  console.log(JSON.stringify({ result: 'PASS', checks: checks.length, consoleErrors: errors.length }))
} finally {
  if (browser) await browser.close()
  const ids = users.map(u => u.id)
  await p.operationLog.deleteMany({ where: { operatorId: { in: ids } } })
  await p.orderStaffAssignment.deleteMany({ where: { orderId: { in: orders } } })
  await p.order.deleteMany({ where: { id: { in: orders } } })
  await p.customer.deleteMany({ where: { customerCode: `DEMO_DUAL_${marker}` } })
  await p.servicePackage.deleteMany({ where: { name: `双层接单演示${marker}` } })
  await p.staffProfile.deleteMany({ where: { userId: { in: ids } } }); await p.user.deleteMany({ where: { id: { in: ids } } }); await p.$disconnect()
}

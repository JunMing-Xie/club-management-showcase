import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db, env } from './admin-reminders-local.mjs'

assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
Object.assign(process.env, env)
const { dispatchRange, dispatchStatistics } = await import('../dist/server/dispatch-statistics.js')
const { prisma: statsDb } = await import('../dist/server/prisma.js')
const p = db(), marker = 'dispatch_' + randomBytes(5).toString('hex'), password = randomBytes(24).toString('base64url')
const ids = [], orderIds = [], customerIds = [], packageIds = [], users = {}, tokens = {}, staff = [], checks = []
const keys = ['STORE_MANAGER', 'CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE'].map(r => 'role_permissions_' + r)
const originals = await p.systemSetting.findMany({ where: { key: { in: keys } } })
let browser
const request = async (url, token, method = 'GET', body, status = 200) => {
  const r = await fetch(env.BASE_URL + url, { method, headers: { Authorization: 'Bearer ' + token, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) })
  const data = await r.json(); assert.equal(r.status, status, `${method} ${url}: ${r.status} ${data.message ?? ''}`); return data
}
const setRole = (role, permissions, token = tokens.STORE_MANAGER, status = 200) => request('/admin/role-permissions/' + role, token, 'PATCH', { permissions }, status)
try {
  const hash = await bcrypt.hash(password, 10)
  for (const [key, role] of Object.entries({ SUPER_ADMIN: 'SUPER_ADMIN', STORE_MANAGER: 'STORE_MANAGER', A: 'CUSTOMER_SERVICE', B: 'CUSTOMER_SERVICE', D: 'DISPATCHER', F: 'FINANCE', S1: 'STAFF', S2: 'STAFF' })) {
    users[key] = await p.user.create({ data: { username: marker + '_' + key, role, passwordHash: hash, ...(role === 'STAFF' ? { staffProfile: { create: { name: marker + '_' + key, presence: 'ONLINE' } } } : {}) }, include: { staffProfile: true } }); ids.push(users[key].id)
    if (role === 'STAFF') staff.push(users[key].staffProfile)
    tokens[key] = (await request('/auth/login', '', 'POST', { username: users[key].username, password })).token
  }
  for (const role of ['STORE_MANAGER', 'CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE']) await request('/admin/role-permissions/' + role + '/reset', tokens.SUPER_ADMIN, 'POST')
  const expected = ['orders.view', 'orders.create', 'orders.assign', 'orders.review', 'aftersales.view', 'aftersales.create', 'dispatch.self']
  for (const key of ['A', 'D']) assert.deepEqual((await request('/auth/me', tokens[key])).user.permissions, expected)
  assert.deepEqual((await request('/auth/me', tokens.F)).user.permissions, ['finance.view', 'settlement.view', 'settlement.manage'])
  const managerPermissions = (await request('/auth/me', tokens.STORE_MANAGER)).user.permissions
  for (const key of ['A', 'D', 'F']) for (const url of ['/staff', '/customers', '/stats/overview', '/admin/role-permissions', '/dispatch-statistics', '/dashboard/summary', '/settings/admin-dashboard']) await request(url, tokens[key], 'GET', undefined, 403)
  for (const key of ['A', 'D']) { await request('/finance/overview', tokens[key], 'GET', undefined, 403); await request('/orders', tokens[key]); await request('/after-sales', tokens[key]); assert((await request('/admin/reminders', tokens[key])).allowed.completion); assert.equal((await request('/admin/reminders', tokens[key])).allowed.afterSale, false) }
  await request('/finance/overview', tokens.F); await request('/finance/settlement-options', tokens.F)
  await setRole('STORE_MANAGER', [], tokens.STORE_MANAGER, 403); await setRole('SUPER_ADMIN', [], tokens.STORE_MANAGER, 403)
  for (const forbidden of ['rbac.manage', 'dispatch.view']) { await setRole('CUSTOMER_SERVICE', [...expected, forbidden], tokens.STORE_MANAGER, 403); await setRole('CUSTOMER_SERVICE', [...expected, forbidden], tokens.SUPER_ADMIN, 403) }
  await setRole('STORE_MANAGER', managerPermissions.filter(k => k !== 'customers.manage'), tokens.SUPER_ADMIN)
  await setRole('CUSTOMER_SERVICE', [...expected, 'customers.manage'], tokens.STORE_MANAGER, 403)
  await setRole('STORE_MANAGER', managerPermissions, tokens.SUPER_ADMIN)
  checks.push('Frozen defaults, financial isolation, managerial hierarchy and actor assignable ceiling enforced by API')
  const customer = await p.customer.create({ data: { customerCode: marker, teamCode: marker, name: marker, balanceCents: 100000, principalBalanceCents: 100000 } }); customerIds.push(customer.id)
  const pack = await p.servicePackage.create({ data: { name: marker, basePriceCents: 1000 } }); packageIds.push(pack.id)
  assert.equal((await request('/order-options/customers', tokens.A)).items.length, 0)
  const choices = (await request('/order-options/customers?search=' + marker, tokens.A)).items
  assert.equal(choices.length, 1); assert.deepEqual(Object.keys(choices[0]).sort(), ['customerCode', 'id', 'teamCode'])
  const staffOptions = (await request('/order-options/staff', tokens.D)).items
  assert(staffOptions.some(s => s.id === staff[0].id)); assert(staffOptions.every(s => !('phone' in s) && !('realName' in s) && !('totalEarningsCents' in s)))
  await request('/order-options/tiers', tokens.A)
  const body = { customerId: customer.id, servicePackageId: pack.id, amountCents: 1000, requiredStaffCount: 1, collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }] }
  for (const key of ['A', 'A', 'A', 'D']) { const { item } = await request('/orders', tokens[key], 'POST', body, 201); orderIds.push(item.id) }
  await request('/orders', tokens.A, 'POST', { ...body, rechargeAmountCents: 100 }, 403)
  await request('/orders', tokens.A, 'POST', { ...body, customerId: undefined, newCustomer: { customerCode: marker + '_blocked', teamCode: marker } }, 403)
  for (const id of orderIds.slice(0, 3)) await request('/orders/' + id + '/assign', tokens.A, 'POST', { staffId: staff[0].id, slotIndex: 1 })
  await request('/orders/' + orderIds[0] + '/assign', tokens.A, 'POST', { staffId: staff[1].id, slotIndex: 1 })
  // Retrying the same assignment must neither create a log nor inflate operations.
  await request('/orders/' + orderIds[0] + '/assign', tokens.A, 'POST', { staffId: staff[1].id, slotIndex: 1 })
  await request('/orders/' + orderIds[3] + '/assign', tokens.D, 'POST', { staffId: staff[0].id, slotIndex: 1 })
  for (const key of ['A', 'D']) { await request('/orders/' + orderIds[0], tokens[key], 'PATCH', { note: 'forbidden' }, 403); await request('/orders/' + orderIds[0] + '/adjustments', tokens[key], 'POST', {}, 403); await request('/orders/' + orderIds[0] + '/assignment-rates', tokens[key], 'PATCH', { slots: [] }, 403) }
  const ownA = await request('/dispatch-statistics/me', tokens.A)
  assert.equal(ownA.rows.length, 1); assert.equal(ownA.rows[0].id, users.A.id); assert.equal(ownA.rows[0].orderCount, 3); assert.equal(ownA.rows[0].operationCount, 4); assert.equal(ownA.summary.week, 3)
  assert.equal((await request('/dispatch-statistics/me', tokens.D)).rows[0].orderCount, 1)
  for (const field of ['userId', 'operatorId']) await request('/dispatch-statistics/me?' + field + '=' + users.B.id, tokens.A, 'GET', undefined, 403)
  for (const key of ['SUPER_ADMIN', 'STORE_MANAGER']) {
    const all = await request('/dispatch-statistics', tokens[key]); assert.equal(all.rows.find(r => r.id === users.B.id).orderCount, 0); assert.equal(all.rows.find(r => r.id === users.A.id).operationCount, 4)
    assert.equal((await request('/dispatch-statistics?operatorId=' + users.A.id, tokens[key])).details.length, 4)
  }
  checks.push('Actual assignment APIs: A has 3 distinct orders / 4 successful operations; duplicate retry excluded; B shown as zero; D isolated; forged identity rejected')
  const preassigned = (await request('/orders', tokens.SUPER_ADMIN, 'POST', { ...body, staffId: staff[0].id }, 201)).item
  orderIds.push(preassigned.id)
  assert.equal((await request('/dispatch-statistics/me', tokens.SUPER_ADMIN)).rows[0].operationCount, 1)
  await request('/orders/' + preassigned.id, tokens.SUPER_ADMIN, 'PATCH', { staffId: staff[1].id })
  const edited = await request('/dispatch-statistics/me', tokens.SUPER_ADMIN)
  assert.equal(edited.rows[0].orderCount, 1); assert.equal(edited.rows[0].operationCount, 2)
  checks.push('Pre-assignment CREATE and real edit reassignment audited without double counting')
  // Existing completion-review workflow, including a real proof upload and final accounting.
  for (const [key, id, staffKey] of [['A', orderIds[0], 'S2'], ['D', orderIds[3], 'S1']]) {
    await request('/orders/' + id + '/start', tokens[staffKey], 'POST')
    const proof = new FormData(); proof.append('note', 'Independent dispatch acceptance'); proof.append('proofs', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'proof.png')
    await request('/orders/' + id + '/completion-submissions', tokens[staffKey], 'POST', proof)
    await request('/orders/' + id + '/completion-review', tokens[key], 'POST', { approved: true })
    const sale = await request('/after-sales', tokens[key], 'POST', { orderId: id, issueType: '隔离测试', description: marker }, 201)
    await request('/after-sales/' + sale.item.id, tokens[key], 'PATCH', { status: 'COMPLETED' }, 403)
  }
  const salesA = (await request('/after-sales', tokens.A)).items
  assert(salesA.some(s => s.orderId === orderIds[0])); assert(!salesA.some(s => s.orderId === orderIds[3]))
  assert.equal((await request('/after-sales', tokens.B)).items.length, 0)
  checks.push('Customer service and dispatcher create orders, review real completed work, create after-sales; unrelated after-sales and settlement adjustments forbidden')
  // Deterministic calendar boundaries and server SQL filtering on isolated audited records.
  const fixedNow = new Date('2026-09-01T00:00:00+08:00')
  assert.equal(dispatchRange({ period: 'week', page: 1 }, fixedNow).from.toISOString(), '2026-08-30T16:00:00.000Z')
  assert.equal(dispatchRange({ period: 'lastMonth', page: 1 }, fixedNow).to.toISOString(), '2026-08-31T16:00:00.000Z')
  const actualLogs = await p.operationLog.findMany({ where: { operatorId: users.A.id, action: 'ASSIGN' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const times = ['2026-08-30T23:59:59+08:00', '2026-08-31T00:00:00+08:00', '2026-08-31T23:59:59+08:00', '2026-09-01T00:00:00+08:00']
  for (let i = 0; i < actualLogs.length; i++) await p.operationLog.update({ where: { id: actualLogs[i].id }, data: { createdAt: new Date(times[i]) } })
  for (const [period, expectedOps] of [['week', 3], ['lastWeek', 1], ['month', 1], ['lastMonth', 3]]) assert.equal((await dispatchStatistics({ period, page: 1 }, { selfId: users.A.id }, fixedNow)).rows[0].operationCount, expectedOps)
  assert.equal((await dispatchStatistics({ period: 'custom', from: '2026-08-31', to: '2026-08-31', page: 1 }, { selfId: users.A.id }, fixedNow)).rows[0].operationCount, 2)
  for (const log of actualLogs) await p.operationLog.update({ where: { id: log.id }, data: { createdAt: log.createdAt } })
  checks.push('Beijing week/month boundaries, inclusive custom end day and exclusive next-day bound verified against SQL results')
  const { chromium } = createRequire(path.join(process.env.APPDATA, 'npm', 'package.json'))('playwright')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'America/Los_Angeles' })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:8280/admin/login'); await page.getByLabel('账号', { exact: true }).fill(users.A.username); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '进入管理后台' }).click(); await page.waitForURL('**/admin/orders')
  await page.getByText('我的派单统计', { exact: true }).waitFor()
  for (const name of ['经营概览', '员工管理', '客户管理', '财务中心', '经营统计', '业务配置', '账号权限', '批量导入']) assert.equal(await page.getByRole('menuitem', { name }).count(), 0)
  assert.equal(await page.getByText(users.B.username, { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', {name:/编辑订单/}).count(), 0)
  assert.equal(await page.getByRole('button', {name:'取消', exact:true}).count(), 0)
  await page.getByRole('button', { name: /新增订单/ }).click(); const select = page.locator('.order-editor-modal input#customerId'); await select.fill(marker); await page.getByText(marker + ' · 组队码 ' + marker, { exact: true }).last().waitFor(); await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '新增订单', exact: true }).locator('button.ant-modal-close').click(); await page.getByRole('dialog', { name: '新增订单', exact: true }).waitFor({state:'hidden'})
  await page.getByRole('menuitem', { name: '售后管理' }).click(); await page.getByRole('button', { name: /新建售后/ }).waitFor()
  await setRole('CUSTOMER_SERVICE', expected.filter(k => !['aftersales.create', 'orders.review', 'dispatch.self'].includes(k)))
  await page.getByRole('button', { name: /新建售后/ }).waitFor({ state: 'hidden' })
  await request('/after-sales', tokens.A, 'POST', {}, 403); await request('/dispatch-statistics/me', tokens.A, 'GET', undefined, 403); assert.equal((await request('/admin/reminders', tokens.A)).allowed.completion, false)
  await setRole('CUSTOMER_SERVICE', expected); await page.getByRole('button', { name: /新建售后/ }).waitFor()
  await page.goto('http://127.0.0.1:8280/admin/finance'); await page.getByText('暂无此页面权限', { exact: true }).waitFor()
  await page.goto('http://127.0.0.1:8280/admin/orders'); await page.getByText('我的派单统计', { exact: true }).waitFor()
  fs.mkdirSync('output/playwright/dispatch-statistics', { recursive: true }); await page.screenshot({ path: 'output/playwright/dispatch-statistics/personal.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'output/playwright/dispatch-statistics/personal-mobile.png', fullPage: true })
  checks.push('Real browser: login lands on orders in non-China timezone; minimal customer search; allowed menus only; no other users; buttons and reminders revoke/restore live; denied URL remains blocked; 390px captured')
  const log = await p.operationLog.findFirstOrThrow({ where: { operatorId: users.STORE_MANAGER.id, entityType: 'ROLE_PERMISSIONS' }, orderBy: { createdAt: 'desc' } })
  for (const field of ['actorRole', 'targetRole', 'beforePermissions', 'afterPermissions', 'added', 'removed']) assert(field in log.detail)
  fs.writeFileSync('output/dispatch-statistics-20260911/tests.json', JSON.stringify({ result: 'PASS', checks, productionTouched: false }, null, 2)); console.log(JSON.stringify({ result: 'PASS', checks }, null, 2))
} catch (error) {
  const last = browser?.contexts()[0]?.pages()[0]
  if (last) { fs.mkdirSync('output/playwright/dispatch-statistics', {recursive:true}); await last.screenshot({path:'output/playwright/dispatch-statistics/failure.png',fullPage:true}); console.log((await last.locator('body').innerText()).slice(0,1800)) }
  throw error
} finally {
  await browser?.close()
  const proofs = await p.orderCompletionProof.findMany({ where: { orderId: { in: orderIds } }, select: { proofPath: true } })
  await p.afterSaleMessage.deleteMany({ where: { case: { orderId: { in: orderIds } } } }); await p.afterSaleCase.deleteMany({ where: { orderId: { in: orderIds } } })
  await p.fundTransaction.deleteMany({ where: { customerId: { in: customerIds } } }); await p.orderConsumption.deleteMany({ where: { orderId: { in: orderIds } } }); await p.consumptionRecord.deleteMany({ where: { orderId: { in: orderIds } } }); await p.order.deleteMany({ where: { id: { in: orderIds } } })
  await p.customer.deleteMany({ where: { id: { in: customerIds } } }); await p.servicePackage.deleteMany({ where: { id: { in: packageIds } } })
  await p.systemSetting.deleteMany({ where: { key: { in: keys } } }); for (const row of originals) await p.systemSetting.create({ data: row })
  await p.operationLog.deleteMany({ where: { operatorId: { in: ids } } }); await p.user.deleteMany({ where: { id: { in: ids } } })
  for (const { proofPath } of proofs) { const target = path.resolve(proofPath); assert(target.startsWith(path.resolve('uploads') + path.sep)); fs.rmSync(target, { force: true }) }
  await p.$disconnect(); await statsDb.$disconnect()
}

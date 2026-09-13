import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { io } from 'socket.io-client'
import { db, env } from './admin-reminders-local.mjs'

assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
assert.equal(new URL(env.BASE_URL).hostname, '127.0.0.1')
const p = db(), marker = 'jobtest_' + randomBytes(5).toString('hex'), password = randomBytes(24).toString('base64url')
const ids = [], jobs = [], orders = [], customers = [], packages = [], checks = []
const tokens = {}, users = {}
const originalManager = await p.systemSetting.findUnique({ where: { key: 'role_permissions_STORE_MANAGER' } })
let browser, socket
const request = async (url, token, method = 'GET', body, status = 200) => {
  const r = await fetch(env.BASE_URL + url, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json(); assert.equal(r.status, status, `${method} ${url}: ${r.status} ${data.message ?? ''}`); return data
}
const createJob = async (token, name, permissions) => { const { item } = await request('/admin/roles', token, 'POST', { name, description: '独立环境专项验证', permissions }, 201); jobs.push(item.id); return item }
const login = async username => (await request('/auth/login', '', 'POST', { username, password })).token
const connect = token => new Promise((resolve, reject) => {
  const s = io('http://127.0.0.1:4210', { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 6000 })
  s.once('connect', () => resolve(s)); s.once('connect_error', () => { s.disconnect(); reject(Error('Socket authentication failed')) })
})
try {
  const hash = await bcrypt.hash(password, 10)
  for (const role of ['SUPER_ADMIN', 'STORE_MANAGER', 'CUSTOMER_SERVICE']) {
    users[role] = await p.user.create({ data: { username: marker + '_' + role, role, passwordHash: hash } }); ids.push(users[role].id); tokens[role] = await login(users[role].username)
  }
  await request('/admin/role-permissions/STORE_MANAGER/reset', tokens.SUPER_ADMIN, 'POST')
  const initial = ['orders.view', 'orders.create', 'aftersales.view']
  const job = await createJob(tokens.SUPER_ADMIN, '运营_' + marker, initial)
  assert.equal(job.authorityLevel, 2); assert.equal(job.isSystem, false)
  const { item: account } = await request('/admin/users', tokens.SUPER_ADMIN, 'POST', { username: marker + '_custom', password, role: 'CUSTOM_ADMIN', adminRoleId: job.id }, 201); ids.push(account.id)
  const token = await login(account.username)
  assert.deepEqual(new Set((await request('/auth/me', token)).user.permissions), new Set(initial))
  assert.equal((await request('/auth/me', token)).user.adminRole.name, job.name)
  await request('/orders', token); await request('/after-sales', token)
  for (const endpoint of ['/admin/roles', '/admin/users', '/admin/role-permissions', '/finance/overview', '/dispatch-statistics', '/dispatch-statistics/me']) await request(endpoint, token, 'GET', undefined, 403)
  socket = await connect(token)
  checks.push('A/B: custom job and account use one live permission template; unauthorized APIs denied; Socket.IO authenticates by user ID')
  const { chromium } = createRequire(path.join(process.env.APPDATA, 'npm', 'package.json'))('playwright')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const browserLogin = async (page, username) => { await page.goto('http://127.0.0.1:8280/admin/login'); await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '进入管理后台' }).click(); await page.waitForURL(url => !url.pathname.endsWith('/login')) }
  await browserLogin(page, account.username)
  assert.equal(await page.getByRole('menuitem', { name: '账号权限' }).count(), 0)
  assert.equal(await page.getByRole('menuitem', { name: '财务中心' }).count(), 0)
  await page.getByText(job.name, { exact: true }).waitFor()
  const expanded = [...initial, 'orders.assign', 'orders.review', 'dispatch.self']
  await request('/admin/roles/' + job.id, tokens.SUPER_ADMIN, 'PATCH', { permissions: expanded })
  await page.getByText('我的派单统计', { exact: true }).waitFor()
  assert((await request('/auth/me', token)).user.permissions.includes('orders.assign'))
  assert.equal((await request('/admin/reminders', token)).allowed.exit, true)
  await page.goto('http://127.0.0.1:8280/admin/finance'); await page.getByText('暂无此页面权限', { exact: true }).waitFor()
  await request('/admin/roles/' + job.id, tokens.SUPER_ADMIN, 'PATCH', { permissions: initial })
  await request('/orders/not-an-order/assign', token, 'POST', {}, 403)
  assert.equal((await request('/admin/reminders', token)).allowed.exit, false)
  await request('/dispatch-statistics/me', token, 'GET', undefined, 403)
  await request('/admin/roles/' + job.id, tokens.SUPER_ADMIN, 'PATCH', { permissions: expanded })
  checks.push('C: existing JWT gets new permissions; browser menus/buttons and route guard, API and reminders follow grant/revoke without relogin')
  const managerJob = await createJob(tokens.STORE_MANAGER, '售后专员_' + marker, ['aftersales.view'])
  for (const forbidden of ['rbac.manage', 'dispatch.view']) for (const actor of ['STORE_MANAGER', 'SUPER_ADMIN']) await request('/admin/roles/' + managerJob.id, tokens[actor], 'PATCH', { permissions: [forbidden] }, 403)
  await request('/admin/roles', tokens.STORE_MANAGER, 'POST', { name: marker + '_bad', permissions: ['rbac.manage'] }, 403)
  for (const key of ['authorityLevel', 'isSystem', 'code', 'createdBy']) await request('/admin/roles', tokens.STORE_MANAGER, 'POST', { name: marker + '_bad', permissions: [], [key]: key === 'authorityLevel' ? 0 : true }, 400)
  for (const name of ['超级管理员', 'SUPER_ADMIN', '店长', 'STORE_MANAGER', 'ＳＵＰＥＲ＿ＡＤＭＩＮ', '   ']) await request('/admin/roles', tokens.SUPER_ADMIN, 'POST', { name, permissions: [] }, 400)
  for (const endpoint of ['/admin/roles', '/admin/role-permissions']) await request(endpoint, tokens.CUSTOMER_SERVICE, 'GET', undefined, 403)
  for (const role of ['SUPER_ADMIN', 'STORE_MANAGER']) {
    await request('/admin/users', tokens.STORE_MANAGER, 'POST', { username: marker + '_blocked', password, role }, 403)
    await request('/admin/users/' + users.SUPER_ADMIN.id, tokens.STORE_MANAGER, 'PATCH', { role, isActive: false }, 403)
    await request('/admin/role-permissions/' + role, tokens.STORE_MANAGER, 'PATCH', { permissions: [] }, 403)
  }
  await request('/admin/users/' + users.SUPER_ADMIN.id + '/reset-password', tokens.STORE_MANAGER, 'POST', { password }, 403)
  const managerPermissions = (await request('/auth/me', tokens.STORE_MANAGER)).user.permissions
  await request('/admin/role-permissions/STORE_MANAGER', tokens.SUPER_ADMIN, 'PATCH', { permissions: managerPermissions.filter(key => key !== 'orders.assign') })
  await request('/admin/roles/' + managerJob.id, tokens.STORE_MANAGER, 'PATCH', { permissions: ['orders.assign'] }, 403)
  await request('/admin/users', tokens.STORE_MANAGER, 'POST', { username: marker + '_blocked', password, role: 'CUSTOM_ADMIN', adminRoleId: job.id }, 403)
  await request('/admin/role-permissions/STORE_MANAGER', tokens.SUPER_ADMIN, 'PATCH', { permissions: managerPermissions })
  checks.push('D/E/F: manager can create subordinate jobs only; forged levels/system fields and reserved names rejected; delegation is bounded by current own permissions; normal roles and super/manager account targets protected')
  const { item: lower } = await request('/admin/users', tokens.STORE_MANAGER, 'POST', { username: marker + '_lower', password, role: 'CUSTOM_ADMIN', adminRoleId: managerJob.id }, 201); ids.push(lower.id)
  await request('/admin/users/' + lower.id, tokens.STORE_MANAGER, 'PATCH', { role: 'CUSTOM_ADMIN', adminRoleId: job.id })
  const deleteResponse = await request('/admin/roles/' + job.id, tokens.SUPER_ADMIN, 'DELETE', undefined, 409); assert(deleteResponse.message.includes('2 个'))
  await request('/admin/roles/' + job.id, tokens.SUPER_ADMIN, 'PATCH', { isActive: false })
  await request('/admin/users', tokens.SUPER_ADMIN, 'POST', { username: marker + '_blocked', password, role: 'CUSTOM_ADMIN', adminRoleId: job.id }, 400)
  await request('/admin/users/' + account.id, tokens.SUPER_ADMIN, 'PATCH', { role: 'CUSTOM_ADMIN', adminRoleId: job.id, isActive: true })
  assert((await request('/auth/me', token)).user.permissions.includes('orders.assign'))
  await request('/admin/roles', tokens.SUPER_ADMIN, 'POST', { name: job.name, permissions: [] }, 409)
  await request('/admin/roles/' + job.id, tokens.SUPER_ADMIN, 'PATCH', { name: '运营改名_' + marker, isActive: true })
  const logs = await p.operationLog.findMany({ where: { entityType: 'ADMIN_ROLE', entityId: job.id } })
  assert(logs.some(log => log.detail.after?.name === job.name))
  for (const log of logs) for (const key of ['operatorId', 'targetRoleId', 'before', 'after', 'addedPermissions', 'removedPermissions', 'time']) assert(key in log.detail)
  const assignmentLog = await p.operationLog.findFirstOrThrow({ where: { entityType: 'ADMIN_USER', entityId: lower.id, action: 'UPDATE' } }); assert.equal(assignmentLog.detail.before.adminRole.name, managerJob.name)
  await request('/admin/roles/' + managerJob.id, tokens.STORE_MANAGER, 'DELETE')
  checks.push('G/H/I: referenced jobs reject deletion with exact member count; disabled jobs reject new assignments but preserve members; unused deletion, unique names and immutable audit snapshots verified')
  const staffUser = await p.user.create({ data: { username: marker + '_staff', role: 'STAFF', passwordHash: hash, staffProfile: { create: { name: marker, presence: 'ONLINE' } } }, include: { staffProfile: true } }); ids.push(staffUser.id)
  const customer = await p.customer.create({ data: { customerCode: marker, teamCode: marker, name: marker, balanceCents: 100000, principalBalanceCents: 100000 } }); customers.push(customer.id)
  const pack = await p.servicePackage.create({ data: { name: marker, basePriceCents: 1000 } }); packages.push(pack.id)
  const { item: order } = await request('/orders', token, 'POST', { customerId: customer.id, servicePackageId: pack.id, amountCents: 1000, requiredStaffCount: 1, collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }] }, 201); orders.push(order.id)
  await request('/orders/' + order.id + '/assign', token, 'POST', { staffId: staffUser.staffProfile.id, slotIndex: 1 })
  const personal = await request('/dispatch-statistics/me', token); assert.equal(personal.rows[0].orderCount, 1); assert.equal(personal.rows[0].id, account.id)
  const all = await request('/dispatch-statistics', tokens.STORE_MANAGER); assert.equal(all.rows.find(row => row.id === account.id).orderCount, 1)
  assert.equal(all.rows.find(row => row.id === account.id).roleName, '运营改名_' + marker)
  await request('/dispatch-statistics/me?operatorId=' + lower.id, token, 'GET', undefined, 403)
  assert.equal(await p.operationLog.count({ where: { operatorId: account.id, entityType: 'ORDER', entityId: order.id, action: 'ASSIGN' } }), 1)
  const dispatchLog = await p.operationLog.findFirstOrThrow({ where: { operatorId: account.id, entityType: 'ORDER', entityId: order.id, action: 'ASSIGN' } })
  assert.equal(dispatchLog.detail.operatorRoleName, '运营改名_' + marker)
  assert.equal(dispatchLog.detail.operatorAdminRoleId, job.id)
  checks.push('J: custom account creates and dispatches a real isolated order; ASSIGN log and user-ID-scoped personal/global statistics include its custom job name')
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 960 } }), admin = await adminContext.newPage()
  await browserLogin(admin, users.SUPER_ADMIN.username); await admin.goto('http://127.0.0.1:8280/admin/permissions')
  await admin.getByRole('button', { name: '职位管理', exact: true }).click(); await admin.getByRole('button', { name: '新增职位', exact: true }).click()
  await admin.getByRole('dialog', { name: '新增职位', exact: true }).getByLabel('职位名称', { exact: true }).waitFor()
  await admin.waitForTimeout(500)
  const editor = admin.getByRole('dialog', { name: '新增职位', exact: true })
  await editor.getByLabel('职位名称', { exact: true }).fill('界面运营_' + marker)
  await editor.getByRole('checkbox', { name: '订单查看', exact: true }).check()
  assert.equal(await editor.getByText('rbac.manage', { exact: true }).count(), 0)
  assert.equal(await editor.getByRole('checkbox', { name: /管理层专属/ }).count(), 0)
  await editor.getByRole('button', { name: '保存职位', exact: true }).click(); await editor.waitFor({ state: 'hidden' })
  const uiJob = (await request('/admin/roles', tokens.SUPER_ADMIN)).items.find(item => item.name === '界面运营_' + marker); assert(uiJob); jobs.push(uiJob.id)
  await admin.getByRole('dialog', { name: '职位管理', exact: true }).locator('button.ant-modal-close').click()
  await request('/admin/roles/' + job.id, tokens.SUPER_ADMIN, 'PATCH', { isActive: false })
  await admin.reload()
  await admin.getByRole('button', { name: /新增管理账号/ }).click()
  const accountDialog = admin.getByRole('dialog', { name: '新增管理账号', exact: true })
  await accountDialog.getByLabel('角色', { exact: true }).click()
  await admin.getByText(uiJob.name, { exact: true }).last().waitFor()
  assert.equal(await admin.locator('.ant-select-dropdown').getByText('运营改名_' + marker, { exact: true }).count(), 0)
  await admin.keyboard.press('Escape'); await accountDialog.locator('button.ant-modal-close').click()
  await admin.setViewportSize({ width: 390, height: 844 }); await admin.waitForTimeout(600)
  await admin.getByRole('button', { name: '职位管理', exact: true }).click(); await admin.getByRole('button', { name: '新增职位', exact: true }).click()
  await admin.getByRole('dialog', { name: '新增职位', exact: true }).getByLabel('职位名称', { exact: true }).waitFor()
  await admin.waitForTimeout(500)
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  fs.mkdirSync('output/custom-admin-roles-20260912', { recursive: true }); await admin.screenshot({ path: 'output/custom-admin-roles-20260912/mobile-editor.png' })
  assert.deepEqual(errors, [])
  const managerContext = await browser.newContext({ viewport: { width: 1440, height: 960 } }), manager = await managerContext.newPage()
  await browserLogin(manager, users.STORE_MANAGER.username); await manager.goto('http://127.0.0.1:8280/admin/permissions')
  await manager.getByRole('button', { name: /新增管理账号/ }).click()
  await manager.getByRole('dialog', { name: '新增管理账号', exact: true }).getByLabel('角色', { exact: true }).click()
  const options = manager.locator('.ant-select-dropdown')
  assert.equal(await options.getByText('超级管理员', { exact: true }).count(), 0)
  assert.equal(await options.getByText('店长', { exact: true }).count(), 0)
  await options.getByText(uiJob.name, { exact: true }).last().waitFor()
  checks.push('Real browser: create job with Chinese permission checklist, dynamic account dropdown, 390px modal without page overflow; no page errors')
  assert.equal((await request('/auth/me', tokens.SUPER_ADMIN)).user.permissions.length, 30)
  fs.writeFileSync('output/custom-admin-roles-20260912/tests.json', JSON.stringify({ result: 'PASS', checks, productionTouched: false }, null, 2)); console.log(JSON.stringify({ result: 'PASS', checks }, null, 2))
} catch (error) {
  fs.mkdirSync('output/custom-admin-roles-20260912', { recursive: true })
  for (const [index, context] of (browser?.contexts() ?? []).entries()) for (const page of context.pages()) {
    await page.screenshot({ path: `output/custom-admin-roles-20260912/failure-${index}.png` })
    console.log('UI failure state:', page.url(), (await page.locator('body').innerText()).slice(-1600))
  }
  throw error
} finally {
  socket?.disconnect(); await browser?.close()
  await p.order.deleteMany({ where: { id: { in: orders } } })
  await p.customer.deleteMany({ where: { id: { in: customers } } }); await p.servicePackage.deleteMany({ where: { id: { in: packages } } })
  await p.operationLog.deleteMany({ where: { operatorId: { in: ids } } }); await p.user.deleteMany({ where: { id: { in: ids } } }); await p.adminRole.deleteMany({ where: { id: { in: jobs } } })
  await p.systemSetting.deleteMany({ where: { key: 'role_permissions_STORE_MANAGER' } }); if (originalManager) await p.systemSetting.create({ data: originalManager })
  await p.$disconnect()
}

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import bcrypt from 'bcryptjs'
import { io } from 'socket.io-client'
import { db, env } from './admin-reminders-local.mjs'

assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const prisma = db()
const marker = 'rename_' + randomBytes(5).toString('hex')
const password = randomBytes(24).toString('base64url')
const ids = []
const checks = []
let socket, browser
const request = async (endpoint, token, method = 'GET', body, status = 200) => {
  const response = await fetch(env.BASE_URL + endpoint, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  assert.equal(response.status, status, `${method} ${endpoint}: ${response.status} ${data.message ?? ''}`)
  return data
}
const login = (username, status = 200) => request('/auth/login', null, 'POST', { username, password }, status)
const connect = (token) => new Promise((resolve, reject) => {
  const client = io('http://127.0.0.1:4210', { auth: { token }, transports: ['websocket'], reconnection: false })
  const timer = setTimeout(() => { client.disconnect(); reject(new Error('Socket timeout')) }, 6000)
  client.once('connect', () => { clearTimeout(timer); resolve(client) })
  client.once('connect_error', () => { clearTimeout(timer); client.disconnect(); reject(new Error('Socket authentication failed')) })
})
try {
  const passwordHash = await bcrypt.hash(password, 10)
  const root = await prisma.user.create({ data: { username: marker + '_owner', passwordHash, role: 'SUPER_ADMIN' } })
  ids.push(root.id)
  const { token } = await login(root.username)
  const create = async (suffix, role = 'STORE_MANAGER') => {
    const { item } = await request('/admin/users', token, 'POST', { username: marker + suffix, password, role }, 201)
    ids.push(item.id); return item
  }
  const target = await create('_old')
  const duplicate = await create('_taken')
  const staff = await prisma.user.create({ data: { username: marker + '_staff', passwordHash, role: 'STAFF', staffProfile: { create: { name: '账号改名专项测试' } } } })
  ids.push(staff.id)
  const original = await prisma.user.findUniqueOrThrow({ where: { id: target.id } })
  const targetLogin = await login(target.username)
  const originalLog = await prisma.operationLog.findFirstOrThrow({ where: { entityId: target.id, action: 'CREATE' } })
  const renamed = marker + '_new'
  const result = await request('/admin/users/' + target.id, token, 'PATCH', { username: '  ' + renamed + '  ', password: 'must-not-write', id: 'must-not-write' })
  assert.equal(result.item.username, renamed)
  const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } })
  assert.equal(after.id, original.id)
  assert.equal(after.passwordHash, original.passwordHash)
  assert.equal(after.role, original.role)
  assert.equal(after.isActive, original.isActive)
  assert.equal((await login(renamed)).user.id, target.id)
  await login(target.username, 401)
  assert.equal((await request('/auth/me', targetLogin.token)).user.username, renamed)
  checks.push('A/B/C/D: trim rename; new login succeeds, old login fails; id/password/role/status unchanged; existing token valid')
  const conflict = await request('/admin/users/' + target.id, token, 'PATCH', { username: duplicate.username }, 409)
  assert.equal(conflict.message, '登录账号已存在，请使用其他账号')
  for (const username of ['', '   ', 'a', 'a'.repeat(65), null]) await request('/admin/users/' + target.id, token, 'PATCH', { username }, 400)
  await request('/admin/users/missing-' + marker, token, 'PATCH', { username: renamed }, 404)
  await request('/admin/users/' + staff.id, token, 'PATCH', { username: renamed }, 400)
  await request('/admin/users/' + target.id, targetLogin.token, 'PATCH', { username: renamed }, 403)
  const staffLogin = await login(staff.username)
  await request('/admin/users/' + target.id, staffLogin.token, 'PATCH', { username: renamed }, 403)
  await request('/admin/users/' + target.id, null, 'PATCH', { username: renamed }, 401)
  await request('/admin/users/' + root.id, token, 'PATCH', { username: root.username, role: 'STORE_MANAGER' }, 400)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).username, renamed)
  checks.push('E/F: duplicate, invalid names, missing target, staff target, unauthorized roles and self demotion rejected')
  const logs = await prisma.operationLog.findMany({ where: { entityId: target.id, action: 'UPDATE' }, include: { operator: true } })
  assert.equal(logs.length, 1)
  assert.equal(logs[0].operatorId, root.id)
  assert.equal(logs[0].detail.targetUserId, target.id)
  assert.equal(logs[0].detail.oldUsername, original.username)
  assert.equal(logs[0].detail.newUsername, renamed)
  assert.equal(logs[0].detail.message, `登录账号修改：${original.username} → ${renamed}`)
  assert(logs[0].createdAt instanceof Date)
  assert.equal((await prisma.operationLog.findUniqueOrThrow({ where: { id: originalLog.id } })).operatorId, root.id)
  checks.push('H: rename audit contains old/new username, target ID, operator ID and timestamp; rejected updates leave no rename log')
  socket = await connect(token)
  const { chromium } = createRequire(path.join(process.env.APPDATA, 'npm', 'package.json'))('playwright')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto('http://127.0.0.1:8280/admin/login')
  await page.getByLabel('账号', { exact: true }).fill(root.username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '进入管理后台' }).click()
  await page.waitForURL('**/admin/dashboard')
  await page.getByText('账号权限', { exact: true }).click()
  await page.waitForURL('**/admin/permissions')
  const browserToken = await page.evaluate(() => localStorage.getItem('club_order_admin_token'))
  const row = page.getByRole('row').filter({ has: page.getByText(root.username, { exact: true }) })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const field = page.getByRole('dialog').getByLabel('登录账号', { exact: true })
  assert.equal(await field.inputValue(), root.username)
  await field.fill('   ')
  await page.getByRole('button', { name: /^保\s*存$/ }).click()
  await page.getByText('请输入登录账号', { exact: true }).waitFor()
  await field.fill(duplicate.username)
  await page.getByRole('button', { name: /^保\s*存$/ }).click()
  await page.getByText('登录账号已存在，请使用其他账号', { exact: true }).waitFor()
  const selfName = marker + '_owner_new'
  await field.fill(selfName)
  await page.getByRole('button', { name: /^保\s*存$/ }).click()
  await page.getByText('登录账号已修改，下次请使用新账号登录。', { exact: true }).waitFor()
  await page.locator('.user-chip').getByText(selfName, { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('club_order_admin_token')), browserToken)
  assert.equal((await request('/auth/me', token)).user.username, selfName)
  assert.equal((await request('/auth/me', token)).user.role, 'SUPER_ADMIN')
  await request('/admin/users', token)
  assert(socket.connected)
  const reconnected = await connect(token); reconnected.disconnect()
  const history = await prisma.operationLog.findUniqueOrThrow({ where: { id: originalLog.id }, include: { operator: true } })
  assert.equal(history.operator.id, root.id)
  assert.equal(history.operator.username, selfName)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: root.id } })).passwordHash, passwordHash)
  assert.equal(pageErrors.length, 0)
  fs.mkdirSync('output/playwright/admin-username', { recursive: true })
  await page.screenshot({ path: 'output/playwright/admin-username/self-renamed.png', fullPage: true })
  checks.push('G/I: real browser self rename updates header/list, keeps token and permissions; connected and reconnected Socket.IO work; history keeps same operator ID')
  await page.getByRole('row').filter({ has: page.getByText(selfName, { exact: true }) }).getByRole('button', { name: '编辑', exact: true }).click()
  await page.screenshot({ path: 'output/playwright/admin-username/edit-account.png', fullPage: true })
  console.log(JSON.stringify({ result: 'PASS', checks, productionTouched: false }, null, 2))
} finally {
  socket?.disconnect()
  await browser?.close()
  if (ids.length) {
    await prisma.operationLog.deleteMany({ where: { OR: [{ operatorId: { in: ids } }, { entityType: 'ADMIN_USER', entityId: { in: ids } }] } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  }
  await prisma.$disconnect()
}

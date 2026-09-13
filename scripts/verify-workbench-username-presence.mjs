import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { io } from 'socket.io-client'
import { testEnvironment } from './feedback-isolated-env.mjs'

const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const base = 'http://127.0.0.1:4210', origin = 'http://127.0.0.1:8280'
const out = path.resolve('output/workbench-password-20260912')
fs.mkdirSync(out, { recursive: true })
const secret = `Demo-${randomBytes(16).toString('hex')}!`, marker = Date.now()
const ids = [], sockets = [], checks = [], errors = []
let browser
const request = async (url, status, token, body, method = 'POST') => {
  const r = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  assert.equal(r.status, status, `${url}: ${r.status}`)
  return r.json()
}
const login = (username, status = 200) => request('/auth/login', status, null, { username, password: secret })
const waitPresence = async (userId, expected, timeout = 5000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const row = await p.staffProfile.findUnique({ where: { userId }, select: { presence: true } })
    if (row?.presence === expected) return
    await new Promise(r => setTimeout(r, 150))
  }
  throw Error(`Presence did not become ${expected}`)
}
const socket = async (token, portal = 'workbench') => {
  const s = io(base, { auth: { token, portal }, transports: ['websocket'], reconnection: false })
  sockets.push(s)
  await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject) })
  return s
}
try {
  const admin = await p.user.create({ data: { username: `DEMO_MANAGER_${marker}`, passwordHash: await bcrypt.hash(secret, 10), role: 'SUPER_ADMIN' } }); ids.push(admin.id)
  const a = await p.user.create({ data: { username: `DEMO_STAFF_OLD_${marker}`, passwordHash: await bcrypt.hash(secret, 10), role: 'STAFF', staffProfile: { create: { name: '账号在线专项演示A', commissionRateBps: 3000 } } }, include: { staffProfile: true } }); ids.push(a.id)
  const b = await p.user.create({ data: { username: `DEMO_STAFF_B_${marker}`, passwordHash: await bcrypt.hash(secret, 10), role: 'STAFF', staffProfile: { create: { name: '账号在线专项演示B' } } }, include: { staffProfile: true } }); ids.push(b.id)
  const adminToken = (await login(admin.username)).token
  await waitPresence(a.id, 'OFFLINE'); checks.push('presence A: never connected employee OFFLINE')
  const token = (await login(a.username)).token
  await waitPresence(a.id, 'OFFLINE'); checks.push('HTTP login alone does not falsely set ONLINE')
  const adminSocket = await socket(adminToken, 'admin')
  await request('/staff', 200, adminToken, undefined, 'GET')
  await request(`/staff/${a.staffProfile.id}`, 200, adminToken, { presence: 'ONLINE' }, 'PATCH')
  await waitPresence(a.id, 'OFFLINE'); checks.push('presence G: admin socket, list read and obsolete presence edit do not mark employee online')
  const wrongPortal = await socket(token, 'admin')
  await waitPresence(a.id, 'OFFLINE'); wrongPortal.disconnect()
  const s1 = await socket(token), s2 = await socket(token)
  await waitPresence(a.id, 'ONLINE'); checks.push('presence B: authenticated workbench connection ONLINE')
  s1.disconnect(); await waitPresence(a.id, 'ONLINE')
  s2.disconnect(); await waitPresence(a.id, 'OFFLINE'); checks.push('last connection owns offline; one of multiple sockets closing keeps ONLINE')
  const drop = await socket(token); await waitPresence(a.id, 'ONLINE')
  const engine = drop.io.engine
  // Drop pong packets while keeping the transport open to simulate a black-holed connection.
  const originalSend = engine.transport.send.bind(engine.transport)
  engine.transport.send = packets => originalSend(packets.filter(packet => packet.type !== 'pong'))
  const lostAt = Date.now()
  await waitPresence(a.id, 'OFFLINE', 35000)
  const timeoutMs = Date.now() - lostAt
  drop.disconnect(); checks.push(`presence E: missing heartbeat goes OFFLINE in ${timeoutMs}ms (10s ping + 20s timeout)`)
  const before = await p.user.findUnique({ where: { id: a.id } })
  const profileBefore = await p.staffProfile.findUnique({ where: { userId: a.id } })
  const newUsername = `DEMO_STAFF_NEW_${marker}`
  const rename = (status, body, t = token) => request('/workbench/change-username', status, t, body)
  const data = { newUsername, currentPassword: secret }
  await rename(401, data, null); await rename(403, data, adminToken)
  assert.equal((await rename(400, { ...data, currentPassword: 'wrong' })).message, '当前密码不正确')
  for (const duplicate of [admin.username, b.username]) assert.equal((await rename(409, { ...data, newUsername: duplicate })).message, '登录账号已存在，请使用其他账号')
  await rename(400, { ...data, newUsername: ` ${a.username} ` })
  await rename(400, { ...data, newUsername: ' ' }); await rename(400, { ...data, newUsername: 'x'.repeat(65) })
  for (const userId of [b.id, admin.id]) await rename(400, { ...data, userId })
  await rename(400, { ...data, role: 'SUPER_ADMIN', adminRoleId: admin.id })
  assert.deepEqual(await p.user.findUnique({ where: { id: a.id } }), before)
  checks.push('username C/D/E/F: duplicate across all roles, wrong password, unchanged name, invalid length and forged targets rejected')
  const { chromium } = createRequire(import.meta.url)('playwright')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()) })
  const btn = (scope, name) => scope.locator('button').filter({ hasText: new RegExp('^\\s*' + name.split('').join('\\s*') + '\\s*$') })
  const uiLogin = async username => {
    await page.goto(origin + '/workbench/login'); await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill(secret)
    await btn(page, '进入工作台').click(); await page.waitForURL('**/workbench'); await waitPresence(a.id, 'ONLINE')
  }
  await uiLogin(a.username)
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.waitForURL('**/workbench/login'); await waitPresence(a.id, 'OFFLINE'); checks.push('presence C: normal browser logout OFFLINE')
  await uiLogin(a.username)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 390, height: 450 }]) {
    await page.setViewportSize(viewport); await btn(page, '账号与安全').click(); await page.getByRole('menuitem', { name: '修改登录账号', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '修改登录账号', exact: true })
    await dialog.waitFor(); await page.waitForTimeout(250)
    assert.equal(await dialog.getByLabel('当前登录账号').inputValue(), a.username)
    assert.equal(await dialog.locator('input[type=password]').count(), 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const save = await btn(dialog, '保存').boundingBox(); assert(save && save.y + save.height <= viewport.height)
    await page.mouse.move(0, 0); await page.screenshot({ path: path.join(out, `username-${viewport.width}x${viewport.height}.png`), animations: 'disabled' })
    await btn(dialog, '取消').click()
  }
  await page.setViewportSize({ width: 390, height: 844 }); await btn(page, '账号与安全').click(); await page.getByRole('menuitem', { name: '修改登录账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '修改登录账号', exact: true })
  await dialog.getByLabel('新登录账号', { exact: true }).fill(` ${newUsername} `)
  await dialog.getByLabel('当前密码', { exact: true }).fill(secret)
  await btn(dialog, '保存').click(); await page.waitForURL('**/workbench/login')
  await page.getByText('登录账号修改成功，请使用新账号重新登录', { exact: true }).waitFor()
  await waitPresence(a.id, 'OFFLINE')
  await login(a.username, 401); await login(newUsername)
  const after = await p.user.findUnique({ where: { id: a.id } })
  for (const field of ['id', 'passwordHash', 'role', 'adminRoleId', 'isActive']) assert.equal(after[field], before[field])
  const profileAfter = await p.staffProfile.findUnique({ where: { userId: a.id } })
  for (const field of Object.keys(profileBefore).filter(k => !['presence', 'updatedAt'].includes(k))) assert.deepEqual(profileAfter[field], profileBefore[field])
  assert.equal(after.username, newUsername)
  const list = await request('/staff', 200, adminToken, undefined, 'GET')
  assert.equal(list.items.find(s => s.id === a.staffProfile.id).username, newUsername)
  const logs = await p.operationLog.findMany({ where: { operatorId: a.id } })
  const log = logs.find(l => l.action === 'STAFF_CHANGE_USERNAME')
  assert(log); assert.equal(log.detail.oldUsername, a.username); assert.equal(log.detail.newUsername, newUsername); assert.equal(log.entityId, a.id)
  assert(logs.some(l => l.action === 'LOGIN' && l.operatorId === a.id))
  assert(!JSON.stringify(logs).includes(secret)); assert(!JSON.stringify(logs).includes(after.passwordHash))
  checks.push('username A/B/G/H: trimmed rename, old login rejected/new original-password login works; identity/profile/hash unchanged; admin list and historical logs correct')
  await uiLogin(newUsername); checks.push('username I: rename logout OFFLINE; new username workbench connection ONLINE under same userId')
  await context.close(); await waitPresence(a.id, 'OFFLINE', 35000); checks.push('presence D: browser close becomes OFFLINE within disconnect/heartbeat timeout')
  assert.equal(errors.length, 0)
  adminSocket.disconnect()
  fs.writeFileSync(path.join(out, 'username-presence-tests.json'), JSON.stringify({ result: 'PASS', checks, consoleErrors: errors, heartbeatOfflineMs: timeoutMs, physicalDeviceKeyboard: 'Reduced viewport tested; no physical device used' }, null, 2))
  console.log(JSON.stringify({ result: 'PASS', checks: checks.length, heartbeatOfflineMs: timeoutMs, consoleErrors: errors.length }))
} finally {
  for (const s of sockets) s.disconnect()
  if (browser) await browser.close()
  await new Promise(r => setTimeout(r, 300))
  await p.operationLog.deleteMany({ where: { operatorId: { in: ids } } })
  await p.staffProfile.deleteMany({ where: { userId: { in: ids } } })
  await p.user.deleteMany({ where: { id: { in: ids } } })
  await p.$disconnect()
}

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { testEnvironment } from './feedback-isolated-env.mjs'

const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const out = path.resolve('output/workbench-password-20260912')
fs.mkdirSync(out, { recursive: true })
const base = 'http://127.0.0.1:4210/api', origin = 'http://127.0.0.1:8280'
const password = () => `Demo-${randomBytes(15).toString('hex')}!`
const old = password(), next = password(), reset = password(), marker = `PWD_${Date.now()}`
const created = [], tests = [], errors = []
let browser
const request = async (url, status, token, body, method = 'POST') => {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  assert.equal(response.status, status, `${url}: unexpected status ${response.status}`)
  return response.json()
}
const login = async (username, secret, status = 200) => request('/auth/login', status, null, { username, password: secret })
const body = (currentPassword = old, newPassword = next) => ({ currentPassword, newPassword, confirmPassword: newPassword })
const change = (status, token, data = body()) => request('/workbench/change-password', status, token, data)
try {
  for (const role of ['SUPER_ADMIN', 'STAFF', 'STAFF']) {
    const user = await prisma.user.create({ data: { username: `${marker}_${created.length}`, passwordHash: await bcrypt.hash(old, 10), role, ...(role === 'STAFF' ? { staffProfile: { create: { name: `改密演示员工${created.length}` } } } : {}) }, include: { staffProfile: true } })
    created.push(user)
  }
  const [admin, a, b] = created
  const adminToken = (await login(admin.username, old)).token
  const token = (await login(a.username, old)).token
  const before = await prisma.user.findMany({ where: { id: { in: created.map(u => u.id) } }, orderBy: { id: 'asc' } })
  await change(401, null); tests.push('F: unauthenticated 401')
  await change(403, adminToken); tests.push('administrator cannot use employee-only endpoint')
  assert.equal((await change(400, token, body('wrong-current'))).message, '当前密码不正确'); tests.push('C: wrong current password rejected')
  assert.equal((await change(400, token, { ...body(), confirmPassword: password() })).message, '两次输入的新密码不一致'); tests.push('D: server rejects mismatched confirmation')
  assert.equal((await change(400, token, body(old, old))).message, '新密码不能与当前密码相同'); tests.push('E: same password rejected')
  await change(400, token, body(old, '12345'))
  await change(400, token, body(old, 'x'.repeat(73))); tests.push('shared 6–72 length bounds enforced')
  for (const userId of [b.id, admin.id]) await change(400, token, { ...body(), userId })
  await change(400, token, { ...body(), username: 'tamper', role: 'SUPER_ADMIN', adminRoleId: admin.id })
  assert.deepEqual(await prisma.user.findMany({ where: { id: { in: created.map(u => u.id) } }, orderBy: { id: 'asc' } }), before)
  tests.push('G/H: forged target and privilege fields rejected; all accounts unchanged')
  await prisma.user.update({ where: { id: a.id }, data: { isActive: false } })
  await change(401, token)
  await prisma.user.update({ where: { id: a.id }, data: { isActive: true } })
  tests.push('disabled employee rejected')
  assert.equal((await change(200, token)).message, '密码修改成功，请使用新密码重新登录')
  await login(a.username, old, 401); await login(a.username, next)
  tests.push('A/B: valid change; old login fails, new login succeeds')
  const updated = await prisma.user.findUnique({ where: { id: a.id } })
  for (const field of ['id', 'username', 'role', 'adminRoleId', 'isActive']) assert.equal(updated[field], a[field])
  assert.equal(updated.passwordHash.slice(4, 6), '10')
  const logs = await prisma.operationLog.findMany({ where: { operatorId: a.id, action: 'STAFF_CHANGE_PASSWORD' } })
  assert.equal(logs.length, 1); assert.equal(logs[0].entityId, a.id)
  assert.equal(logs[0].detail.source, 'workbench'); assert.equal(logs[0].detail.userId, a.id)
  const logText = JSON.stringify(logs)
  for (const forbidden of [old, next, updated.passwordHash, 'passwordHash', 'currentPassword', 'newPassword']) assert(!logText.includes(forbidden))
  tests.push('transaction log contains identity, workbench source and time; no password/hash')
  await request('/auth/me', 401, token, undefined, 'GET'); tests.push('old JWT immediately rejected after password change')
  await request(`/staff/${a.staffProfile.id}/reset-password`, 200, adminToken, { password: reset })
  await login(a.username, next, 401); await login(a.username, reset); tests.push('I: original administrator reset remains functional')
  const { chromium } = createRequire(import.meta.url)('playwright')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()) })
  const btn = (scope, name) => scope.locator('button').filter({ hasText: new RegExp('^\\s*' + name.split('').join('\\s*') + '\\s*$') })
  const uiLogin = async (username, secret, staff) => {
    await page.goto(origin + (staff ? '/workbench/login' : '/admin/login'))
    await page.getByLabel('账号', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill(secret)
    await btn(page, staff ? '进入工作台' : '进入管理后台').click()
    await page.waitForURL(url => !url.pathname.endsWith('/login'))
    await page.waitForTimeout(500)
  }
  await uiLogin(admin.username, old, false)
  const adminStored = await page.evaluate(() => localStorage.getItem('club_order_admin_token'))
  await uiLogin(a.username, reset, true)
  let posts = 0
  page.on('request', r => { if (r.url().endsWith('/workbench/change-password')) posts++ })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 390, height: 450 }]) {
    await page.setViewportSize(viewport)
    await btn(page, '账号与安全').click(); await page.getByRole('menuitem', { name: '修改登录密码', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '修改登录密码', exact: true })
    await dialog.waitFor(); await page.waitForTimeout(250)
    assert.equal(await dialog.locator('input[type=password]').count(), 3)
    await dialog.locator('.ant-input-password-icon').first().click()
    assert.equal(await dialog.locator('input[type=text]').count(), 1)
    await dialog.locator('.ant-input-password-icon').first().click()
    await dialog.getByLabel('确认新密码', { exact: true }).focus()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const save = await btn(dialog, '保存').boundingBox()
    assert(save && save.y >= 0 && save.y + save.height <= viewport.height)
    await page.mouse.move(0, 0)
    await page.screenshot({ path: path.join(out, `password-${viewport.width}x${viewport.height}.png`), animations: 'disabled' })
    await btn(dialog, '保存').click()
    await dialog.getByText('请输入当前密码', { exact: true }).waitFor()
    await btn(dialog, '取消').click()
  }
  tests.push('PC 1440×900, mobile 390×844 and reduced 390×450 viewport: entry, visibility toggles, scroll, save and required validation')
  await page.setViewportSize({ width: 390, height: 844 }); await btn(page, '账号与安全').click(); await page.getByRole('menuitem', { name: '修改登录密码', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '修改登录密码', exact: true })
  await dialog.getByLabel('当前密码', { exact: true }).fill(reset)
  await dialog.getByLabel('新密码', { exact: true }).fill(reset)
  await dialog.getByLabel('确认新密码', { exact: true }).fill('different')
  await btn(dialog, '保存').click()
  await dialog.getByText('新密码不能与当前密码相同', { exact: true }).waitFor()
  await dialog.getByText('两次输入的新密码不一致', { exact: true }).waitFor()
  assert.equal(posts, 0)
  tests.push('D/E frontend prevents mismatch and same password before request')
  const final = password()
  await dialog.getByLabel('新密码', { exact: true }).fill(final)
  await dialog.getByLabel('确认新密码', { exact: true }).fill(final)
  await btn(dialog, '保存').click(); await page.waitForURL('**/workbench/login')
  await page.getByText('密码修改成功，请使用新密码重新登录', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('club_order_workbench_token')), null)
  assert.equal(await page.evaluate(() => localStorage.getItem('club_order_workbench_user')), null)
  assert.equal(await page.evaluate(() => localStorage.getItem('club_order_admin_token')), adminStored)
  await page.goto(origin + '/admin/permissions'); await page.getByText('账号权限').first().waitFor()
  assert(!page.url().endsWith('/login'))
  tests.push('J: employee cleared and redirected with success notice; admin token/session retained')
  await uiLogin(a.username, final, true)
  assert.equal(errors.length, 0)
  tests.push('new password logs in from browser; no console or page errors')
  fs.writeFileSync(path.join(out, 'tests.json'), JSON.stringify({ result: 'PASS', tests, consoleErrors: errors, physicalKeyboard: 'Not tested on a physical device; reduced viewport verified' }, null, 2))
  console.log(JSON.stringify({ result: 'PASS', checks: tests.length, consoleErrors: errors.length }))
} finally {
  if (browser) await browser.close()
  // Only this run's synthetic identities and their audit rows are removed.
  const ids = created.map(u => u.id)
  await prisma.operationLog.deleteMany({ where: { operatorId: { in: ids } } })
  await prisma.staffProfile.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
}

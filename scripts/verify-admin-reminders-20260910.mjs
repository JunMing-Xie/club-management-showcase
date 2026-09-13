import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import bcrypt from 'bcryptjs'
import { io } from 'socket.io-client'
import { db as makeDb } from './admin-reminders-local.mjs'

const db = makeDb()
const output = 'output/admin-reminders-20260910'
fs.mkdirSync(output, { recursive: true })
const marker = randomUUID().slice(0, 8)
const password = `Local-only-${randomUUID()}`
const users = {}
const sessions = {}
const report = { database: 'club_management_showcase_test', checks: [], browser: { errors: [], warnings: [], failures: [], screens: [], roles: [] } }
const base = 'http://127.0.0.1:4210/api'
const entry = 'http://127.0.0.1:8280'
let browser, socket
const check = label => { report.checks.push(label); console.log(`PASS ${label}`) }
const request = async (route, { role = 'SUPER_ADMIN', method = 'GET', body, form, expected = 200 } = {}) => {
  const headers = sessions[role] ? { Authorization: `Bearer ${sessions[role].token}` } : {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(base + route, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) })
  const data = await r.json()
  assert.equal(r.status, expected, `${method} ${route}: ${JSON.stringify(data)}`)
  return data
}
const feed = role => request('/admin/reminders', { role })
const clientFingerprint = async () => {
  // Read-only aggregate evidence; no customer records or credentials are printed or copied.
  const rows = await db.$queryRawUnsafe(`SELECT
    (SELECT COUNT(*) FROM club_management_showcase_test.orders) orders,
    (SELECT MAX(updatedAt) FROM club_management_showcase_test.orders) latestOrder,
    (SELECT COUNT(*) FROM club_management_showcase_test.customers) customers,
    (SELECT SUM(balanceCents) FROM club_management_showcase_test.customers) balances,
    (SELECT MAX(updatedAt) FROM club_management_showcase_test.customers) latestCustomer,
    (SELECT COUNT(*) FROM club_management_showcase_test.operation_logs) logs,
    (SELECT COUNT(*) FROM club_management_showcase_test.fund_transactions) funds,
    (SELECT COUNT(*) FROM club_management_showcase_test.order_staff_assignments) assignments,
    (SELECT MAX(updatedAt) FROM club_management_showcase_test.order_staff_assignments) latestAssignment,
    (SELECT MAX(updatedAt) FROM club_management_showcase_test.after_sale_cases) latestAfterSale,
    (SELECT COUNT(*) FROM club_management_showcase_test.after_sale_messages) messages`)
  return createHash('sha256').update(JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? String(value) : value)).digest('hex')
}
const before = await clientFingerprint()
try {
  const hash = await bcrypt.hash(password, 10)
  for (const role of ['SUPER_ADMIN', 'STORE_MANAGER', 'CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE', 'STAFF_A', 'STAFF_B']) {
    const staff = role.startsWith('STAFF_')
    users[role] = await db.user.create({ data: { username: `remind-${marker}-${role.toLowerCase()}`, passwordHash: hash, role: staff ? 'STAFF' : role,
      ...(staff ? { staffProfile: { create: { name: role === 'STAFF_A' ? '阿凯（独立验收）' : '小林（独立验收）', presence: 'ONLINE', accepting: 'ACCEPTING' } } } : {}) }, include: { staffProfile: true } })
    sessions[role] = await request('/auth/login', { role, method: 'POST', body: { username: users[role].username, password, role: staff ? 'STAFF' : 'ADMIN' } })
  }
  socket = io('http://127.0.0.1:4210', { auth: { token: sessions.SUPER_ADMIN.token } })
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 10000); socket.once('connect', () => { clearTimeout(timer); resolve() }); socket.once('connect_error', reject) })
  let events = 0
  socket.on('data:changed', () => events++)
  const initial = await feed()
  const customer = await db.customer.create({ data: { name: '独立提醒验收', customerCode: `REMIND-${marker}`, teamCode: `TEAM-${marker}`, principalBalanceCents: 1000000, balanceCents: 1000000 } })
  const service = await db.servicePackage.findFirstOrThrow({ where: { isEnabled: true } })
  const make = async (count = 1) => (await request('/orders', { method: 'POST', expected: 201, body: { customerId: customer.id, servicePackageId: service.id, amountCents: 10000, requiredStaffCount: count, collaborationSlots: Array.from({ length: count }, (_, i) => ({ slotIndex: i + 1, commissionRateBps: 3000 })), note: `独立提醒验收 ${marker}` } })).item
  const claim = (order, role = 'STAFF_A') => request(`/orders/${order.id}/claim`, { role, method: 'POST', body: {} })
  const start = order => request(`/orders/${order.id}/start`, { role: 'STAFF_A', method: 'POST', body: {} })
  const submit = (order, role = 'STAFF_A') => {
    const form = new FormData()
    form.set('note', '独立验证完单凭证，不涉及客户数据')
    form.set('proofs', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'proof.png')
    return request(`/orders/${order.id}/completion-submissions`, { role, method: 'POST', form })
  }
  const review = (order, approved = true) => request(`/orders/${order.id}/completion-review`, { method: 'POST', body: { approved, reason: '独立验证审核退回' } })
  const hasActivity = (data, order, action) => data.activities.some(item => item.orderNo === order.orderNo && item.action === action)
  const order = await make(2)
  await claim(order)
  await claim(order) // Network retry remains one successful claim event.
  let data = await feed()
  assert.equal(data.total, initial.total)
  assert.equal(data.activities.filter(item => item.orderNo === order.orderNo && item.action === 'CLAIM').length, 1)
  check('A 接单动态出现，重复接单不重复记录，待办不增加')
  await claim(order, 'STAFF_B')
  await start(order)
  data = await feed()
  assert(hasActivity(data, order, 'START'))
  assert.equal(data.total, initial.total)
  check('B 开始服务只有动态，无新增待办')
  await submit(order)
  data = await feed()
  assert(hasActivity(data, order, 'SUBMIT_COMPLETION'))
  assert.equal(data.counts.completion, initial.counts.completion)
  await submit(order, 'STAFF_B')
  data = await feed()
  assert.equal(data.counts.completion, initial.counts.completion + 1)
  assert.equal(data.todos.filter(item => item.orderId === order.id && item.kind === 'completion').length, 1)
  check('C 两人订单仅全员提交后产生一个审核待办，个人提交保留动态')
  await review(order, false)
  assert.equal((await feed()).counts.completion, initial.counts.completion)
  await submit(order); await submit(order, 'STAFF_B'); await review(order)
  assert.equal((await feed()).counts.completion, initial.counts.completion)
  check('D 审核退回和通过都使待办消失，重新提交后可正常审核')
  const exitOrder = await make()
  await claim(exitOrder); await start(exitOrder)
  const exit = () => request(`/orders/${exitOrder.id}/exit`, { role: 'STAFF_A', method: 'POST', body: { reason: '独立验收，需要退出当前服务' } })
  await exit()
  data = await feed()
  assert.equal(data.counts.exit, initial.counts.exit + 1)
  let assignment = await db.orderStaffAssignment.findFirstOrThrow({ where: { orderId: exitOrder.id, assignmentStatus: 'EXIT_REQUESTED' } })
  const exitReview = approved => request(`/orders/${exitOrder.id}/assignments/${assignment.id}/exit-review`, { method: 'POST', body: { approved, note: '独立退出审核' } })
  await exitReview(false)
  assert.equal((await feed()).counts.exit, initial.counts.exit)
  await exit(); await exitReview(true)
  assert.equal((await feed()).counts.exit, initial.counts.exit)
  const normalExit = await make()
  await claim(normalExit)
  await request(`/orders/${normalExit.id}/exit`, { role: 'STAFF_A', method: 'POST', body: { reason: '开工前正常退出' } })
  data = await feed()
  assert(hasActivity(data, normalExit, 'EXIT_ORDER'))
  assert.equal(data.counts.exit, initial.counts.exit)
  check('E 开始后退出生成待办，批准/拒绝后消失；开工前退出只产生动态')
  const sale = (await request('/after-sales', { method: 'POST', expected: 201, body: { orderId: order.id, issueType: '独立提醒验收', description: '客户反馈，请管理员跟进处理' } })).item
  data = await feed()
  assert.equal(data.counts.afterSale, initial.counts.afterSale + 1)
  const originalTime = data.todos.find(item => item.id === `afterSale:${sale.id}`).occurredAt
  const followup = '员工追加跟进：凭证已补充，请核对服务时长'
  await request(`/after-sales/${sale.id}/messages`, { role: 'STAFF_A', method: 'POST', expected: 201, body: { content: followup } })
  data = await feed()
  assert.equal(data.counts.afterSale, initial.counts.afterSale + 1)
  const saleTodo = data.todos.filter(item => item.id === `afterSale:${sale.id}`)
  assert.equal(saleTodo.length, 1)
  assert.equal(saleTodo[0].summary, followup)
  assert(new Date(saleTodo[0].occurredAt) >= new Date(originalTime))
  await request(`/after-sales/${sale.id}`, { method: 'PATCH', body: { status: 'COMPLETED', handlingNote: '独立验证完成，无资金调整' } })
  assert.equal((await feed()).counts.afterSale, initial.counts.afterSale)
  check('F 正式售后仅一个待办，跟进更新摘要与时间，完成后消失')
  await request('/staff/me/presence', { role: 'STAFF_A', method: 'PATCH', body: { presence: 'ONLINE' } })
  assert((await feed()).activities.some(item => item.action === 'UPDATE_PRESENCE'))
  check('其他员工在线状态操作复用日志进入动态')

  // Leave explicit independent fixtures for the screenshots and human review.
  const pendingOrder = await make(2)
  await claim(pendingOrder); await claim(pendingOrder, 'STAFF_B'); await start(pendingOrder); await submit(pendingOrder); await submit(pendingOrder, 'STAFF_B')
  await claim(exitOrder); await exit()
  assignment = await db.orderStaffAssignment.findFirstOrThrow({ where: { orderId: exitOrder.id, assignmentStatus: 'EXIT_REQUESTED' } })
  await request(`/after-sales/${sale.id}`, { method: 'PATCH', body: { status: 'PROCESSING', handlingNote: '独立验收：继续核对中' } })
  data = await feed()
  for (const [role, allowed] of Object.entries({ SUPER_ADMIN: [true, true, true], STORE_MANAGER: [true, true, true], CUSTOMER_SERVICE: [true, false, true], DISPATCHER: [false, true, false], FINANCE: [false, false, false] })) {
    const result = await feed(role)
    assert.deepEqual(Object.values(result.allowed), allowed)
    for (const [i, kind] of ['completion', 'exit', 'afterSale'].entries()) if (!allowed[i]) { assert.equal(result.counts[kind], 0); assert(!result.todos.some(item => item.kind === kind)) }
    assert.equal(result.total, Object.values(result.counts).reduce((sum, value) => sum + value, 0))
    assert(result.activities.length <= 30)
  }
  await request('/admin/reminders', { role: 'STAFF_A', expected: 403 })
  await request('/admin/reminders?page=0', { expected: 400 })
  assert(events > 0)
  report.socketEvents = events
  check('I 服务端按5种管理角色过滤待办，员工403；分页校验和动态30条上限通过')

  const { chromium } = createRequire(import.meta.url)('playwright')
  browser = await chromium.launch({ headless: true })
  const watch = page => {
    page.on('pageerror', e => report.browser.errors.push(e.message))
    page.on('console', message => { if (message.type() === 'error') report.browser.errors.push(message.text()); if (message.type() === 'warning') report.browser.warnings.push(message.text()) })
    page.on('response', r => { if (r.status() >= 400) report.browser.failures.push({ status: r.status(), path: new URL(r.url()).pathname }) })
  }
  const login = async (page, role = 'SUPER_ADMIN') => {
    await page.goto(entry + '/admin/login')
    await page.getByLabel('账号', { exact: true }).fill(users[role].username)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: /进入管理后台/ }).click()
    await page.waitForURL('**/admin/dashboard')
    await page.getByRole('button', { name: /^提醒与待办，/ }).waitFor()
  }
  const screenshot = async (page, name) => {
    await page.locator('.ant-message-notice').first().waitFor({ state: 'hidden', timeout: 5000 })
    await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled', fullPage: false })
    assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'body horizontal overflow')
    report.browser.screens.push(name)
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage(); watch(page)
  await login(page)
  const expectCount = async total => page.getByRole('button', { name: `提醒与待办，${total} 项`, exact: true }).waitFor()
  await expectCount(data.total)
  await screenshot(page, '01-dashboard-todos')
  await page.locator('.admin-header').screenshot({ path: `${output}/02-header-badge.png` })
  await page.getByRole('button', { name: /^提醒与待办，/ }).click()
  const drawer = page.getByRole('dialog', { name: '提醒与待办' })
  await drawer.waitFor()
  await screenshot(page, '03-todo-list')
  await drawer.getByRole('tab', { name: '动态', exact: true }).click()
  await screenshot(page, '04-employee-activity')
  await drawer.getByRole('tab', { name: /^待办/ }).click()
  await drawer.getByRole('button', { name: new RegExp(`订单【${pendingOrder.orderNo}】待完单审核`) }).click()
  await page.getByRole('dialog', { name: '订单详情', exact: true }).waitFor()
  await page.getByRole('button', { name: /审核通过/ }).waitFor()
  await screenshot(page, '05-completion-review')
  await page.getByRole('dialog', { name: '订单详情', exact: true }).locator('.ant-modal-close').click()
  // A second reminder while already on /orders must locate a different order.
  await page.getByRole('button', { name: /^提醒与待办，/ }).click()
  await drawer.getByRole('button', { name: new RegExp(`申请退出订单【${exitOrder.orderNo}】`) }).click()
  await page.getByRole('button', { name: '同意退出', exact: true }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('orderId'), exitOrder.id)
  await screenshot(page, '06-exit-request')
  await page.getByRole('dialog', { name: '订单详情', exact: true }).locator('.ant-modal-close').click()
  await page.getByRole('button', { name: /^提醒与待办，/ }).click()
  await drawer.getByRole('button', { name: new RegExp(`订单【${order.orderNo}】有售后待处理`) }).click()
  await page.getByRole('dialog', { name: '售后详情', exact: true }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('afterSaleId'), sale.id)
  await screenshot(page, '07-after-sale')
  await page.goto(entry + '/admin/dashboard'); await expectCount(data.total)
  await page.reload(); await expectCount(data.total)
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await login(page); await expectCount(data.total)
  check('G/H 实际刷新与退出重登后待办一致；三种待办直达详情，同页连续定位通过')

  // A connected dashboard reacts to authoritative state changes, including reconnect recovery.
  const beforeLive = (await feed()).total
  await review(pendingOrder)
  await expectCount(beforeLive - 1)
  await exitReview(false)
  await expectCount(beforeLive - 2)
  await exit()
  await expectCount(beforeLive - 1)
  await context.setOffline(true)
  await request(`/after-sales/${sale.id}`, { method: 'PATCH', body: { status: 'COMPLETED', handlingNote: '断网期间独立售后完成' } })
  await context.setOffline(false)
  await expectCount(beforeLive - 2)
  check('Socket.IO 自动刷新审核/退出计数，断网期间处理售后后重连补拉状态')
  // Restore screenshot fixtures only, using real workflow operations.
  const finalPending = await make()
  await claim(finalPending); await start(finalPending); await submit(finalPending)
  await request(`/after-sales/${sale.id}`, { method: 'PATCH', body: { status: 'PROCESSING', handlingNote: '独立截图待处理事项' } })
  const finalTotal = (await feed()).total
  await expectCount(finalTotal)
  await page.setViewportSize({ width: 390, height: 844 })
  await screenshot(page, '09-mobile-dashboard')
  await page.getByRole('button', { name: /^提醒与待办，/ }).click()
  await drawer.waitFor()
  await screenshot(page, '08-mobile-reminder-drawer')
  const bounds = await drawer.boundingBox()
  assert(bounds && bounds.x >= 0 && bounds.width <= 390)
  await drawer.getByRole('button', { name: new RegExp(`订单【${finalPending.orderNo}】待完单审核`) }).click()
  await page.getByRole('button', { name: /审核通过/ }).waitFor()
  await screenshot(page, '10-mobile-deep-link')

  for (const role of ['STORE_MANAGER', 'CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE']) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const p = await c.newPage(); watch(p)
    await login(p, role)
    const r = await feed(role)
    await p.getByRole('button', { name: `提醒与待办，${r.total} 项`, exact: true }).waitFor()
    for (const kind of ['completion', 'exit', 'afterSale'].filter(key => r.allowed[key])) {
      await p.getByRole('button', { name: /^提醒与待办，/ }).click()
      const item = r.todos.find(t => t.kind === kind)
      assert(item)
      await p.getByRole('dialog', { name: '提醒与待办' }).getByRole('button', { name: new RegExp(item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click()
      await p.getByRole('dialog', { name: kind === 'afterSale' ? '售后详情' : '订单详情', exact: true }).waitFor()
      await p.goto(entry + '/admin/dashboard')
    }
    report.browser.roles.push(role)
    await c.close()
  }
  check('PC 1440×900 / 手机390×844，Drawer和跳转无溢出；各管理角色可见待办点击无403')
  // Offline was intentional; only its browser network diagnostics may be ignored.
  report.browser.errors = report.browser.errors.filter(value => !value.includes('ERR_INTERNET_DISCONNECTED') && !value.includes('WebSocket is closed before the connection is established'))
  assert.deepEqual(report.browser.errors, [])
  assert.deepEqual(report.browser.warnings, [])
  assert.deepEqual(report.browser.failures, [])
  const after = await clientFingerprint()
  assert.equal(after, before)
  report.customerDataFingerprint = { before, after, unchanged: true }
  report.fixtures = { marker, pendingOrderId: finalPending.id, exitOrderId: exitOrder.id, afterSaleId: sale.id }
  check('客户测试库只读指纹保持一致；Console errors/warnings及HTTP失败均0')
  report.ok = true
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  const currentPage = browser?.contexts()[0]?.pages()[0]
  if (currentPage) {
    await currentPage.screenshot({ path: `${output}/failure.png` }).catch(() => {})
    fs.writeFileSync(`${output}/failure-aria.txt`, await currentPage.locator('body').ariaSnapshot().catch(() => 'unavailable'))
  }
  throw error
} finally {
  fs.writeFileSync(`${output}/verification.json`, JSON.stringify(report, null, 2))
  socket?.disconnect()
  await browser?.close()
  await db.$disconnect()
}

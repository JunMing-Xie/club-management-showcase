import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import { testEnvironment } from './feedback-isolated-env.mjs'

const live = false // Showcase never uses a remote customer environment.
const env = live ? dotenv.parse(fs.readFileSync('.env')) : testEnvironment()
assert.equal(new URL(env.DATABASE_URL).pathname, live ? '/club_management_showcase_test' : '/club_management_showcase_test')
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const fixture = live ? { unsettledId: 'demo-legacy-reference', settledId: 'demo-legacy-reference', staffUsername: 'demo_staff' } : JSON.parse(fs.readFileSync('output/hotfix-20260908/financial-validation.json', 'utf8'))
const base = live ? 'http://127.0.0.1:8280' : 'http://127.0.0.1:8280'
const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch({ headless: true })
const diagnostics = { errors: [], failures: [], checks: [] }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', e => diagnostics.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') diagnostics.errors.push(m.text()) })
  page.on('response', r => { if (r.status() >= 400) diagnostics.failures.push({ status: r.status(), path: new URL(r.url()).pathname }) })
  const session = async username => {
    const u = await db.user.findUniqueOrThrow({ where: { username }, include: { staffProfile: true } })
    return { token: jwt.sign({ userId: u.id }, env.JWT_SECRET), user: { id: u.id, username: u.username, role: u.role, isActive: u.isActive, staffProfile: u.staffProfile } }
  }
  await page.goto(base + '/admin/login')
  await page.evaluate(s => { localStorage.setItem('club_order_token', s.token); localStorage.setItem('club_order_user', JSON.stringify(s.user)) }, await session('admin'))
  await page.goto(base + '/admin/after-sales')
  await page.getByText('售后队列', { exact: true }).waitFor()
  const staffPage = await context.newPage()
  await staffPage.goto(base + '/workbench/login')
  await staffPage.evaluate(s => { localStorage.setItem('club_order_token', s.token); localStorage.setItem('club_order_user', JSON.stringify(s.user)) }, await session(fixture.staffUsername))
  await staffPage.reload()
  await staffPage.waitForFunction(() => Boolean(localStorage.getItem('club_order_workbench_token')))
  const me = await page.evaluate(async () => (await (await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('club_order_admin_token') } })).json()).user)
  assert.equal(me.username, 'admin')
  const refreshed = page.waitForResponse(r => r.url().endsWith('/api/after-sales'))
  await page.getByRole('button', { name: /刷\s*新/ }).click()
  assert.equal((await refreshed).status(), 200)
  await page.getByText('售后队列', { exact: true }).waitFor()
  diagnostics.checks.push('管理员和员工同浏览器双标签页登录态隔离，admin 刷新售后 200')
  if (live) {
    await page.getByRole('button', { name: 'CLB202609085578231', exact: true }).click()
    const detail = page.getByRole('dialog', { name: '售后详情' })
    await detail.waitFor()
    assert(await detail.getByRole('button', { name: '订单净额调整', exact: true }).isDisabled())
    assert(await detail.getByText('该订单尚未完成最终审核和结算，暂不能进行售后金额调整。', { exact: true }).isVisible())
    await page.screenshot({ animations: 'disabled', path: 'output/hotfix-20260908/public-after-sale-detail.png' })
    await detail.getByRole('button', { name: /关\s*闭/, exact: true }).last().click()
  }
  for (const [kind, id, disabled] of [['unsettled', fixture.unsettledId, true], ['settled', fixture.settledId, false]]) {
    await page.goto(base + '/admin/orders?orderId=' + id)
    const dialog = page.getByRole('dialog', { name: '订单详情', exact: true })
    await dialog.waitFor()
    const button = dialog.getByRole('button', { name: '登记调整', exact: true })
    assert.equal(await button.isDisabled(), disabled)
    if (!disabled) {
      await button.click()
      await page.getByRole('dialog', { name: '登记完单后净额调整' }).waitFor()
      // Inspect the form only; never submit an adjustment to customer data.
    } else assert(await dialog.getByText('该订单尚未完成最终审核和结算，暂不能进行售后金额调整。', { exact: true }).isVisible())
    await page.screenshot({ animations: 'disabled', path: `output/hotfix-20260908/${live ? 'public' : 'isolated'}-${kind}.png` })
    diagnostics.checks.push(`${kind}: adjustment disabled=${disabled}`)
  }
  assert.deepEqual(diagnostics.errors, [])
  assert.deepEqual(diagnostics.failures, [])
  console.log(JSON.stringify(diagnostics))
} finally {
  fs.writeFileSync(`output/hotfix-20260908/${live ? 'public' : 'isolated'}-browser.json`, JSON.stringify(diagnostics, null, 2))
  await browser.close()
  await db.$disconnect()
}

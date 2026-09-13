import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import { testEnvironment } from './feedback-isolated-env.mjs'

const live = false // Showcase never uses a remote customer environment.
const env = live ? dotenv.parse(fs.readFileSync('.env')) : testEnvironment()
assert.equal(new URL(env.DATABASE_URL).pathname, live ? '/club_management_showcase_test' : '/club_management_showcase_test')
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const base = live ? 'http://127.0.0.1:8280' : 'http://127.0.0.1:8280'
const fixture = live ? null : JSON.parse(fs.readFileSync('output/finance-settlement-20260908/api-tests.json', 'utf8'))
const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch({ headless: true })
const report = { errors: [], failures: [], checks: [] }
try {
  const user = await db.user.findUniqueOrThrow({ where: { username: 'admin' }, select: { id: true, username: true, role: true, isActive: true } })
  const token = jwt.sign({ userId: user.id }, env.JWT_SECRET)
  for (const width of process.argv.includes('--mobile-only') ? [390] : [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, timezoneId: 'Asia/Shanghai' })
    await context.addInitScript(s => { localStorage.setItem('club_order_admin_token', s.token); localStorage.setItem('club_order_admin_user', JSON.stringify(s.user)) }, { token, user })
    const page = await context.newPage()
    page.on('pageerror', e => report.errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text()) })
    page.on('response', r => { if (r.status() >= 400) report.failures.push({ status: r.status(), path: new URL(r.url()).pathname }) })
    const firstResponse = page.waitForResponse(r => r.url().includes('/finance/staff-settlement-summary?period=week'))
    await page.goto(base + '/admin/finance')
    assert.equal((await firstResponse).status(), 200)
    await page.getByText('员工结算明细', { exact: true }).waitFor()
    assert(await page.getByText('期间员工净应得', { exact: true }).isVisible())
    assert(await page.getByText('期间员工参与订单金额', { exact: true }).isVisible())
    assert(await page.getByText('期间已结算', { exact: true }).isVisible())
    await page.screenshot({ animations: 'disabled', path: `output/finance-settlement-20260908/${live ? 'public' : 'isolated'}-week-${width}.png` })
    for (const [label, period] of [['上周', 'lastWeek'], ['本月', 'month'], ['上月', 'lastMonth'], ['本周', 'week']]) {
      const response = page.waitForResponse(r => r.url().includes(`/finance/staff-settlement-summary?period=${period}`))
      await page.locator('.finance-period-shortcuts').getByRole('button', { name: new RegExp(label.split('').join('\\s*')) }).click()
      assert.equal((await response).status(), 200)
      await page.getByText('员工结算明细', { exact: true }).waitFor()
      if (period === 'month') await page.screenshot({ animations: 'disabled', path: `output/finance-settlement-20260908/${live ? 'public' : 'isolated'}-month-${width}.png` })
    }
    const inputs = page.locator('.finance-range-filter .ant-picker-input input')
    await inputs.nth(0).fill('2026-09-01'); await inputs.nth(0).press('Enter')
    await inputs.nth(1).fill('2026-09-08'); await inputs.nth(1).press('Enter')
    const custom = page.waitForResponse(r => r.url().includes('/finance/staff-settlement-summary?period=custom'))
    await page.getByRole('button', { name: /查\s*询/ }).click()
    const customResponse = await custom
    assert.equal(customResponse.status(), 200)
    const customData = (await customResponse.json()).item
    assert.equal(customData.range.startDate, '2026-09-01'); assert.equal(customData.range.endDate, '2026-09-08')
    await page.getByText('员工结算明细', { exact: true }).waitFor()
    await page.screenshot({ animations: 'disabled', path: `output/finance-settlement-20260908/${live ? 'public' : 'isolated'}-custom-${width}.png` })
    const panel = page.locator('.finance-staff-panel')
    await panel.scrollIntoViewIfNeeded()
    if (width === 390) await panel.locator('.ant-collapse-header').first().click()
    else await panel.locator('.ant-table-row-expand-icon').first().click()
    await panel.getByText('期初待结算', { exact: true }).first().waitFor()
    await page.waitForTimeout(400)
    if (width === 390) assert((await panel.locator('.finance-staff-mobile .finance-staff-rolling').first().boundingBox()).height > 100)
    assert(await panel.getByText('本期收益调整', { exact: true }).first().isVisible())
    assert(await panel.getByText('期初待冲抵', { exact: true }).first().isVisible())
    assert(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1))
    await page.screenshot({ animations: 'disabled', path: `output/finance-settlement-20260908/${live ? 'public' : 'isolated'}-details-${width}.png` })
    report.checks.push({ width, weekMonthCustom: true, rollingDetails: true, noHorizontalOverflow: true })
    if (!live && width === 1440) {
      await page.locator('.finance-period-shortcuts').getByRole('button', { name: /本\s*周/ }).click()
      await page.getByText('员工结算明细', { exact: true }).waitFor()
      const a = (await (await fetch(base + '/api/finance/staff-settlement-summary?period=week', { headers: { Authorization: `Bearer ${token}` } })).json()).item.items.find(i => i.staffId === fixture.aId)
      assert.equal(a.pendingCents, 30000)
      await page.getByRole('button', { name: '线下人工结算', exact: true }).click()
      const modal = page.getByRole('dialog', { name: '登记线下人工结算' })
      await modal.getByRole('combobox').first().fill(fixture.aName)
      await page.locator('.ant-select-item-option').filter({ hasText: fixture.aName }).first().click()
      await modal.getByRole('spinbutton').fill('100')
      const paid = page.waitForResponse(r => r.url().includes(`/staff/${fixture.aId}/settlements`) && r.request().method() === 'POST')
      const refreshed = page.waitForResponse(async r => {
        if (!r.url().includes('/finance/staff-settlement-summary') || r.status() !== 200) return false
        const data = await r.json(); return data.item.items.find(i => i.staffId === fixture.aId)?.periodSettledCents === 60000
      })
      await modal.getByRole('button', { name: '保存结算记录', exact: true }).click()
      assert.equal((await paid).status(), 201)
      const paidRow = (await (await refreshed).json()).item.items.find(i => i.staffId === fixture.aId)
      assert.equal(paidRow.pendingCents, 20000)
      await page.getByText('员工结算明细', { exact: true }).waitFor()
      const changeRefresh = page.waitForResponse(async r => {
        if (!r.url().includes('/finance/staff-settlement-summary') || r.status() !== 200) return false
        const data = await r.json(); return data.item.items.find(i => i.staffId === fixture.aId)?.offsetCents === 2000
      })
      const adjusted = await fetch(base + `/api/orders/${fixture.aOrderId}/adjustments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), netAmount: 1000, staffNetEarnings: [{ assignmentId: fixture.aAssignmentId, amount: 580 }], reason: '独立浏览器联动验收' }) })
      assert.equal(adjusted.status, 201)
      const adjustedRow = (await (await changeRefresh).json()).item.items.find(i => i.staffId === fixture.aId)
      assert.equal(adjustedRow.pendingCents, 0); assert.equal(adjustedRow.offsetCents, 2000)
      report.checks.push('独立库实际表单付款后已付600/待200自动更新；售后净应得580后待0/冲抵20自动更新')
    }
    await context.close()
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.failures, [])
  console.log(JSON.stringify(report))
} catch (error) {
  console.error('BROWSER_CHECK_FAILED', error)
  throw error
} finally {
  fs.writeFileSync(`output/finance-settlement-20260908/${live ? 'public' : 'isolated'}-browser.json`, JSON.stringify(report, null, 2))
  await browser.close(); await db.$disconnect()
}

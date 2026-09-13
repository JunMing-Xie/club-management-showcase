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
const base = live ? 'http://127.0.0.1:8280' : 'http://127.0.0.1:8280'
const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch({ headless: true })
const report = { errors: [], failedRequests: [], checked: [] }
try {
  const user = await db.user.findUniqueOrThrow({ where: { username: 'admin' }, select: { id: true, username: true, role: true, isActive: true } })
  const token = jwt.sign({ userId: user.id }, env.JWT_SECRET)
  const response = await fetch(base + '/api/orders', { headers: { Authorization: 'Bearer ' + token } })
  assert.equal(response.status, 200)
  const orders = (await response.json()).items
  const eligible = orders.filter(o => ['COMPLETED', 'AFTER_SALE'].includes(o.status) && o.completedAt && o.completionReviewStatus === 'APPROVED' && o.hasOriginalSettlement && !o.afterSaleCase)
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } })
    await context.addInitScript(s => { localStorage.setItem('club_order_admin_token', s.token); localStorage.setItem('club_order_admin_user', JSON.stringify(s.user)) }, { token, user })
    const page = await context.newPage()
    page.on('pageerror', e => report.errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text()) })
    page.on('response', r => { if (r.status() >= 400) report.failedRequests.push({ status: r.status(), path: new URL(r.url()).pathname }) })
    await page.goto(base + '/admin/after-sales')
    await page.getByText('售后队列', { exact: true }).waitFor()
    const create = page.locator('button').filter({ hasText: '新建售后' })
    assert.equal(await create.isDisabled(), eligible.length === 0)
    if (eligible.length) {
      await create.click()
      const modal = page.getByRole('dialog', { name: '新建售后记录' })
      await modal.waitFor()
      assert(await modal.getByText('该订单尚未完成最终审核，请先通过完单审核流程处理；正式结算后发生的问题再进入售后。', { exact: true }).isVisible())
      await modal.getByRole('combobox').click()
      for (const o of orders.filter(o => !eligible.includes(o))) {
        assert.equal(await page.locator('.ant-select-item-option').filter({ hasText: o.orderNo }).count(), 0, '不可选订单出现：' + o.orderNo)
      }
      const first = eligible[0]
      await modal.getByRole('combobox').fill(first.orderNo)
      await page.locator('.ant-select-item-option').filter({ hasText: first.orderNo }).first().waitFor()
      // Selectors and hints only: never submit the create form on the public database.
    }
    await page.screenshot({ animations: 'disabled', path: `output/after-sale-lifecycle-20260908/${live ? 'public' : 'isolated'}-${width}.png` })
    report.checked.push({ width, eligibleCount: eligible.length, unfinishedOrdersExcluded: true })
    await context.close()
  }
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.failedRequests, [])
  console.log(JSON.stringify(report))
} finally {
  fs.writeFileSync(`output/after-sale-lifecycle-20260908/${live ? 'public' : 'isolated'}-browser.json`, JSON.stringify(report, null, 2))
  await browser.close()
  await db.$disconnect()
}

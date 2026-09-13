import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db, env } from './admin-reminders-local.mjs'
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const p = db(), ids = [], password = randomBytes(24).toString('base64url'), marker = 'dispatch_ui_' + randomBytes(4).toString('hex')
const { chromium } = createRequire(path.join(process.env.APPDATA, 'npm', 'package.json'))('playwright')
const browser = await chromium.launch({ headless: true })
try {
  const hash = await bcrypt.hash(password, 10)
  for (const role of (process.argv.includes('--mobile') ? ['DISPATCHER'] : ['SUPER_ADMIN', 'STORE_MANAGER', 'FINANCE', 'DISPATCHER'])) {
    const user = await p.user.create({ data: { username: marker + '_' + role, passwordHash: hash, role } }); ids.push(user.id)
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'America/Los_Angeles' }); const page = await context.newPage()
    await page.goto('http://127.0.0.1:8280/admin/login'); await page.getByLabel('账号', { exact: true }).fill(user.username); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '进入管理后台' }).click()
    await page.waitForURL('**/admin/' + (role === 'FINANCE' ? 'finance' : role === 'DISPATCHER' ? 'orders' : 'dashboard'))
    if (role === 'FINANCE') { await page.getByRole('heading', { name: '财务中心', exact: true }).waitFor(); assert.equal(await page.getByRole('menuitem').count(), 1) }
    else if (role === 'DISPATCHER') { await page.getByText('我的派单统计', { exact: true }).waitFor(); assert.equal(await page.getByRole('menuitem').count(), 2); await page.setViewportSize({width:390,height:844}); await page.waitForFunction(() => document.querySelector('.admin-sider').getBoundingClientRect().width < 2); await page.screenshot({path:'output/playwright/dispatch-statistics/personal-mobile-viewport.png',fullPage:false}); assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); await page.locator('.ant-layout-sider-zero-width-trigger').click(); await page.getByRole('menuitem', {name:'售后管理'}).click(); await page.getByRole('heading', {name:'售后管理',exact:true}).waitFor() }
    else {
      await page.getByRole('menuitem', { name: '经营统计' }).click(); await page.getByText('派单统计', { exact: true }).waitFor()
      await page.locator('.ant-table-tbody button.ant-btn-link').first().click(); await page.getByRole('dialog').waitFor(); await page.getByRole('dialog').locator('button.ant-modal-close').click()
      fs.mkdirSync('output/playwright/dispatch-statistics', { recursive: true }); await page.screenshot({ path: `output/playwright/dispatch-statistics/all-${role}.png`, fullPage: true })
      await page.getByRole('menuitem', { name: '账号权限' }).click(); await page.getByRole('button', { name: '角色权限配置', exact: true }).click()
      await page.getByRole('tab', { name: '客服', exact: true }).waitFor(); assert.equal(await page.getByRole('tab', { name: '店长', exact: true }).count(), role === 'SUPER_ADMIN' ? 1 : 0)
      await page.getByRole('tab', { name: '客服', exact: true }).click()
      for (const label of ['创建订单', '完单审核', '创建售后', '查看我的派单统计']) assert(await page.getByRole('checkbox', { name: label, exact: true }).isChecked())
      assert(await page.getByRole('checkbox', { name: '查看全员派单统计（管理层专属）', exact: true }).isDisabled())
      await page.screenshot({ path: `output/playwright/dispatch-statistics/checkbox-${role}.png`, fullPage: true })
    }
    await context.close()
  }
  console.log(JSON.stringify({ result: 'PASS', checks: process.argv.includes('--mobile') ? ['390px layout fits; mobile navigation opens and reaches authorized after-sales page'] : ['Super/manager global statistics and detail dialog', 'Checkbox role scope, defaults and immutable lower-role ceiling', 'Finance lands on finance only', 'Dispatcher lands on orders with own statistics'], productionTouched: false }))
} finally { await browser.close(); await p.operationLog.deleteMany({ where: { operatorId: { in: ids } } }); await p.user.deleteMany({ where: { id: { in: ids } } }); await p.$disconnect() }

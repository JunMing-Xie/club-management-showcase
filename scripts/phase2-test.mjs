import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'

const baseUrl = process.env.BASE_URL ?? 'http://localhost:4000/api'
const prisma = new PrismaClient()
const created = { orders: [], customers: [], tiers: [], activities: [], users: [], settlements: [] }

const request = async (path, { token, method = 'GET', body, expectedStatus } = {}) => {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }
  const response = await fetch(baseUrl + path, { method, headers, body })
  const text = await response.text()
  const data = text ? (response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null
  if (expectedStatus === undefined) assert.equal(response.ok, true, method + ' ' + path + ' failed: ' + response.status + ' ' + text)
  else assert.equal(response.status, expectedStatus, method + ' ' + path + ' expected ' + expectedStatus + ', got ' + text)
  return data
}
const login = async (username, password) => request('/auth/login', { method: 'POST', body: { username, password } })
const cents = (value) => Math.round(value * 100)
const main = async () => {
  const marker = String(Date.now()).slice(-8)
  let adminToken
  let linToken
  let chenToken
  let lin
  let chen
  let originalLinState
  let originalChenState
  let originalFundingPolicy
  try {
    const admin = await login('admin', 'Demo-Local-Only!2026')
    const linLogin = await login('lin', 'Demo-Local-Only!2026')
    const chenLogin = await login('chen', 'Demo-Local-Only!2026')
    adminToken = admin.token
    linToken = linLogin.token
    chenToken = chenLogin.token
    const fundingSetting = await request('/settings/funding-policy', { token: adminToken })
    originalFundingPolicy = fundingSetting.item.policy
    const options = await request('/staff/options', { token: adminToken })
    lin = options.items.find((item) => item.name === '阿凯')
    chen = options.items.find((item) => item.name === '小宇')
    assert.ok(lin && chen, 'seed staff should exist')
    originalLinState = await prisma.staffProfile.findUnique({ where: { id: lin.id }, select: { status: true, accepting: true, accountStatus: true, presence: true, tierId: true } })
    originalChenState = await prisma.staffProfile.findUnique({ where: { id: chen.id }, select: { status: true, accepting: true, accountStatus: true, presence: true, tierId: true } })

    const customer = await request('/customers', { token: adminToken, method: 'POST', body: { name: '二阶段客户' + marker, phone: '138' + marker + '01' } })
    created.customers.push(customer.item.id)
    await request('/customers/' + customer.item.id + '/recharges', { token: adminToken, method: 'POST', body: { amount: 1000, bonusAmount: 0, note: '二阶段本金测试' } })
    const order = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: customer.item.id, serviceItem: '英雄联盟赛事护航', amountCents: cents(328), staffAmountCents: cents(98.4), staffId: lin.id } })
    created.orders.push(order.item.id)
    await request('/orders/' + order.item.id + '/start', { token: linToken, method: 'POST' })
    const completed = await request('/orders/' + order.item.id + '/complete', { token: linToken, method: 'POST' })
    assert.equal(completed.item.status, 'COMPLETED')
    const duplicate = await request('/orders/' + order.item.id + '/complete', { token: linToken, method: 'POST' })
    assert.equal(duplicate.idempotent, true)
    const after = await request('/customers/' + customer.item.id, { token: adminToken })
    assert.equal(after.item.principalBalanceCents, cents(672))
    assert.equal(after.item.bonusBalanceCents, 0)
    assert.equal(after.item.balanceCents, cents(672))
    assert.equal(after.item.orderConsumptions.length, 1)
    assert.equal(after.item.consumptionRecords.length, 1)
    const orderConsumptionCount = await prisma.orderConsumption.count({ where: { orderId: order.item.id } })
    assert.equal(orderConsumptionCount, 1)

    const bonusCustomer = await request('/customers', { token: adminToken, method: 'POST', body: { name: '赠金客户' + marker, phone: '138' + marker + '02' } })
    created.customers.push(bonusCustomer.item.id)
    await request('/customers/' + bonusCustomer.item.id + '/recharges', { token: adminToken, method: 'POST', body: { amount: 1000, bonusAmount: 100, note: '赠金测试' } })
    await request('/settings/funding-policy', { token: adminToken, method: 'PATCH', body: { policy: 'BONUS_FIRST' } })
    await request('/customers/' + bonusCustomer.item.id + '/funding-policy', { token: adminToken, method: 'PATCH', body: { policy: 'PRINCIPAL_FIRST' }, expectedStatus: 409 })
    const bonusOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: bonusCustomer.item.id, serviceItem: '无畏契约赛事保障', amountCents: cents(328), staffId: lin.id } })
    created.orders.push(bonusOrder.item.id)
    await request('/orders/' + bonusOrder.item.id + '/start', { token: linToken, method: 'POST' })
    await request('/orders/' + bonusOrder.item.id + '/complete', { token: linToken, method: 'POST' })
    const bonusAfter = await request('/customers/' + bonusCustomer.item.id, { token: adminToken })
    assert.equal(bonusAfter.item.principalBalanceCents, cents(772))
    assert.equal(bonusAfter.item.bonusBalanceCents, 0)
    assert.equal(bonusAfter.item.balanceCents, cents(772))

    const poorCustomer = await request('/customers', { token: adminToken, method: 'POST', body: { name: '余额不足客户' + marker, phone: '138' + marker + '03' } })
    created.customers.push(poorCustomer.item.id)
    await request('/customers/' + poorCustomer.item.id + '/recharges', { token: adminToken, method: 'POST', body: { amount: 100 } })
    const poorOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: poorCustomer.item.id, serviceItem: '绝地求生赛事护航', amountCents: cents(200), staffId: lin.id } })
    created.orders.push(poorOrder.item.id)
    await request('/orders/' + poorOrder.item.id + '/start', { token: linToken, method: 'POST' })
    await request('/orders/' + poorOrder.item.id + '/complete', { token: linToken, method: 'POST', expectedStatus: 409 })
    const poorState = await request('/orders/' + poorOrder.item.id, { token: adminToken })
    assert.equal(poorState.item.status, 'IN_PROGRESS')
    const poorCustomerAfter = await request('/customers/' + poorCustomer.item.id, { token: adminToken })
    assert.equal(poorCustomerAfter.item.balanceCents, cents(100))
    assert.equal(poorCustomerAfter.item.orderConsumptions.length, 0)

    const raceCustomer = await request('/customers', { token: adminToken, method: 'POST', body: { name: '抢单竞争客户' + marker, phone: '138' + marker + '04' } })
    created.customers.push(raceCustomer.item.id)
    const raceOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: raceCustomer.item.id, serviceItem: '王者荣耀赛事护航', amountCents: cents(1) } })
    created.orders.push(raceOrder.item.id)
    const raceResponses = await Promise.all([
      request('/orders/' + raceOrder.item.id + '/claim', { token: linToken, method: 'POST' }).then(() => 'lin:ok').catch((error) => 'lin:error:' + error.message),
      request('/orders/' + raceOrder.item.id + '/claim', { token: chenToken, method: 'POST' }).then(() => 'chen:ok').catch((error) => 'chen:error:' + error.message),
    ])
    assert.equal(raceResponses.filter((item) => item.endsWith(':ok')).length, 1)
    assert.equal(raceResponses.filter((item) => item.includes(':error:')).length, 1)
    const raceSaved = await request('/orders/' + raceOrder.item.id, { token: adminToken })
    assert.ok(raceSaved.item.staff?.id === lin.id || raceSaved.item.staff?.id === chen.id)
    assert.equal(raceSaved.item.status, 'PENDING')

    const lockOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: raceCustomer.item.id, serviceItem: '锁单测试', amountCents: cents(1) } })
    created.orders.push(lockOrder.item.id)
    await request('/orders/' + lockOrder.item.id + '/lock', { token: adminToken, method: 'POST' })
    await request('/orders/' + lockOrder.item.id + '/claim', { token: linToken, method: 'POST', expectedStatus: 409 })
    await request('/orders/' + lockOrder.item.id + '/unlock', { token: adminToken, method: 'POST' })
    await request('/orders/' + lockOrder.item.id + '/claim', { token: linToken, method: 'POST' })

    const baseTier = options.items.find((item) => item.tier)?.tier
    const blockedTier = await request('/staff-tiers', { token: adminToken, method: 'POST', body: { name: '暂不接单层级', level: 99, canAcceptOrders: false } })
    created.tiers.push(blockedTier.item.id)
    await request('/staff/' + lin.id, { token: adminToken, method: 'PATCH', body: { tierId: blockedTier.item.id } })
    const tierOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: raceCustomer.item.id, serviceItem: '层级限制测试', amountCents: cents(1), requiredTierId: blockedTier.item.id } })
    created.orders.push(tierOrder.item.id)
    await request('/orders/' + tierOrder.item.id + '/claim', { token: linToken, method: 'POST', expectedStatus: 409 })
    await request('/staff/' + lin.id, { token: adminToken, method: 'PATCH', body: { tierId: baseTier?.id ?? 'phase2-tier-base' } })
    await request('/staff/me/accepting', { token: linToken, method: 'PATCH', body: { accepting: 'PAUSED' } })
    const pausedOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: raceCustomer.item.id, serviceItem: '暂停接单测试', amountCents: cents(1) } })
    created.orders.push(pausedOrder.item.id)
    await request('/orders/' + pausedOrder.item.id + '/claim', { token: linToken, method: 'POST', expectedStatus: 409 })
    await request('/staff/me/accepting', { token: linToken, method: 'PATCH', body: { accepting: 'ACCEPTING' } })
    await request('/staff/' + lin.id, { token: adminToken, method: 'PATCH', body: { accountStatus: 'FROZEN' } })
    const frozenOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: raceCustomer.item.id, serviceItem: '冻结账号测试', amountCents: cents(1) } })
    created.orders.push(frozenOrder.item.id)
    await request('/orders/' + frozenOrder.item.id + '/claim', { token: linToken, method: 'POST', expectedStatus: 403 })
    await request('/staff/' + lin.id, { token: adminToken, method: 'PATCH', body: { accountStatus: 'NORMAL' } })

    const activity = await request('/recharge-activities', { token: adminToken, method: 'POST', body: { name: '二阶段充值活动', startAt: new Date(Date.now() - 3600000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString(), tiers: [{ thresholdCents: 1000, bonusCents: 88 }] } })
    created.activities.push(activity.item.id)
    const activityCustomer = await request('/customers', { token: adminToken, method: 'POST', body: { name: '活动客户' + marker, phone: '138' + marker + '05' } })
    created.customers.push(activityCustomer.item.id)
    const activityRecharge = await request('/customers/' + activityCustomer.item.id + '/recharges', { token: adminToken, method: 'POST', body: { amount: 10 } })
    assert.equal(activityRecharge.bonusCents, 88)
    const activityState = await request('/customers/' + activityCustomer.item.id, { token: adminToken })
    assert.equal(activityState.item.bonusBalanceCents, 88)

    const expiredActivity = await request('/recharge-activities', { token: adminToken, method: 'POST', body: { name: '已过期充值活动', startAt: new Date(Date.now() - 7200000).toISOString(), endAt: new Date(Date.now() - 3600000).toISOString(), tiers: [{ thresholdCents: 100, bonusCents: 999 }] } })
    created.activities.push(expiredActivity.item.id)
    const expiredCustomer = await request('/customers', { token: adminToken, method: 'POST', body: { name: '过期活动客户' + marker, phone: '138' + marker + '06' } })
    created.customers.push(expiredCustomer.item.id)
    const expiredRecharge = await request('/customers/' + expiredCustomer.item.id + '/recharges', { token: adminToken, method: 'POST', body: { amount: 1 } })
    assert.equal(expiredRecharge.bonusCents, 0)

    const afterSaleOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: customer.item.id, serviceItem: '售后流程测试', amountCents: cents(1), staffId: chen.id } })
    created.orders.push(afterSaleOrder.item.id)
    await request('/orders/' + afterSaleOrder.item.id + '/start', { token: chenToken, method: 'POST' })
    await request('/orders/' + afterSaleOrder.item.id + '/complete', { token: chenToken, method: 'POST' })
    const afterSale = await request('/after-sales', { token: adminToken, method: 'POST', body: { orderId: afterSaleOrder.item.id, issueType: '服务补偿', description: '二阶段售后测试' } })
    await request('/after-sales/' + afterSale.item.id, { token: adminToken, method: 'PATCH', body: { status: 'COMPLETED', resultType: 'COMPENSATION', compensationAmount: 2, handlingNote: '已线下沟通' } })
    await request('/after-sales/' + afterSale.item.id + '/messages', { token: chenToken, method: 'POST', body: { content: '已补充处理说明' } })
    const afterSaleState = await request('/after-sales', { token: adminToken })
    assert.ok(afterSaleState.items.some((item) => item.id === afterSale.item.id && item.status === 'COMPLETED'))
    const finance = await request('/finance/overview', { token: adminToken })
    assert.equal(finance.item.settlementMode, '线下人工结算')
    assert.equal(finance.item.pendingStaffEarningsCents, finance.item.staffEarningsCents)
    const settlement = await request('/staff/' + lin.id + '/settlements', { token: adminToken, method: 'POST', body: { amount: 0.01, settlementMethod: '线下转账', note: '二阶段结算闭环测试' } })
    created.settlements.push(settlement.item.id)
    const financeAfterSettlement = await request('/finance/overview', { token: adminToken })
    assert.equal(financeAfterSettlement.item.pendingStaffEarningsCents, financeAfterSettlement.item.staffEarningsCents - 1)

    const csUser = await request('/admin/users', { token: adminToken, method: 'POST', body: { username: 'phase2cs' + marker, password: 'Demo-Local-Only!2026', role: 'CUSTOMER_SERVICE' } })
    created.users.push(csUser.item.id)
    const csLogin = await login('phase2cs' + marker, 'Demo-Local-Only!2026')
    await request('/staff', { token: csLogin.token, expectedStatus: 403 })
    await request('/customers', { token: csLogin.token })

    console.log(JSON.stringify({ ok: true, dualAccount: true, idempotentCompletion: true, claimRace: true, roleIsolation: true, afterSale: true, rechargeActivity: true }, null, 2))
  } finally {
    const orderIds = created.orders
    if (orderIds.length) {
      await prisma.afterSaleMessage.deleteMany({ where: { case: { orderId: { in: orderIds } } } })
      await prisma.fundTransaction.deleteMany({ where: { afterSaleCase: { orderId: { in: orderIds } } } })
      await prisma.fundTransaction.deleteMany({ where: { orderId: { in: orderIds } } })
      await prisma.orderConsumption.deleteMany({ where: { orderId: { in: orderIds } } })
      await prisma.consumptionRecord.deleteMany({ where: { orderId: { in: orderIds } } })
      await prisma.afterSaleCase.deleteMany({ where: { orderId: { in: orderIds } } })
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
    }
    if (created.customers.length) {
      await prisma.fundTransaction.deleteMany({ where: { customerId: { in: created.customers } } })
      await prisma.customer.deleteMany({ where: { id: { in: created.customers } } })
    }
    if (created.tiers.length) await prisma.staffTier.deleteMany({ where: { id: { in: created.tiers } } })
    if (created.activities.length) await prisma.rechargeActivity.deleteMany({ where: { id: { in: created.activities } } })
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } })
    if (lin && originalLinState) await prisma.staffProfile.update({ where: { id: lin.id }, data: originalLinState })
    if (chen && originalChenState) await prisma.staffProfile.update({ where: { id: chen.id }, data: originalChenState })
    if (created.settlements.length) await prisma.settlementRecord.deleteMany({ where: { id: { in: created.settlements } } })
    if (adminToken && originalFundingPolicy) await request('/settings/funding-policy', { token: adminToken, method: 'PATCH', body: { policy: originalFundingPolicy } }).catch(() => {})
    await prisma.operationLog.deleteMany({ where: { detail: { path: ['marker'], equals: marker } } }).catch(() => {})
    await prisma.$disconnect()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })

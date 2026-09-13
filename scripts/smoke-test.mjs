import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { io } from 'socket.io-client'
import { PrismaClient } from '@prisma/client'

const baseUrl = process.env.BASE_URL ?? 'http://localhost:4000/api'

const request = async (path, { token, method = 'GET', body, formData, expectedStatus } = {}) => {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: formData ?? body })
  const text = await response.text()
  const data = text ? (response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null
  if (expectedStatus === undefined) assert.equal(response.ok, true, `${method} ${path} failed: ${response.status} ${text}`)
  else assert.equal(response.status, expectedStatus, `${method} ${path} expected ${expectedStatus}, got ${response.status}: ${text}`)
  return data
}

const requestBuffer = async (path, { token } = {}) => {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${baseUrl}${path}`, { headers })
  const buffer = Buffer.from(await response.arrayBuffer())
  assert.equal(response.ok, true, `GET ${path} failed: ${response.status}`)
  return buffer
}

const login = async (username, password) => request('/auth/login', { method: 'POST', body: { username, password } })

const main = async () => {
  const prisma = new PrismaClient()
  const testStartedAt = new Date()
  let adminSocket
  let testCustomerId
  let testOrderId
  let chenOrderId
  let insufficientOrderId
  let linStaffId
  let chenStaffId
  let originalLinStatus
  let originalChenStatus
  let realtimeEvents = 0
  const marker = Date.now().toString().slice(-8)
  const importedPhones = [`137${marker}`, `136${marker}`, `135${marker}`]
  const localDateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

  try {
    await request('/auth/login', { method: 'POST', body: { username: 'not-found', password: 'wrong-password' }, expectedStatus: 401 })
    await request('/auth/me', { token: 'invalid-token', expectedStatus: 401 })
    const adminLogin = await login('admin', 'Demo-Local-Only!2026')
    const linLogin = await login('lin', 'Demo-Local-Only!2026')
    const chenLogin = await login('chen', 'Demo-Local-Only!2026')
    const adminToken = adminLogin.token
    const linToken = linLogin.token
    const chenToken = chenLogin.token

    adminSocket = io('http://localhost:4000', { auth: { token: adminToken }, transports: ['websocket'] })
    adminSocket.on('data:changed', () => { realtimeEvents += 1 })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket.IO connection timeout')), 5000)
      adminSocket.once('connect', () => { clearTimeout(timer); resolve() })
      adminSocket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
    })

    const staffOptions = await request('/staff/options', { token: adminToken })
    const lin = staffOptions.items.find((item) => item.name === '阿凯')
    const chen = staffOptions.items.find((item) => item.name === '小宇')
    assert.ok(lin && chen, 'seed staff should exist')
    linStaffId = lin.id
    chenStaffId = chen.id
    originalLinStatus = lin.status
    originalChenStatus = chen.status

    const customer = await request('/customers', { token: adminToken, method: 'POST', body: { name: `流程客户${marker}`, phone: `139${marker}`, note: '核心链路测试' } })
    testCustomerId = customer.item.id
    await request(`/customers/${testCustomerId}/recharges`, { token: adminToken, method: 'POST', body: { amount: 200, note: '余额扣款测试' } })
    await request('/orders', { token: adminToken, method: 'POST', body: { customerId: testCustomerId, serviceItem: '', amountCents: -1 }, expectedStatus: 400 })
    const beforeStats = await request('/stats', { token: adminToken })
    const beforeOverview = await request('/stats/overview', { token: adminToken })
    const beforeWorkbench = await request('/workbench/summary', { token: linToken })
    const financeDate = localDateKey()
    const financeRangeQuery = `?startDate=${financeDate}&endDate=${financeDate}`
    const financeBefore = await request('/finance/overview', { token: adminToken })
    const financeRangeBefore = await request('/finance/overview' + financeRangeQuery, { token: adminToken })
    const order = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: testCustomerId, serviceItem: '流程服务', amountCents: 12345, staffAmountCents: 3704, staffId: lin.id, note: '核心链路测试' } })
    testOrderId = order.item.id
    assert.equal(order.item.status, 'PENDING')

    const pendingStats = await request('/stats', { token: adminToken })
    const pendingWorkbench = await request('/workbench/summary', { token: linToken })
    assert.equal(pendingStats.item.staffEarningsCents, beforeStats.item.staffEarningsCents, 'pending order should remain estimated and not enter actual staff earnings')
    assert.equal(pendingWorkbench.todayEarningsCents, beforeWorkbench.todayEarningsCents, 'pending order should not enter staff actual earnings')

    const linOrders = await request(`/orders?search=${encodeURIComponent(order.item.orderNo)}`, { token: linToken })
    assert.equal(linOrders.items.length, 1, 'assigned staff should see own order')
    const started = await request(`/orders/${testOrderId}/start`, { token: linToken, method: 'POST' })
    assert.equal(started.item.status, 'IN_PROGRESS')
    const inProgressStats = await request('/stats', { token: adminToken })
    assert.equal(inProgressStats.item.staffEarningsCents, beforeStats.item.staffEarningsCents, 'in-progress order should remain estimated and not enter actual staff earnings')
    const adminDuring = await request(`/orders/${testOrderId}`, { token: adminToken })
    assert.equal(adminDuring.item.status, 'IN_PROGRESS', 'admin should see staff status updates')
    const completed = await request(`/orders/${testOrderId}/complete`, { token: linToken, method: 'POST' })
    assert.equal(completed.item.status, 'COMPLETED')
    const adminAfter = await request(`/orders/${testOrderId}`, { token: adminToken })
    assert.equal(adminAfter.item.status, 'COMPLETED', 'admin should see completion updates')
    const afterStats = await request('/stats', { token: adminToken })
    assert.ok(afterStats.item.revenueCents >= beforeStats.item.revenueCents + 12345, 'revenue should include completed order')
    assert.equal(afterStats.item.staffEarningsCents, beforeStats.item.staffEarningsCents + 3704, 'completed order should enter actual staff earnings')
    const afterOverview = await request('/stats/overview', { token: adminToken })
    assert.equal(afterOverview.today.staffEarningsCents, beforeOverview.today.staffEarningsCents + 3704, 'today actual staff earnings should include completed order only')
    assert.equal(afterOverview.month.staffEarningsCents, beforeOverview.month.staffEarningsCents + 3704, 'month actual staff earnings should include completed order only')
    const afterWorkbench = await request('/workbench/summary', { token: linToken })
    assert.equal(afterWorkbench.todayEarningsCents, beforeWorkbench.todayEarningsCents + 3704, 'staff today actual earnings should update after completion')
    assert.equal(afterWorkbench.monthEarningsCents, beforeWorkbench.monthEarningsCents + 3704, 'staff month actual earnings should update after completion')

    const financeAfter = await request('/finance/overview', { token: adminToken })
    const financeRangeAfter = await request('/finance/overview' + financeRangeQuery, { token: adminToken })
    assert.deepEqual((await request('/finance/overview', { token: adminToken })).item, financeAfter.item, 'finance without range should remain stable')
    assert.equal(financeRangeAfter.item.completedOrderCount, financeRangeBefore.item.completedOrderCount + 1, 'date range should include the completed order count')
    assert.equal(financeRangeAfter.item.revenueCents, financeRangeBefore.item.revenueCents + 12345, 'date range should include completed order revenue')
    assert.equal(financeRangeAfter.item.staffEarningsCents, financeRangeBefore.item.staffEarningsCents + 3704, 'date range should include completed staff earnings')
    assert.equal(financeRangeAfter.item.consumptionCents, financeRangeBefore.item.consumptionCents + 12345, 'date range should include the completion consumption')
    assert.equal(financeAfter.item.revenueCents, financeBefore.item.revenueCents + 12345, 'default finance revenue should include completed order')
    const emptyFinanceRange = await request('/finance/overview?startDate=2099-01-01&endDate=2099-01-31', { token: adminToken })
    for (const key of ['completedOrderCount', 'revenueCents', 'staffEarningsCents', 'afterSaleExpenseCents', 'totalExpenseCents', 'profitCents', 'pendingStaffEarningsCents', 'principalRechargeCents', 'bonusRechargeCents', 'consumptionCents']) assert.equal(emptyFinanceRange.item[key], 0, `empty finance range should return zero for ${key}`)
    const emptySettlements = await request('/finance/settlements?startDate=2099-01-01&endDate=2099-01-31', { token: adminToken })
    assert.equal(emptySettlements.items.length, 0, 'empty finance range should return no settlements')
    const invalidFinanceRange = await request('/finance/overview?startDate=2099-01-02&endDate=2099-01-01', { token: adminToken, expectedStatus: 400 })
    assert.match(invalidFinanceRange.message, /开始日期不能晚于结束日期/, 'reverse date range should return a clear business validation message')
    const rangedExport = await requestBuffer('/finance/export?startDate=2099-01-01&endDate=2099-01-31', { token: adminToken })
    const exportWorkbook = new ExcelJS.Workbook()
    await exportWorkbook.xlsx.load(rangedExport)
    const exportSummary = exportWorkbook.getWorksheet('经营摘要')
    assert.ok(exportSummary, 'finance export should contain the summary sheet')
    assert.equal(String(exportSummary.getCell('B2').value), '0.00', 'finance export should follow the selected empty range')

    const customerAfterCompletion = await request(`/customers/${testCustomerId}`, { token: adminToken })
    assert.equal(customerAfterCompletion.item.balanceCents, 20000 - 12345, 'completed order should deduct customer balance once')
    assert.equal(customerAfterCompletion.item.totalConsumptionCents, 12345, 'customer consumption total should include completed order')
    assert.equal(customerAfterCompletion.item.consumptionRecords.length, 1, 'completed order should create one consumption record')
    assert.equal(customerAfterCompletion.item.consumptionRecords[0].order.orderNo, order.item.orderNo)
    const duplicateCompletion = await request(`/orders/${testOrderId}/complete`, { token: linToken, method: 'POST' })
    assert.equal(duplicateCompletion.idempotent, true, 'repeated completion should be idempotent')
    const customerAfterDuplicate = await request(`/customers/${testCustomerId}`, { token: adminToken })
    assert.equal(customerAfterDuplicate.item.balanceCents, 20000 - 12345, 'repeated completion must not deduct twice')
    assert.equal(customerAfterDuplicate.item.consumptionRecords.length, 1, 'repeated completion must not create a second consumption record')

    await request('/staff', { token: linToken, expectedStatus: 403 })
    await request(`/orders/${testOrderId}`, { token: linToken, method: 'PATCH', body: { amountCents: 999999 }, expectedStatus: 403 })

    const chenOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: testCustomerId, serviceItem: '隔离服务', amountCents: 8800, staffId: chen.id } })
    chenOrderId = chenOrder.item.id
    const forbiddenOrderList = await request(`/orders?search=${encodeURIComponent(chenOrder.item.orderNo)}`, { token: linToken })
    assert.equal(forbiddenOrderList.items.length, 0, 'staff should not see another staff member order')
    await request(`/orders/${chenOrder.item.id}`, { token: linToken, expectedStatus: 404 })
    await request(`/orders/${chenOrder.item.id}`, { token: chenToken })

    const insufficientOrder = await request('/orders', { token: adminToken, method: 'POST', body: { customerId: testCustomerId, serviceItem: '余额不足测试', amountCents: 9000, staffAmountCents: 2700, staffId: lin.id } })
    insufficientOrderId = insufficientOrder.item.id
    await request(`/orders/${insufficientOrderId}/start`, { token: linToken, method: 'POST' })
    await request(`/orders/${insufficientOrderId}/complete`, { token: linToken, method: 'POST', expectedStatus: 409 })
    const insufficientOrderAfter = await request(`/orders/${insufficientOrderId}`, { token: adminToken })
    assert.equal(insufficientOrderAfter.item.status, 'IN_PROGRESS', '余额不足时订单不能标记为已完成')
    const customerAfterInsufficient = await request(`/customers/${testCustomerId}`, { token: adminToken })
    assert.equal(customerAfterInsufficient.item.balanceCents, 20000 - 12345, '余额不足时客户余额不能变化')
    assert.equal(customerAfterInsufficient.item.consumptionRecords.length, 1, '余额不足时不能生成消费流水')

    const customerBeforeRecharge = await request(`/customers/${testCustomerId}`, { token: adminToken })
    await request(`/customers/${testCustomerId}/recharges`, { token: adminToken, method: 'POST', body: { amount: 20, note: '线下收款测试' } })
    const customerAfterRecharge = await request(`/customers/${testCustomerId}`, { token: adminToken })
    assert.equal(customerAfterRecharge.item.balanceCents, customerBeforeRecharge.item.balanceCents + 2000, 'recharge should increment balance by cents')
    assert.equal(customerAfterRecharge.item.rechargeRecords[0].amountCents, 2000)
    const rechargeLog = await prisma.operationLog.findFirst({ where: { action: 'RECHARGE', entityId: testCustomerId } })
    assert.ok(rechargeLog, 'recharge should create an operation log')

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('客户导入')
    sheet.columns = [{ header: '客户姓名', key: 'name' }, { header: '联系电话', key: 'phone' }, { header: '备注', key: 'note' }]
    sheet.addRows([
      { name: `导入客户甲${marker}`, phone: importedPhones[0], note: '批量导入验收' },
      { name: `导入客户乙${marker}`, phone: importedPhones[1], note: '批量导入验收' },
      { name: '', phone: importedPhones[2], note: '错误数据' },
    ])
    const excel = await workbook.xlsx.writeBuffer()
    const formData = new FormData()
    formData.append('type', 'customers')
    formData.append('file', new Blob([excel]), 'smoke-customers.xlsx')
    const importResult = await request('/imports', { token: adminToken, method: 'POST', formData })
    assert.equal(importResult.successCount, 2)
    assert.equal(importResult.failureCount, 1)
    assert.equal(importResult.errors[0].row, 4)
    const invalidFormData = new FormData()
    invalidFormData.append('type', 'customers')
    invalidFormData.append('file', new Blob(['not an xlsx file']), 'invalid.xlsx')
    await request('/imports', { token: adminToken, method: 'POST', formData: invalidFormData, expectedStatus: 400 })

    const workbench = await request('/workbench/summary', { token: linToken })
    assert.ok(workbench.todayCompletedCount >= 1, 'staff summary should count completed order')
    assert.ok(realtimeEvents >= 3, 'admin should receive realtime data change events')

    console.log(JSON.stringify({
      ok: true,
      orderNo: order.item.orderNo,
      statusFlow: ['PENDING', 'IN_PROGRESS', 'COMPLETED'],
      staffIsolation: true,
      staffCannotEditAmount: true,
      realtimeEvents,
      rechargeBalanceCents: customerAfterRecharge.item.balanceCents,
      excel: { success: importResult.successCount, failure: importResult.failureCount, failedRow: importResult.errors[0].row },
    }, null, 2))
  } finally {
    if (adminSocket) adminSocket.disconnect()
    const orderIds = [testOrderId, chenOrderId, insufficientOrderId].filter(Boolean)
    if (orderIds.length > 0) await prisma.orderConsumption.deleteMany({ where: { orderId: { in: orderIds } } })
    if (orderIds.length > 0) await prisma.fundTransaction.deleteMany({ where: { orderId: { in: orderIds } } })
    if (orderIds.length > 0) await prisma.consumptionRecord.deleteMany({ where: { orderId: { in: orderIds } } })
    if (testCustomerId) await prisma.fundTransaction.deleteMany({ where: { customerId: testCustomerId } })
    if (orderIds.length > 0) await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
    if (testCustomerId) await prisma.customer.deleteMany({ where: { id: testCustomerId } })
    await prisma.customer.deleteMany({ where: { phone: { in: importedPhones } } })
    await prisma.operationLog.deleteMany({ where: { createdAt: { gte: testStartedAt } } })
    if (originalLinStatus && linStaffId) await prisma.staffProfile.update({ where: { id: linStaffId }, data: { status: originalLinStatus } })
    if (originalChenStatus && chenStaffId) await prisma.staffProfile.update({ where: { id: chenStaffId }, data: { status: originalChenStatus } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

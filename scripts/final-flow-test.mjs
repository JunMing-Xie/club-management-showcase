import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { PrismaClient } from '@prisma/client'
import { io } from 'socket.io-client'

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4000/api'
const socketUrl = baseUrl.replace(/\/api\/?$/, '')
const adminPassword = process.env.TEST_ADMIN_PASSWORD ?? 'Demo-Local-Only!2026'
const staffPassword = process.env.TEST_STAFF_PASSWORD ?? 'Demo-Local-Only!2026'
const prisma = new PrismaClient()
const created = { orders: [], customers: [], users: [], activities: [], coupons: [], proofs: [] }
const testStartedAt = new Date()
const marker = String(Date.now()).slice(-8)
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

const requestResult = async (apiPath, { token, method = 'GET', body, formData } = {}) => {
  const headers = {}
  let payload = formData
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await fetch(`${baseUrl}${apiPath}`, { method, headers, body: payload })
  const text = await response.text()
  const data = text ? (response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null
  return { status: response.status, ok: response.ok, data, headers: response.headers }
}

const request = async (apiPath, options = {}) => {
  const result = await requestResult(apiPath, options)
  const expected = options.expectedStatus
  if (expected === undefined) assert.equal(result.ok, true, `${options.method ?? 'GET'} ${apiPath} failed: ${result.status} ${JSON.stringify(result.data)}`)
  else assert.equal(result.status, expected, `${options.method ?? 'GET'} ${apiPath} expected ${expected}, got ${result.status}: ${JSON.stringify(result.data)}`)
  return result.data
}

const requestBuffer = async (apiPath, { token } = {}) => {
  const response = await fetch(`${baseUrl}${apiPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  const buffer = Buffer.from(await response.arrayBuffer())
  assert.equal(response.ok, true, `GET ${apiPath} failed: ${response.status}`)
  return { buffer, contentType: response.headers.get('content-type') ?? '' }
}

const login = (username, password) => request('/auth/login', { method: 'POST', body: { username, password } })
const proofForm = (note, name = 'proof.png') => {
  const data = new FormData()
  data.append('note', note)
  data.append('proofs', new Blob([tinyPng], { type: 'image/png' }), name)
  return data
}

const invalidProofForm = () => {
  const data = new FormData()
  data.append('note', '伪造图片内容测试')
  data.append('proofs', new Blob(['not-a-real-png'], { type: 'image/png' }), 'invalid.png')
  return data
}
const findCurrentAssignment = (order, staffId) => order.assignments.find((item) => item.staffId === staffId && ['CLAIMED', 'ACTIVE', 'EXIT_REQUESTED', 'COMPLETED'].includes(item.assignmentStatus))

const main = async () => {
  let adminSocket
  let realtimeEvents = 0
  let originalLinState
  let originalChenState
  let lin
  let chen
  try {
    await request('/auth/login', { method: 'POST', body: { username: 'missing-user', password: 'wrong-password' }, expectedStatus: 401 })
    await request('/auth/me', { token: 'invalid-token', expectedStatus: 401 })

    const [adminLogin, linLogin, chenLogin] = await Promise.all([
      login('admin', adminPassword),
      login('lin', staffPassword),
      login('chen', staffPassword),
    ])
    const adminToken = adminLogin.token
    const linToken = linLogin.token
    const chenToken = chenLogin.token

    adminSocket = io(socketUrl, { auth: { token: adminToken }, transports: ['websocket'] })
    adminSocket.on('data:changed', () => { realtimeEvents += 1 })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket.IO connection timeout')), 5000)
      adminSocket.once('connect', () => { clearTimeout(timer); resolve() })
      adminSocket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
    })

    const [staffOptions, packageResponse, tierResponse] = await Promise.all([
      request('/staff/options', { token: adminToken }),
      request('/packages', { token: adminToken }),
      request('/staff-tiers', { token: adminToken }),
    ])
    lin = staffOptions.items.find((item) => item.name === '阿凯')
    chen = staffOptions.items.find((item) => item.name === '小宇')
    const servicePackage = packageResponse.items.find((item) => item.isEnabled)
    const baseTier = tierResponse.items.find((item) => item.isEnabled && item.canAcceptOrders)
    assert.ok(lin && chen && servicePackage && baseTier, '演示员工、套餐和员工档位必须存在')
    originalLinState = await prisma.staffProfile.findUnique({ where: { id: lin.id }, select: { status: true, presence: true, accepting: true, accountStatus: true, tierId: true } })
    originalChenState = await prisma.staffProfile.findUnique({ where: { id: chen.id }, select: { status: true, presence: true, accepting: true, accountStatus: true, tierId: true } })
    await prisma.staffProfile.updateMany({ where: { id: { in: [lin.id, chen.id] } }, data: { accepting: 'ACCEPTING', accountStatus: 'NORMAL', tierId: baseTier.id } })

    const thirdUsername = `flow${marker}`
    const thirdCreated = await request('/staff', {
      token: adminToken,
      method: 'POST',
      body: { username: thirdUsername, password: 'FlowTest123!', name: `协作测试员${marker.slice(-3)}`, tierId: baseTier.id, commissionRateBps: 3000 },
    })
    created.users.push(thirdCreated.item.id)
    const thirdLogin = await login(thirdUsername, 'FlowTest123!')
    const third = (await request('/staff/options', { token: adminToken })).items.find((item) => item.name === `协作测试员${marker.slice(-3)}`)
    assert.ok(third, '第三位并发测试员工创建失败')

    const activity = await request('/recharge-activities', {
      token: adminToken,
      method: 'POST',
      body: {
        name: `建单充值活动${marker}`,
        startAt: new Date(Date.now() - 60_000).toISOString(),
        endAt: new Date(Date.now() + 3_600_000).toISOString(),
        tiers: [{ thresholdCents: 10000, bonusCents: 1200 }],
      },
    })
    created.activities.push(activity.item.id)

    const newCustomerCode = `ORDER-${marker}`
    const createdWithCustomer = await request('/orders', {
      token: adminToken,
      method: 'POST',
      body: {
        newCustomer: { customerCode: newCustomerCode, teamCode: `TEAM-${marker}`, note: '新建订单同步建档' },
        servicePackageId: servicePackage.id,
        amountCents: 5000,
        originalAmountCents: 5000,
        discountAmountCents: 0,
        requiredStaffCount: 1,
        collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }],
        rechargeAmountCents: 10000,
        rechargeNote: '建单同步本金充值',
      },
    })
    created.orders.push(createdWithCustomer.item.id)
    created.customers.push(createdWithCustomer.item.customer.id)
    const newCustomerState = await request(`/customers/${createdWithCustomer.item.customer.id}`, { token: adminToken })
    assert.equal(newCustomerState.item.principalBalanceCents, 10000, '建单同步充值应进入本金')
    assert.equal(newCustomerState.item.bonusBalanceCents, 1200, '建单同步充值应复用活动赠金')
    assert.equal(newCustomerState.item.balanceCents, 11200, '建单、客户与充值必须在同一事务落库')
    assert.equal(newCustomerState.item.rechargeRecords.length, 1)
    await request('/orders', {
      token: adminToken,
      method: 'POST',
      expectedStatus: 409,
      body: {
        newCustomer: { customerCode: newCustomerCode, teamCode: `TEAM-DUP-${marker}` },
        servicePackageId: servicePackage.id,
        amountCents: 5000,
        requiredStaffCount: 1,
        collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }],
      },
    })
    const duplicateCustomerCount = await prisma.customer.count({ where: { customerCode: newCustomerCode } })
    assert.equal(duplicateCustomerCount, 1, '重复客户ID不能创建第二份客户档案')

    await request('/orders', { token: adminToken, method: 'POST', body: { customerId: createdWithCustomer.item.customer.id, amountCents: 1000 }, expectedStatus: 400 })
    await request('/orders', {
      token: adminToken,
      method: 'POST',
      body: {
        customerId: createdWithCustomer.item.customer.id,
        servicePackageId: servicePackage.id,
        amountCents: 1000,
        requiredStaffCount: 2,
        collaborationSlots: [{ slotIndex: 1, commissionRateBps: 6000 }, { slotIndex: 2, commissionRateBps: 5000 }],
      },
      expectedStatus: 400,
    })

    const coupon = await request('/coupons', {
      token: adminToken,
      method: 'POST',
      body: { name: `流程优惠券${marker}`, amountCents: 1000, minSpendCents: 0, startAt: new Date(Date.now() - 60_000).toISOString(), endAt: new Date(Date.now() + 3_600_000).toISOString() },
    })
    created.coupons.push(coupon.item.id)
    const issued = await request(`/coupons/${coupon.item.id}/issue`, { token: adminToken, method: 'POST', body: { customerId: createdWithCustomer.item.customer.id } })
    const couponOrder = await request('/orders', {
      token: adminToken,
      method: 'POST',
      body: {
        customerId: createdWithCustomer.item.customer.id,
        servicePackageId: servicePackage.id,
        originalAmountCents: 5000,
        discountAmountCents: 1000,
        amountCents: 4000,
        customerCouponId: issued.item.id,
        requiredStaffCount: 1,
        collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }],
      },
    })
    created.orders.push(couponOrder.item.id)
    assert.equal(couponOrder.item.customerCoupon.status, 'USED', '优惠券应在订单事务内核销')

    const privacyCustomer = await request('/customers', { token: adminToken, method: 'POST', body: { customerCode: `PRIV-${marker}`, teamCode: `TEAM-PRIV-${marker}` } })
    created.customers.push(privacyCustomer.item.id)
    const privacyOrder = await request('/orders', {
      token: adminToken,
      method: 'POST',
      body: { customerId: privacyCustomer.item.id, servicePackageId: servicePackage.id, amountCents: 3000, requiredStaffCount: 1, collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }] },
    })
    created.orders.push(privacyOrder.item.id)
    const availableBeforeClaim = await request('/workbench/available-orders', { token: linToken })
    const privatePoolItem = availableBeforeClaim.items.find((item) => item.id === privacyOrder.item.id)
    assert.ok(privatePoolItem, '待派单订单应进入符合资格员工的可接池')
    assert.equal(Object.hasOwn(privatePoolItem.customer, 'id'), false, '接单前 API 不得返回客户 ID')
    assert.equal(Object.hasOwn(privatePoolItem, 'customerId'), false, '接单前 API 顶层不得泄露客户 ID')
    assert.equal(Object.hasOwn(privatePoolItem, 'staffId'), false, '可接池不得泄露历史主员工 ID')
    assert.equal(Object.hasOwn(privatePoolItem, 'createdById'), false, '可接池不得泄露后台操作人 ID')
    assert.equal(privatePoolItem.customer.customerCode, null, '接单前 API 不得返回客户ID')
    assert.equal(privatePoolItem.customer.teamCode, null, '接单前 API 不得返回客户组队码')
    assert.equal(Object.hasOwn(privatePoolItem.customer, 'phone'), false, '接单前 API 不得返回联系方式')
    const claimedPrivacy = await request(`/orders/${privacyOrder.item.id}/claim`, { token: linToken, method: 'POST' })
    assert.equal(claimedPrivacy.item.customer.customerCode, privacyCustomer.item.customerCode, '接单后参与员工可查看客户ID')
    assert.equal(claimedPrivacy.item.customer.teamCode, privacyCustomer.item.teamCode, '接单后参与员工可查看客户组队码')
    assert.equal(Object.hasOwn(claimedPrivacy.item.customer, 'id'), false, '员工端不得返回数据库客户主键')
    assert.equal(Object.hasOwn(claimedPrivacy.item, 'customerId'), false, '员工端顶层不得返回数据库客户主键')
    const duplicateClaim = await request(`/orders/${privacyOrder.item.id}/claim`, { token: linToken, method: 'POST' })
    assert.equal(duplicateClaim.idempotent, true, '重复点击接单必须幂等')
    assert.equal(duplicateClaim.item.activeStaffCount, 1, '重复接单不能占用第二个名额')
    await request(`/orders/${privacyOrder.item.id}/exit`, { token: linToken, method: 'POST', body: {} })
    await request(`/orders/${privacyOrder.item.id}`, { token: linToken, expectedStatus: 404 })
    const privacyAfterExit = await request(`/orders/${privacyOrder.item.id}`, { token: adminToken })
    assert.equal(privacyAfterExit.item.activeStaffCount, 0, '开始前退出应立即释放名额')

    const financeBefore = (await request('/finance/overview', { token: adminToken })).item
    const flowCustomer = await request('/customers', { token: adminToken, method: 'POST', body: { customerCode: `FLOW-${marker}`, teamCode: `TEAM-FLOW-${marker}` } })
    created.customers.push(flowCustomer.item.id)
    await request(`/customers/${flowCustomer.item.id}/recharges`, { token: adminToken, method: 'POST', body: { amount: 200, bonusAmount: 0, note: '多人协作结算测试' } })
    const collaboration = await request('/orders', {
      token: adminToken,
      method: 'POST',
      body: {
        customerId: flowCustomer.item.id,
        servicePackageId: servicePackage.id,
        amountCents: 10000,
        originalAmountCents: 10000,
        discountAmountCents: 0,
        requiredStaffCount: 2,
        collaborationSlots: [{ slotIndex: 1, commissionRateBps: 4000 }, { slotIndex: 2, commissionRateBps: 4000 }],
        note: '两人协作最终流程测试',
      },
    })
    created.orders.push(collaboration.item.id)
    const oneOfTwo = await request(`/orders/${collaboration.item.id}/claim`, { token: linToken, method: 'POST' })
    assert.equal(oneOfTwo.item.activeStaffCount, 1)
    assert.equal(oneOfTwo.item.missingStaffCount, 1)
    assert.equal(oneOfTwo.item.status, 'PENDING_ASSIGNMENT')
    const chenPartialPool = await request('/workbench/available-orders', { token: chenToken })
    const partialPoolOrder = chenPartialPool.items.find((item) => item.id === collaboration.item.id)
    const occupiedPoolSlot = partialPoolOrder.assignments.find((item) => item.occupied)
    const openPoolSlot = partialPoolOrder.assignments.find((item) => !item.occupied)
    assert.equal(Object.hasOwn(occupiedPoolSlot, 'expectedEarningCents'), false, '可接池不得显示已占名额的员工收益')
    assert.equal(typeof openPoolSlot.expectedEarningCents, 'number', '可接池应显示待接名额的预计应得')
    await request(`/orders/${collaboration.item.id}/start`, { token: linToken, method: 'POST', expectedStatus: 400 })

    const [chenRace, thirdRace] = await Promise.all([
      requestResult(`/orders/${collaboration.item.id}/claim`, { token: chenToken, method: 'POST' }),
      requestResult(`/orders/${collaboration.item.id}/claim`, { token: thirdLogin.token, method: 'POST' }),
    ])
    const raceResults = [chenRace, thirdRace]
    assert.equal(raceResults.filter((item) => item.ok).length, 1, '最后一个协作名额只能有一个并发请求成功')
    assert.equal(raceResults.filter((item) => item.status === 409).length, 1, '落败请求应返回明确的业务冲突')
    assert.match(raceResults.find((item) => !item.ok).data.message, /协作人数已满|状态刚刚发生变化/, '并发落败提示应明确')
    const afterRace = await request(`/orders/${collaboration.item.id}`, { token: adminToken })
    assert.equal(afterRace.item.activeStaffCount, 2)
    assert.equal(afterRace.item.assignments.filter((item) => item.staffId && item.assignmentStatus !== 'EXITED').length, 2)
    assert.equal(afterRace.item.status, 'PENDING')
    const winner = findCurrentAssignment(afterRace.item, chen.id) ? { id: chen.id, token: chenToken } : { id: third.id, token: thirdLogin.token }
    const loser = winner.id === chen.id ? { id: third.id, token: thirdLogin.token } : { id: chen.id, token: chenToken }
    const linCollaborationView = await request(`/orders/${collaboration.item.id}`, { token: linToken })
    const linOwnAssignment = linCollaborationView.item.assignments.find((item) => item.staffId === lin.id)
    const teammateAssignment = linCollaborationView.item.assignments.find((item) => item.staff?.id === winner.id)
    assert.equal(typeof linOwnAssignment.expectedEarningCents, 'number', '参与员工应能查看本人的预计应得')
    assert.equal(Object.hasOwn(teammateAssignment, 'expectedEarningCents'), false, '员工不得查看协作队友的预计应得')
    assert.equal(Object.hasOwn(teammateAssignment, 'actualEarningCents'), false, '员工不得查看协作队友的实际应得')
    assert.equal(Object.hasOwn(teammateAssignment, 'commissionRateBps'), false, '员工不得查看协作队友的提成比例')
    assert.equal(Object.hasOwn(teammateAssignment, 'completionProofs'), false, '员工不得查看协作队友的完单凭证元数据')
    await request(`/orders/${collaboration.item.id}`, { token: loser.token, expectedStatus: 404 })

    const [startOne, startTwo] = await Promise.all([
      requestResult(`/orders/${collaboration.item.id}/start`, { token: linToken, method: 'POST' }),
      requestResult(`/orders/${collaboration.item.id}/start`, { token: winner.token, method: 'POST' }),
    ])
    assert.equal(startOne.ok && startTwo.ok, true, '多人同时开始应均返回当前有效状态')
    const started = await request(`/orders/${collaboration.item.id}`, { token: adminToken })
    assert.equal(started.item.status, 'IN_PROGRESS')

    const exitRequest = await request(`/orders/${collaboration.item.id}/exit`, { token: winner.token, method: 'POST', body: { reason: '并发测试中的服务冲突' } })
    assert.equal(exitRequest.exitReviewRequired, true, '开始后只能提交退出申请')
    const winnerAssignment = findCurrentAssignment(exitRequest.item, winner.id)
    assert.equal(winnerAssignment.exitReviewStatus, 'PENDING')
    await request(`/orders/${collaboration.item.id}/assignments/${winnerAssignment.id}/exit-review`, { token: adminToken, method: 'POST', body: { approved: false, note: '先继续协作' } })
    const rejectedExit = await request(`/orders/${collaboration.item.id}`, { token: adminToken })
    assert.equal(findCurrentAssignment(rejectedExit.item, winner.id).assignmentStatus, 'ACTIVE')
    await request(`/orders/${collaboration.item.id}/exit`, { token: winner.token, method: 'POST', body: { reason: '确认需要退出本单服务' } })
    const pendingExit = await request(`/orders/${collaboration.item.id}`, { token: adminToken })
    const pendingExitAssignment = findCurrentAssignment(pendingExit.item, winner.id)
    await request(`/orders/${collaboration.item.id}/assignments/${pendingExitAssignment.id}/exit-review`, { token: adminToken, method: 'POST', body: { approved: true, note: '同意退出并补位' } })
    await request(`/orders/${collaboration.item.id}`, { token: winner.token, expectedStatus: 404 })
    const openAfterExit = await request(`/orders/${collaboration.item.id}`, { token: adminToken })
    assert.equal(openAfterExit.item.activeStaffCount, 1)
    assert.equal(openAfterExit.item.missingStaffCount, 1)
    const loserPool = await request('/workbench/available-orders', { token: loser.token })
    assert.ok(loserPool.items.some((item) => item.id === collaboration.item.id), '管理员同意退出后名额应重新进入其他员工可接池')
    await request(`/orders/${collaboration.item.id}/claim`, { token: loser.token, method: 'POST' })
    const replaced = await request(`/orders/${collaboration.item.id}`, { token: adminToken })
    assert.equal(replaced.item.activeStaffCount, 2)
    assert.equal(findCurrentAssignment(replaced.item, loser.id).assignmentStatus, 'ACTIVE')

    await request(`/orders/${collaboration.item.id}/completion-submissions`, { token: linToken, method: 'POST', formData: invalidProofForm(), expectedStatus: 415 })
    await request(`/orders/${collaboration.item.id}/completion-submissions`, { token: linToken, method: 'POST', formData: proofForm('阿凯已完成协作服务') })
    const afterFirstProof = await request(`/orders/${collaboration.item.id}`, { token: adminToken })
    assert.equal(afterFirstProof.item.status, 'IN_PROGRESS')
    assert.equal(afterFirstProof.item.completionSubmittedCount, 1)
    const linProof = findCurrentAssignment(afterFirstProof.item, lin.id).completionProofs.at(-1)
    const ownProofFile = await requestBuffer(linProof.fileUrl.replace(/^\/api/, ''), { token: linToken })
    assert.match(ownProofFile.contentType, /^image\/png/, '凭证文件需通过鉴权接口返回图片')
    await request(linProof.fileUrl.replace(/^\/api/, ''), { token: loser.token, expectedStatus: 403 })
    await request(`/orders/${collaboration.item.id}/completion-submissions`, { token: loser.token, method: 'POST', formData: proofForm('补位员工已完成协作服务') })
    const waitingReview = await request(`/orders/${collaboration.item.id}`, { token: adminToken })
    assert.equal(waitingReview.item.status, 'PENDING_COMPLETION_REVIEW')
    assert.equal(waitingReview.item.completionSubmittedCount, 2)
    const balanceBeforeReview = (await request(`/customers/${flowCustomer.item.id}`, { token: adminToken })).item.balanceCents
    assert.equal(balanceBeforeReview, 20000, '后台审核前不得扣客户余额')
    assert.equal(await prisma.orderConsumption.count({ where: { orderId: collaboration.item.id } }), 0)

    await request(`/orders/${collaboration.item.id}/completion-review`, { token: adminToken, method: 'POST', body: { approved: false, reason: '请补充更清晰的完单截图' } })
    const returned = await request(`/orders/${collaboration.item.id}`, { token: linToken })
    assert.equal(returned.item.status, 'IN_PROGRESS')
    assert.equal(findCurrentAssignment(returned.item, lin.id).completionReviewStatus, 'REJECTED')
    assert.match(findCurrentAssignment(returned.item, lin.id).completionReviewReason, /更清晰/)
    await request(`/orders/${collaboration.item.id}/completion-submissions`, { token: linToken, method: 'POST', formData: proofForm('阿凯重新提交清晰凭证', 'proof-resubmit.png') })
    await request(`/orders/${collaboration.item.id}/completion-submissions`, { token: loser.token, method: 'POST', formData: proofForm('补位员工重新提交清晰凭证', 'proof-resubmit.png') })

    const linStatsBefore = (await request('/workbench/stats', { token: linToken })).item
    const approved = await request(`/orders/${collaboration.item.id}/completion-review`, { token: adminToken, method: 'POST', body: { approved: true } })
    assert.equal(approved.item.status, 'COMPLETED')
    const actuals = approved.item.assignments.filter((item) => item.assignmentStatus === 'COMPLETED').map((item) => item.actualEarningCents).sort((a, b) => a - b)
    assert.deepEqual(actuals, [4000, 4000], '两位员工应分别获得 40 元实际应得')
    const flowCustomerAfter = await request(`/customers/${flowCustomer.item.id}`, { token: adminToken })
    assert.equal(flowCustomerAfter.item.balanceCents, 10000, '100 元订单审核通过后余额应从 200 元变为 100 元')
    assert.equal(flowCustomerAfter.item.orderConsumptions.filter((item) => item.orderId === collaboration.item.id).length, 1)
    assert.equal(await prisma.consumptionRecord.count({ where: { orderId: collaboration.item.id } }), 1)
    const financeAfter = (await request('/finance/overview', { token: adminToken })).item
    assert.equal(financeAfter.revenueCents - financeBefore.revenueCents, 10000)
    assert.equal(financeAfter.staffEarningsCents - financeBefore.staffEarningsCents, 8000)
    assert.equal(financeAfter.profitCents - financeBefore.profitCents, 2000)
    const linStatsAfter = (await request('/workbench/stats', { token: linToken })).item
    assert.equal(linStatsAfter.totalEarningsCents - linStatsBefore.totalEarningsCents, 4000)
    const duplicateReview = await request(`/orders/${collaboration.item.id}/completion-review`, { token: adminToken, method: 'POST', body: { approved: true } })
    assert.equal(duplicateReview.idempotent, true)
    assert.equal((await request(`/customers/${flowCustomer.item.id}`, { token: adminToken })).item.balanceCents, 10000)
    assert.equal(await prisma.orderConsumption.count({ where: { orderId: collaboration.item.id } }), 1, '重复审核不能重复结算')

    const poorCustomer = await request('/customers', { token: adminToken, method: 'POST', body: { customerCode: `POOR-${marker}`, teamCode: `TEAM-POOR-${marker}` } })
    created.customers.push(poorCustomer.item.id)
    await request(`/customers/${poorCustomer.item.id}/recharges`, { token: adminToken, method: 'POST', body: { amount: 50, bonusAmount: 0 } })
    const poorOrder = await request('/orders', {
      token: adminToken,
      method: 'POST',
      body: { customerId: poorCustomer.item.id, servicePackageId: servicePackage.id, amountCents: 10000, staffId: lin.id, requiredStaffCount: 1, collaborationSlots: [{ slotIndex: 1, commissionRateBps: 3000 }] },
    })
    created.orders.push(poorOrder.item.id)
    await request(`/orders/${poorOrder.item.id}/start`, { token: linToken, method: 'POST' })
    await request(`/orders/${poorOrder.item.id}/complete`, { token: linToken, method: 'POST', expectedStatus: 409 })
    await request(`/orders/${poorOrder.item.id}/completion-submissions`, { token: linToken, method: 'POST', formData: proofForm('余额不足场景完单凭证') })
    const insufficientReview = await requestResult(`/orders/${poorOrder.item.id}/completion-review`, { token: adminToken, method: 'POST', body: { approved: true } })
    assert.equal(insufficientReview.status, 409)
    assert.match(insufficientReview.data.message, /客户余额不足，请先充值或调整余额/)
    const poorAfter = await request(`/orders/${poorOrder.item.id}`, { token: adminToken })
    assert.equal(poorAfter.item.status, 'PENDING_COMPLETION_REVIEW')
    assert.equal(findCurrentAssignment(poorAfter.item, lin.id).actualEarningCents, 0)
    assert.equal((await request(`/customers/${poorCustomer.item.id}`, { token: adminToken })).item.balanceCents, 5000)
    assert.equal(await prisma.orderConsumption.count({ where: { orderId: poorOrder.item.id } }), 0)

    const afterSale = await request('/after-sales', { token: adminToken, method: 'POST', body: { orderId: collaboration.item.id, issueType: '凭证复核', description: '初始售后说明' } })
    await request(`/after-sales/${afterSale.item.id}`, { token: adminToken, method: 'PATCH', body: { issueType: '服务过程复核', description: '后台已更新问题描述，员工端应实时同步。', status: 'PROCESSING', handlingNote: '请参与员工补充服务说明' } })
    const staffAfterSales = await request('/workbench/aftersales', { token: linToken })
    const synchronizedCase = staffAfterSales.items.find((item) => item.id === afterSale.item.id)
    assert.equal(synchronizedCase.issueType, '服务过程复核')
    assert.equal(synchronizedCase.description, '后台已更新问题描述，员工端应实时同步。')
    assert.equal(synchronizedCase.handlingNote, '请参与员工补充服务说明')
    await request(`/after-sales/${afterSale.item.id}/messages`, { token: linToken, method: 'POST', body: { content: '员工已提交关联售后说明' } })
    const afterSaleUpdated = await request(`/after-sales/${afterSale.item.id}`, { token: adminToken, method: 'PATCH', body: { status: 'COMPLETED', resultType: 'COMPENSATION', compensationAmount: 2, handlingNote: '线下赔付已登记' } })
    assert.equal(afterSaleUpdated.item.status, 'COMPLETED')

    const importedCodes = [`IMPORT-A-${marker}`, `IMPORT-B-${marker}`, `IMPORT-C-${marker}`]
    const template = await requestBuffer('/imports/template?type=customers', { token: adminToken })
    const templateWorkbook = new ExcelJS.Workbook()
    await templateWorkbook.xlsx.load(template.buffer)
    assert.ok(templateWorkbook.worksheets.length > 0, 'Excel 客户模板必须可下载并读取')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('客户导入')
    sheet.columns = [{ header: '客户ID', key: 'customerCode' }, { header: '客户组队码', key: 'teamCode' }, { header: '备注', key: 'note' }]
    sheet.addRows([{ customerCode: importedCodes[0], teamCode: `TEAM-A-${marker}` }, { customerCode: importedCodes[1], teamCode: `TEAM-B-${marker}` }, { customerCode: '', teamCode: `TEAM-C-${marker}` }])
    const excel = await workbook.xlsx.writeBuffer()
    const importForm = new FormData()
    importForm.append('type', 'customers')
    importForm.append('file', new Blob([excel]), 'customers.xlsx')
    const imported = await request('/imports', { token: adminToken, method: 'POST', formData: importForm })
    assert.equal(imported.successCount, 2)
    assert.equal(imported.failureCount, 1)
    assert.equal(imported.errors[0].row, 4)
    created.customers.push(...(await prisma.customer.findMany({ where: { customerCode: { in: importedCodes } }, select: { id: true } })).map((item) => item.id))

    const csUsername = `flowcs${marker}`
    const cs = await request('/admin/users', { token: adminToken, method: 'POST', body: { username: csUsername, password: 'FlowTest123!', role: 'CUSTOMER_SERVICE' } })
    created.users.push(cs.item.id)
    const csLogin = await login(csUsername, 'FlowTest123!')
    await request('/customers', { token: csLogin.token, expectedStatus: 403 })
    const limitedCustomers = await request('/order-options/customers?search=' + encodeURIComponent(marker), { token: csLogin.token })
    assert.ok(limitedCustomers.items.length <= 20)
    assert.ok(limitedCustomers.items.every(item => Object.keys(item).every(key => ['id', 'customerCode', 'teamCode'].includes(key))))
    await request('/staff', { token: csLogin.token, expectedStatus: 403 })
    await request('/admin/users', { token: csLogin.token, expectedStatus: 403 })
    await request('/staff', { token: linToken, expectedStatus: 403 })
    await request(`/orders/${poorOrder.item.id}`, { token: linToken, method: 'PATCH', body: { amountCents: 1 }, expectedStatus: 403 })

    assert.ok(realtimeEvents >= 8, `Socket.IO 应收到业务更新事件，实际 ${realtimeEvents}`)
    console.log(JSON.stringify({
      ok: true,
      migrationCompatible: true,
      newCustomerAndRechargeTransaction: true,
      customerIdIsolation: true,
      teammateIncomeIsolation: true,
      concurrentFinalSlot: true,
      duplicateClaimIdempotent: true,
      exitAndReplacement: true,
      fullTeamStart: true,
      completionSubmissionProgress: '2/2',
      completionProofSignatureValidation: true,
      completionRejectAndResubmit: true,
      uniqueSettlement: true,
      financialExample: { revenueCents: 10000, staffEarningsCents: 8000, profitCents: 2000 },
      insufficientBalanceRollback: true,
      afterSaleRealtimeData: true,
      excel: { success: 2, failure: 1, failedRow: 4 },
      roleIsolation: true,
      socketEvents: realtimeEvents,
    }, null, 2))
  } finally {
    adminSocket?.disconnect()
    if (created.orders.length) {
      const proofRows = await prisma.orderCompletionProof.findMany({ where: { orderId: { in: created.orders } }, select: { proofPath: true } }).catch(() => [])
      created.proofs.push(...proofRows.map((item) => item.proofPath))
      await prisma.afterSaleMessage.deleteMany({ where: { case: { orderId: { in: created.orders } } } }).catch(() => undefined)
      await prisma.fundTransaction.deleteMany({ where: { afterSaleCase: { orderId: { in: created.orders } } } }).catch(() => undefined)
      await prisma.afterSaleCase.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.fundTransaction.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.orderConsumption.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.consumptionRecord.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => undefined)
      await prisma.order.deleteMany({ where: { id: { in: created.orders } } }).catch(() => undefined)
    }
    if (created.customers.length) {
      await prisma.fundTransaction.deleteMany({ where: { customerId: { in: created.customers } } }).catch(() => undefined)
      await prisma.customer.deleteMany({ where: { id: { in: created.customers } } }).catch(() => undefined)
    }
    if (created.coupons.length) await prisma.coupon.deleteMany({ where: { id: { in: created.coupons } } }).catch(() => undefined)
    if (created.activities.length) await prisma.rechargeActivity.deleteMany({ where: { id: { in: created.activities } } }).catch(() => undefined)
    await prisma.operationLog.deleteMany({ where: { createdAt: { gte: testStartedAt } } }).catch(() => undefined)
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => undefined)
    if (lin && originalLinState) await prisma.staffProfile.update({ where: { id: lin.id }, data: originalLinState }).catch(() => undefined)
    if (chen && originalChenState) await prisma.staffProfile.update({ where: { id: chen.id }, data: originalChenState }).catch(() => undefined)
    await Promise.allSettled(created.proofs.map((proofPath) => unlink(path.resolve(process.cwd(), proofPath))))
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

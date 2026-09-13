import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { testEnvironment } from './feedback-isolated-env.mjs'
const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const marker = Date.now(), password = randomBytes(20).toString('hex'), users = [], customers = [], orders = [], proofs = [], checks = []
const base = 'http://127.0.0.1:4210/api', out = 'output/test-order-cleanup-20260912'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
let browser, pack
const req = async (url, token, body, method = 'GET', expected = 200) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json(); assert.equal(r.status, expected, `${url}: ${r.status} ${JSON.stringify(data)}`); return data
}
try {
  for (const role of ['SUPER_ADMIN','STORE_MANAGER','STAFF','STAFF']) users.push(await p.user.create({ data: { username: `DEMO_DELETE_${marker}_${users.length}`, passwordHash: await bcrypt.hash(password, 10), role, ...(role === 'STAFF' ? { staffProfile: { create: { name: `删除凭证演示员工${users.length}` } } } : {}) }, include: { staffProfile: true } }))
  const tokens = []
  for (const u of users) tokens.push((await req('/auth/login', null, { username: u.username, password }, 'POST')).token)
  const [admin, manager, a, b] = tokens
  pack = await p.servicePackage.create({ data: { name: `演示删除套餐${marker}`, basePriceCents: 15800 } })
  const create = async (count = 1) => {
    const c = await p.customer.create({ data: { name: '演示客户001', customerCode: `DEMO_DELETE_${marker}_${customers.length}`, teamCode: 'TEAM001', principalBalanceCents: 10000, bonusBalanceCents: 5800, balanceCents: 15800 } }); customers.push(c.id)
    const o = (await req('/orders', admin, { customerId: c.id, servicePackageId: pack.id, amountCents: 15800, requiredStaffCount: count, collaborationSlots: Array.from({ length: count }, (_, i) => ({ slotIndex: i + 1, commissionRateBps: count === 2 ? 4000 : 8000 })) }, 'POST', 201)).item
    orders.push(o.id); return o
  }
  const remove = (o, token = admin, expected = 200, orderNo = o.orderNo) => req(`/orders/${o.id}`, token, { orderNo }, 'DELETE', expected)
  const finish = async count => {
    const o = await create(count)
    for (const token of [a,b].slice(0,count)) await req(`/orders/${o.id}/claim`, token, {}, 'POST')
    await req(`/orders/${o.id}/start`, a, {}, 'POST')
    for (const token of [a,b].slice(0,count)) {
      const form = new FormData(); form.append('note','隔离演示完单凭证'); form.append('proofs',new Blob([png],{type:'image/png'}),'demo.png')
      const r = await fetch(base + `/orders/${o.id}/completion-submissions`, {method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});assert.equal(r.status,200)
    }
    const rows = await p.orderCompletionProof.findMany({where:{orderId:o.id}}); proofs.push(...rows.map(r=>r.proofPath))
    for (const proof of rows) {
      const r = await fetch(base+`/order-proofs/${proof.id}/file`,{headers:{Authorization:`Bearer ${admin}`}});assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^image\/png/);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(png))
      await req(`/order-proofs/${proof.id}/file`,null,undefined,'GET',401)
      const foreign = proof.staffId===users[2].staffProfile.id ? b : a
      await req(`/order-proofs/${proof.id}/file`,foreign,undefined,'GET',403)
    }
    await req(`/orders/${o.id}/completion-review`,admin,{approved:true},'POST')
    for(const proof of rows) assert.equal((await fetch(base+`/order-proofs/${proof.id}/file`,{headers:{Authorization:`Bearer ${admin}`}})).status,200)
    return {o,rows}
  }
  const baseline = async () => ({ orders:await p.order.findMany({where:{id:{notIn:orders}},orderBy:{id:'asc'}}), customers:await p.customer.findMany({where:{id:{notIn:customers}},orderBy:{id:'asc'}}), assignments:await p.orderStaffAssignment.findMany({where:{orderId:{notIn:orders}},orderBy:{id:'asc'}}), adjustments:await p.staffEarningAdjustment.findMany({where:{staffId:{notIn:users.filter(u=>u.staffProfile).map(u=>u.staffProfile.id)}},orderBy:{id:'asc'}}) })
  const untouched = hash(await baseline())
  const pending=await create(); await remove(pending,null,401);await remove(pending,manager,403);await remove(pending,a,403);await remove(pending,admin,400,'WRONG');assert(await p.order.findUnique({where:{id:pending.id}}));await remove(pending);await remove(pending,admin,404)
  checks.push('unstarted delete; unauthenticated/manager/staff denied; confirmation required; repeat cannot refund')
  const active=await create();await req(`/orders/${active.id}/claim`,a,{},'POST');await req(`/orders/${active.id}/start`,a,{},'POST');await remove(active);assert.equal((await p.staffProfile.findUnique({where:{id:users[2].staffProfile.id}})).status,'IDLE')
  checks.push('in-progress order removed and employee derived busy status recalculated')
  const {o,rows}=await finish(2)
  assert.deepEqual((await p.orderConsumption.findUnique({where:{orderId:o.id}})).principalUsedCents,10000)
  const {chromium}=createRequire(import.meta.url)('playwright');browser=await chromium.launch({headless:true,args:['--disable-features=LocalNetworkAccessChecks']})
  const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'zh-CN'})
  const csp=fs.readFileSync('deploy/nginx.showcase-https.conf','utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
  await ctx.route('**/*',async route=>{if(route.request().isNavigationRequest()){const r=await route.fetch();await route.fulfill({response:r,headers:{...r.headers(),'content-security-policy':csp}})}else await route.continue()})
  const page=await ctx.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())})
  await page.goto('http://127.0.0.1:8280/admin/login');await page.getByLabel('账号',{exact:true}).fill(users[0].username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'进入管理后台'}).click();await page.waitForURL(url=>!url.pathname.endsWith('/login'))
  await page.goto(`http://127.0.0.1:8280/admin/orders?orderId=${o.id}`)
  await page.getByRole('img',{name:'完单凭证',exact:true}).first().waitFor()
  await page.waitForFunction(()=>[...document.querySelectorAll('img[alt="完单凭证"]')].length===2 && [...document.querySelectorAll('img[alt="完单凭证"]')].every(i=>i.complete&&i.naturalWidth>0))
  await page.screenshot({path:out+'/proofs-pc.png',animations:'disabled'})
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/proofs-mobile.png',animations:'disabled'})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.getByRole('button',{name:'删除订单',exact:true}).click();await page.getByLabel('请输入完整订单号确认').fill('WRONG');assert(await page.getByRole('button',{name:'确认删除并回退账务'}).isDisabled());await page.getByLabel('请输入完整订单号确认').fill(o.orderNo)
  await page.screenshot({path:out+'/delete-confirm-mobile.png',animations:'disabled'})
  const metrics = async () => {
    const list=(await req('/staff',admin)).items
    const workload=(await req('/staff/workload?startDate=2026-09-01&endDate=2026-09-30',admin)).items
    const workbench=(await req('/workbench/stats?period=month',a)).item
    const weekly=(await req('/workbench/stats/details?period=week',a)).item
    return { staff:list.map(s=>({id:s.id,completedCount:s.completedCount,completionRate:s.completionRate,inProgressCount:s.inProgressCount,totalEarningsCents:s.totalEarningsCents,pendingSettlementCents:s.pendingSettlementCents,incidentCounts:s.incidentCounts})),workload,workbench,weekly }
  }
  const statisticsBefore=await metrics()
  const staffPage=await ctx.newPage();await staffPage.goto('http://127.0.0.1:8280/admin/staff')
  await staffPage.getByText('区间工作量',{exact:true}).waitFor()
  const employeeContext=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'})
  const employeePage=await employeeContext.newPage();await employeePage.goto('http://127.0.0.1:8280/workbench/login');await employeePage.getByLabel('账号',{exact:true}).fill(users[2].username);await employeePage.getByLabel('密码',{exact:true}).fill(password);await employeePage.getByRole('button',{name:'进入工作台'}).click();await employeePage.waitForURL(url=>!url.pathname.endsWith('/login'));await employeePage.goto('http://127.0.0.1:8280/workbench/stats')
  await employeePage.getByText('我的统计',{exact:true}).first().waitFor()
  const waitJson=async(page,fragment,valid)=>{try{for(let i=0;i<12;i++){const r=await page.waitForResponse(r=>new URL(r.url()).pathname===fragment&&r.request().method()==='GET'&&r.status()===200,{timeout:30000});const data=await r.json();if(valid(data))return true}throw Error('Realtime statistics did not converge')}catch(e){return {error:fragment,message:e.message}}}
  const financeBefore=(await req('/finance/overview',admin)).item
  const reportRange=(await req('/finance/staff-settlement-summary?period=week',admin)).item.range
  const weekFinanceBefore=(await req('/finance/overview?startDate='+reportRange.startDate+'&endDate='+reportRange.endDate,admin)).item
  const financePage=await ctx.newPage();await financePage.goto('http://127.0.0.1:8280/admin/finance');await financePage.getByText('财务中心',{exact:true}).first().waitFor()
  const ordersPage=await employeeContext.newPage();await ordersPage.goto('http://127.0.0.1:8280/workbench/orders?status=COMPLETED');await ordersPage.getByText('已完成',{exact:true}).click();await ordersPage.getByText(o.orderNo,{exact:false}).first().waitFor()
  const staffRefresh=waitJson(staffPage,'/api/staff',d=>d.items?.find(s=>s.id===users[2].staffProfile.id)?.completedCount===0)
  // /staff may have no query string; use the workload endpoint separately for the fixed refresh path.
  const workloadRefresh=waitJson(staffPage,'/api/staff/workload',d=>d.items?.find(s=>s.staffId===users[2].staffProfile.id)?.completedCount===0)
  const employeeRefresh=waitJson(employeePage,'/api/workbench/stats',d=>d.item?.totalCompletedCount===0)
  const financeRefresh=waitJson(financePage,'/api/finance/overview',d=>d.item?.revenueCents===weekFinanceBefore.revenueCents-15800)
  const ordersRefresh=waitJson(ordersPage,'/api/orders',d=>Array.isArray(d.items)&&!d.items.some(item=>item.id===o.id))
  const deleteResponse=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith(`/orders/${o.id}`))
  await page.getByRole('button',{name:'确认删除并回退账务'}).click()
  const deletion=await deleteResponse;assert.equal(deletion.status(),200,JSON.stringify(await deletion.json()))
  const refreshResults=await Promise.all([staffRefresh,workloadRefresh,employeeRefresh,financeRefresh,ordersRefresh]);assert(refreshResults.every(r=>r===true),JSON.stringify(refreshResults))
  const statisticsAfter=await metrics()
  const targetBefore=statisticsBefore.staff.find(s=>s.id===users[2].staffProfile.id),targetAfter=statisticsAfter.staff.find(s=>s.id===users[2].staffProfile.id)
  assert.equal(targetBefore.completedCount,1);assert.equal(targetBefore.completionRate,1);assert.equal(targetAfter.completedCount,0);assert.equal(targetAfter.completionRate,0);assert.equal(targetAfter.totalEarningsCents,0)
  for(const s of statisticsBefore.staff.filter(s=>!users.slice(2).some(u=>u.staffProfile.id===s.id)))assert.deepEqual(statisticsAfter.staff.find(a=>a.id===s.id),s)
  assert.equal(statisticsAfter.workbench.totalCompletedCount,0);assert.equal(statisticsAfter.workbench.totalEarningsCents,0);assert.equal(statisticsAfter.workbench.assignedOrderCount,0);assert.equal(statisticsAfter.workbench.monthCompletedCount,0);assert.equal(statisticsAfter.weekly.summary.completedCount,0);assert.equal(statisticsAfter.weekly.orders.length,0)
  await staffPage.screenshot({path:out+'/staff-statistics-after.png',animations:'disabled'});await employeePage.screenshot({path:out+'/workbench-statistics-after.png',animations:'disabled'})
  fs.writeFileSync(out+'/staff-statistics-delete-test.json',JSON.stringify({result:'PASS',before:targetBefore,after:targetAfter,workbenchAfter:statisticsAfter.workbench,weekAfter:statisticsAfter.weekly.summary,realtimeWithoutRelogin:true,otherStaffUnchanged:true},null,2))
  const restored=await p.customer.findUnique({where:{id:o.customer.id}});assert.equal(restored.principalBalanceCents,10000);assert.equal(restored.bonusBalanceCents,5800)
  const financeAfter=(await req('/finance/overview',admin)).item
  assert.equal(financeBefore.revenueCents-financeAfter.revenueCents,15800);assert.equal(financeBefore.staffEarningsCents-financeAfter.staffEarningsCents,12640)
  for(const row of rows) assert.equal(fs.existsSync(row.proofPath),false)
  checks.push('2-person upload; authenticated original images before/after review; production CSP PC/mobile rendering; confirmation UI; principal100/bonus58 refund; earnings126.40 removed; files removed')
  const single=await finish(1)
  await req(`/orders/${single.o.id}/adjustments`,admin,{requestId:`DEMO_ADJ_${marker}`,netAmount:100,reason:'演示净额调整',staffNetEarnings:[{assignmentId:single.o.assignments[0].id,amount:80}]},'POST',201)
  const afterSale=(await req('/after-sales',admin,{orderId:single.o.id,issueType:'演示售后',description:'仅隔离测试'},'POST',201)).item
  await req(`/after-sales/${afterSale.id}/messages`,admin,{content:'演示跟进'},'POST',201)
  await req(`/after-sales/${afterSale.id}`,admin,{status:'COMPLETED',compensationAmount:20,handlingNote:'隔离演示补偿'},'PATCH')
  await remove(single.o)
  const balance=await p.customer.findUnique({where:{id:single.o.customer.id}});assert.equal(balance.principalBalanceCents,10000);assert.equal(balance.bonusBalanceCents,5800);assert.equal(await p.afterSaleCase.count({where:{id:afterSale.id}}),0)
  checks.push('one-person upload; aftersale/followup/adjustment plus posted compensation reverse net ledger precisely')
  const zeroed=await finish(2)
  await req(`/orders/${zeroed.o.id}/adjustments`,admin,{requestId:`DEMO_ZERO_${marker}`,netAmount:0,reason:'已全额退回的演示单',staffNetEarnings:zeroed.o.assignments.map(a=>({assignmentId:a.id,amount:0}))},'POST',201)
  const zeroBefore=await p.customer.findUnique({where:{id:zeroed.o.customer.id}})
  const zeroResult=await remove(zeroed.o)
  assert.equal(zeroResult.restoredPrincipalCents,0);assert.equal(zeroResult.restoredBonusCents,0)
  assert.deepEqual(await p.customer.findUnique({where:{id:zeroed.o.customer.id}}),zeroBefore)
  checks.push('fully refunded zero-net order deletion never refunds again')
  const paid=await finish(1)
  const payment=await p.settlementRecord.create({data:{requestId:`DEMO_PAY_${marker}`,staffId:users[2].staffProfile.id,operatorId:users[0].id,amountCents:100,settlementMethod:'隔离演示',settledAt:new Date()}})
  const before=hash(await p.customer.findUnique({where:{id:paid.o.customer.id}}))
  const denied=await remove(paid.o,admin,409);assert.match(denied.message,/线下结算/);assert.equal(hash(await p.customer.findUnique({where:{id:paid.o.customer.id}})),before);assert(await p.order.findUnique({where:{id:paid.o.id}}))
  await p.settlementRecord.delete({where:{id:payment.id}});await remove(paid.o)
  checks.push('settled earning deletion rejected atomically, customer/order unchanged')
  assert.equal(hash(await baseline()),untouched)
  assert.equal(errors.length,0,JSON.stringify(errors))
  const audit=await p.operationLog.findMany({where:{operatorId:users[0].id,action:'SUPER_ADMIN_DELETE_ORDER'}});assert(audit.length>=5);assert(audit.every(a=>a.detail.operatorId===users[0].id))
  checks.push('other orders/customers/employee earnings unchanged; immutable deletion audit retained')
  fs.writeFileSync(out+'/delete-proof-tests.json',JSON.stringify({result:'PASS',checks,consoleErrors:errors},null,2));console.log(JSON.stringify({result:'PASS',checks:checks.length,consoleErrors:errors.length}))
} finally {
  if(browser)await browser.close()
  const ids=users.map(u=>u.id), staffIds=users.filter(u=>u.staffProfile).map(u=>u.staffProfile.id)
  await p.staffEarningAdjustment.deleteMany({where:{staffId:{in:staffIds}}});await p.orderAdjustment.deleteMany({where:{orderId:{in:orders}}})
  const cases=await p.afterSaleCase.findMany({where:{orderId:{in:orders}},select:{id:true}})
  await p.fundTransaction.deleteMany({where:{customerId:{in:customers}}});await p.afterSaleMessage.deleteMany({where:{caseId:{in:cases.map(c=>c.id)}}});await p.afterSaleCase.deleteMany({where:{orderId:{in:orders}}})
  await p.orderConsumption.deleteMany({where:{orderId:{in:orders}}});await p.consumptionRecord.deleteMany({where:{orderId:{in:orders}}});await p.orderCompletionProof.deleteMany({where:{orderId:{in:orders}}});await p.orderStaffAssignment.deleteMany({where:{orderId:{in:orders}}});await p.order.deleteMany({where:{id:{in:orders}}})
  await p.settlementRecord.deleteMany({where:{staffId:{in:staffIds}}});await p.operationLog.deleteMany({where:{operatorId:{in:ids}}});await p.customer.deleteMany({where:{id:{in:customers}}});if(pack)await p.servicePackage.delete({where:{id:pack.id}});await p.staffProfile.deleteMany({where:{id:{in:staffIds}}});await p.user.deleteMany({where:{id:{in:ids}}});await p.$disconnect()
  for(const f of proofs){const resolved=path.resolve(f);assert(resolved.startsWith(path.resolve('uploads/order-proofs')+path.sep));if(fs.existsSync(resolved))fs.unlinkSync(resolved)}
}

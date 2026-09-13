import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import bcrypt from 'bcryptjs'
import { io } from 'socket.io-client'
import { db, env } from './admin-reminders-local.mjs'

assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const p = db()
const roles = ['STORE_MANAGER','CUSTOMER_SERVICE','DISPATCHER','FINANCE']
const keys = [...roles.map(role => 'role_permissions_' + role), 'admin_dashboard_slogan']
const originals = await p.systemSetting.findMany({ where: { key: { in: keys } } })
const marker = 'rbac_' + randomBytes(5).toString('hex')
const password = randomBytes(24).toString('base64url')
const users = {}, tokens = {}, ids = []
const checks = []
let browser, socket
const request = async (endpoint, token, method = 'GET', body, status = 200) => {
  const r = await fetch(env.BASE_URL + endpoint, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json()
  assert.equal(r.status,status,`${method} ${endpoint}: expected ${status}, got ${r.status} ${data.message ?? ''}`)
  return data
}
const login = async role => (await request('/auth/login',null,'POST',{username:users[role].username,password})).token
const setRole = (role, permissions, token = tokens.SUPER_ADMIN, status = 200) => request('/admin/role-permissions/' + role,token,'PATCH',{permissions},status)
const connect = token => new Promise((resolve,reject) => {
  const s=io('http://127.0.0.1:4210',{auth:{token},transports:['websocket'],reconnection:false,timeout:6000})
  s.once('connect',()=>resolve(s));s.once('connect_error',()=>{s.disconnect();reject(new Error('Socket authentication failed'))})
})
const failBody={username:marker+'_forbidden',password,role:'SUPER_ADMIN'}
try {
  const hash=await bcrypt.hash(password,10)
  for(const role of ['SUPER_ADMIN',...roles]) {
    users[role]=await p.user.create({data:{username:marker+'_'+role,passwordHash:hash,role}})
    ids.push(users[role].id)
    tokens[role]=await login(role)
  }
  const peer=await p.user.create({data:{username:marker+'_peer',passwordHash:hash,role:'STORE_MANAGER'}});ids.push(peer.id)
  for(const role of roles) await request('/admin/role-permissions/'+role+'/reset',tokens.SUPER_ADMIN,'POST')
  const initial=await request('/admin/role-permissions',tokens.SUPER_ADMIN)
  assert.deepEqual(initial.roles.map(x=>x.role),roles)
  const defaults=Object.fromEntries(initial.roles.map(x=>[x.role,x.permissions]))
  const expectedLimited=['orders.view','orders.create','orders.assign','orders.review','aftersales.view','aftersales.create','dispatch.self']
  for(const role of ['CUSTOMER_SERVICE','DISPATCHER']) assert.deepEqual(defaults[role],expectedLimited)
  assert.deepEqual(defaults.FINANCE,['finance.view','settlement.view','settlement.manage'])
  assert.equal(defaults.STORE_MANAGER.length,30)
  assert.deepEqual((await request('/auth/me',tokens.SUPER_ADMIN)).user.permissions,defaults.STORE_MANAGER)
  assert.deepEqual((await request('/admin/role-permissions',tokens.STORE_MANAGER)).roles.map(x=>x.role),roles.slice(1))
  checks.push('Latest limited defaults; manager has all daily capabilities bounded by hierarchy; super remains complete')
  for(const role of roles) await setRole(role,defaults[role])
  for(const role of roles.slice(1)) await setRole(role,defaults[role],tokens.STORE_MANAGER)
  for(const role of ['STORE_MANAGER','SUPER_ADMIN']) {
    await setRole(role,[],tokens.STORE_MANAGER,403)
    await request('/admin/role-permissions/'+role+'/reset',tokens.STORE_MANAGER,'POST',undefined,403)
  }
  await setRole('SUPER_ADMIN',[],tokens.SUPER_ADMIN,403)
  for(const role of roles.slice(1)) {
    await request('/admin/role-permissions',tokens[role],'GET',undefined,403)
    await setRole('CUSTOMER_SERVICE',[],tokens[role],403)
    await request('/admin/role-permissions/CUSTOMER_SERVICE/reset',tokens[role],'POST',undefined,403)
  }
  await setRole('CUSTOMER_SERVICE',[...defaults.CUSTOMER_SERVICE,'rbac.manage'],tokens.STORE_MANAGER,403)
  await setRole('CUSTOMER_SERVICE',[...defaults.CUSTOMER_SERVICE,'rbac.manage'],tokens.SUPER_ADMIN,403)
  await setRole('CUSTOMER_SERVICE',['not.a.real.permission'],tokens.SUPER_ADMIN,400)
  for(const target of [users.SUPER_ADMIN,users.STORE_MANAGER,peer]) {
    for(const body of [{username:marker+'_blocked'},{isActive:false},{role:'SUPER_ADMIN'}]) await request('/admin/users/'+target.id,tokens.STORE_MANAGER,'PATCH',body,403)
    await request('/admin/users/'+target.id+'/reset-password',tokens.STORE_MANAGER,'POST',{password:randomBytes(20).toString('hex')},403)
  }
  for(const role of ['SUPER_ADMIN','STORE_MANAGER']) {
    await request('/admin/users',tokens.STORE_MANAGER,'POST',{...failBody,role},403)
    await request('/admin/users/'+users.CUSTOMER_SERVICE.id,tokens.STORE_MANAGER,'PATCH',{role},403)
  }
  for(const role of roles.slice(1)) {
    const {item}=await request('/admin/users',tokens.STORE_MANAGER,'POST',{username:marker+'_created_'+role,password,role},201)
    ids.push(item.id)
    await request('/admin/users/'+item.id,tokens.STORE_MANAGER,'PATCH',{isActive:false,role:'CUSTOMER_SERVICE'})
    await request('/admin/users/'+item.id+'/reset-password',tokens.STORE_MANAGER,'POST',{password})
  }
  const managed=(await request('/admin/users',tokens.STORE_MANAGER)).items
  assert(managed.every(x=>roles.slice(1).includes(x.role)))
  const protectedAfter=await p.user.findUniqueOrThrow({where:{id:users.SUPER_ADMIN.id}})
  assert.deepEqual(protectedAfter,users.SUPER_ADMIN)
  checks.push('Hierarchy: manager can configure/create/edit/reset lower roles; cannot target self, peer managers or super admin; system permissions cannot be delegated')
  for(const endpoint of ['/dashboard/summary','/orders','/staff','/customers','/finance/overview','/finance/settlement-options','/stats/overview','/after-sales','/packages','/staff-tiers','/recharge-activities','/campaigns','/admin/reminders']) await request(endpoint,tokens.STORE_MANAGER)
  for(const role of ['DISPATCHER','FINANCE']) await request('/staff',tokens[role],'POST',{},403)
  // Dispatcher may read staff, but has no customer-management or finance permission by default.
  await request('/finance/overview',tokens.DISPATCHER,'GET',undefined,403)
  await request('/customers',tokens.DISPATCHER,'POST',{},403)
  checks.push('Default business routes: manager operations available; dispatcher/finance cannot cross their business privileges')
  const custom=[...defaults.CUSTOMER_SERVICE,'finance.view','dashboard.view','aftersales.manage']
  await setRole('CUSTOMER_SERVICE',custom,tokens.STORE_MANAGER)
  await request('/finance/overview',tokens.CUSTOMER_SERVICE)
  assert((await request('/auth/me',tokens.CUSTOMER_SERVICE)).user.permissions.includes('finance.view'))
  const persisted=await p.systemSetting.findUniqueOrThrow({where:{key:'role_permissions_CUSTOMER_SERVICE'}})
  assert(JSON.parse(persisted.value).includes('finance.view'))
  const child=spawnSync(process.execPath,['--input-type=module','-e',"import {getRolePermissions} from './dist/server/role-permissions.js'; import {prisma} from './dist/server/prisma.js'; try{if(!(await getRolePermissions('CUSTOMER_SERVICE')).includes('finance.view'))process.exitCode=1}finally{await prisma.$disconnect()}"],{env,encoding:'utf8',windowsHide:true})
  assert.equal(child.status,0,'Fresh process must read persisted role config')
  socket=await connect(tokens.CUSTOMER_SERVICE)
  const {chromium}=createRequire(path.join(process.env.APPDATA,'npm','package.json'))('playwright')
  browser=await chromium.launch({headless:true})
  const context=await browser.newContext({viewport:{width:1440,height:960},timezoneId:'America/Los_Angeles'})
  const service=await context.newPage()
  const browserLogin=async(page,role)=>{
    await page.goto('http://127.0.0.1:8280/admin/login')
    await page.getByLabel('账号',{exact:true}).fill(users[role].username)
    await page.getByLabel('密码',{exact:true}).fill(password)
    await page.getByRole('button',{name:'进入管理后台'}).click()
    await page.waitForURL('**/admin/dashboard')
  }
  await browserLogin(service,'CUSTOMER_SERVICE')
  await service.getByRole('menuitem',{name:'财务中心'}).click()
  await service.getByRole('heading',{name:'财务中心',exact:true}).waitFor()
  assert(await service.getByRole('button',{name:'线下人工结算',exact:true}).isDisabled())
  const managerContext=await browser.newContext({viewport:{width:1440,height:960}})
  const manager=await managerContext.newPage()
  await browserLogin(manager,'STORE_MANAGER')
  await manager.getByRole('menuitem',{name:'账号权限'}).click()
  await manager.getByRole('button',{name:'角色权限配置',exact:true}).click()
  await manager.getByRole('tab',{name:'客服',exact:true}).waitFor()
  assert.equal(await manager.getByRole('tab',{name:'店长',exact:true}).count(),0)
  const financeCheckbox=manager.getByRole('checkbox',{name:'财务查看与导出',exact:true})
  assert(await financeCheckbox.isChecked())
  await financeCheckbox.uncheck()
  await manager.getByRole('button',{name:'保存当前角色权限',exact:true}).click()
  await manager.getByText('角色权限已保存，相关账号下次请求即生效',{exact:true}).waitFor()
  await service.getByText('暂无此页面权限',{exact:true}).waitFor()
  assert.equal(await service.getByRole('menuitem',{name:'财务中心'}).count(),0)
  await request('/finance/overview',tokens.CUSTOMER_SERVICE,'GET',undefined,403)
  await service.goto('http://127.0.0.1:8280/admin/finance')
  await service.getByText('暂无此页面权限',{exact:true}).waitFor()
  const freshToken=await login('CUSTOMER_SERVICE')
  await request('/finance/overview',freshToken,'GET',undefined,403)
  assert(socket.connected)
  const again=await connect(freshToken);again.disconnect()
  const noAfterSale=defaults.CUSTOMER_SERVICE.filter(key=>key!=='aftersales.create')
  await setRole('CUSTOMER_SERVICE',noAfterSale,tokens.STORE_MANAGER)
  const reminders=await request('/admin/reminders',tokens.CUSTOMER_SERVICE)
  assert.equal(reminders.allowed.afterSale,false)
  assert(reminders.todos.every(x=>x.kind!=='afterSale'))
  await request('/after-sales',tokens.CUSTOMER_SERVICE,'POST',{},403)
  await setRole('CUSTOMER_SERVICE',custom,tokens.STORE_MANAGER)
  await service.reload()
  await service.getByRole('heading',{name:'财务中心',exact:true}).waitFor()
  assert((await request('/admin/reminders',tokens.CUSTOMER_SERVICE)).allowed.afterSale)
  checks.push('Live permission changes: browser menu and URL guard, API 403, restoration, fresh login, connected/reconnected sockets and reminder filtering all follow current config')
  const logs=await p.operationLog.findMany({where:{operatorId:users.STORE_MANAGER.id,entityType:'ROLE_PERMISSIONS',entityId:'CUSTOMER_SERVICE'},orderBy:{createdAt:'desc'}})
  assert(logs.some(x=>x.detail.added.includes('finance.view')))
  assert(logs.some(x=>x.detail.removed.includes('finance.view')))
  assert(logs.every(x=>Array.isArray(x.detail.before)&&Array.isArray(x.detail.after)&&x.createdAt instanceof Date))
  await manager.getByRole('button',{name:'恢复默认权限',exact:true}).click()
  await manager.getByRole('button',{name:'确认恢复',exact:true}).click()
  await manager.getByText('该角色已恢复默认权限',{exact:true}).waitFor()
  assert.deepEqual((await request('/auth/me',tokens.CUSTOMER_SERVICE)).user.permissions,defaults.CUSTOMER_SERVICE)
  assert.deepEqual((await request('/auth/me',tokens.STORE_MANAGER)).user.permissions,defaults.STORE_MANAGER)
  checks.push('Per-role reset restores exact frozen defaults without touching other roles; audit records operator/target/before/after/additions/removals/time')
  await manager.getByRole('dialog',{name:'恢复客服的默认权限？',exact:true}).waitFor({state:'hidden'})
  await manager.keyboard.press('Escape')
  await manager.getByRole('dialog',{name:'角色权限配置',exact:true}).waitFor({state:'hidden'})
  await manager.getByRole('menuitem',{name:'业务配置'}).click()
  await manager.getByRole('tab',{name:'提醒配置',exact:true}).click()
  const slogan='欢迎来到俱乐部运营管理系统'
  await manager.getByLabel('首页标语',{exact:true}).fill(slogan)
  await manager.getByRole('button',{name:'保存首页标语',exact:true}).click()
  await manager.getByText('管理后台首页标语已保存',{exact:true}).waitFor()
  await setRole('CUSTOMER_SERVICE',[...defaults.CUSTOMER_SERVICE,'dashboard.view'],tokens.STORE_MANAGER)
  await service.goto('http://127.0.0.1:8280/admin/dashboard')
  await service.getByText(slogan,{exact:true}).waitFor()
  const currentGreeting=await service.evaluate(()=>{
    const h=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date()))
    return (h<5?'夜深了':h<12?'早上好':h<14?'中午好':h<18?'下午好':'晚上好')+'，管理员'
  })
  await service.getByRole('heading',{name:currentGreeting,exact:true}).waitFor()
  await request('/settings/admin-dashboard',tokens.SUPER_ADMIN,'PATCH',{slogan:'<script>alert(1)</script>'},400)
  await manager.getByRole('button',{name:'恢复默认标语',exact:true}).click()
  await manager.getByRole('button',{name:'确认恢复',exact:true}).click()
  await manager.getByText('管理后台首页标语已恢复默认',{exact:true}).waitFor()
  await service.reload()
  await service.getByText('这里是俱乐部今天的订单现场。',{exact:true}).waitFor()
  assert.equal((await request('/dashboard/summary',tokens.SUPER_ADMIN)).slogan,'这里是俱乐部今天的订单现场。')
  fs.mkdirSync('output/playwright/dynamic-rbac',{recursive:true})
  await service.screenshot({path:'output/playwright/dynamic-rbac/dashboard.png',animations:'disabled',fullPage:true})
  await manager.getByRole('menuitem',{name:'账号权限'}).click()
  await manager.getByRole('button',{name:'角色权限配置',exact:true}).click()
  await manager.getByRole('tab',{name:'客服',exact:true}).waitFor()
  await manager.screenshot({path:'output/playwright/dynamic-rbac/manager-role-config.png',animations:'disabled',fullPage:true})
  checks.push('Slogan real browser save/reset and HTML rejection; dashboard greeting correct in an America/Los_Angeles browser')
  const result={result:'PASS',checks,defaults,productionTouched:false}
  fs.writeFileSync('output/rbac-dashboard-20260911/specialist-tests.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify({result:'PASS',checks},null,2))
} finally {
  socket?.disconnect();await browser?.close()
  // Restore only explicitly snapshotted configuration keys in the isolated database.
  await p.$transaction(async tx=>{
    await tx.systemSetting.deleteMany({where:{key:{in:keys}}})
    for(const item of originals)await tx.systemSetting.create({data:item})
    if(ids.length){await tx.operationLog.deleteMany({where:{OR:[{operatorId:{in:ids}},{entityType:'ADMIN_USER',entityId:{in:ids}}]}});await tx.user.deleteMany({where:{id:{in:ids}}})}
  })
  await p.$disconnect()
}

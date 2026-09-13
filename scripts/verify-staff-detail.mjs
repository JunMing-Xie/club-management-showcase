import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import { testEnvironment } from './feedback-isolated-env.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const env = testEnvironment()
const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const fixture = JSON.parse(fs.readFileSync('output/client-feedback-20260907/fixtures.json','utf8'))
const output = path.resolve('output/client-feedback-20260907')
const diagnostics = { console: [], page: [], responses: [], overflow: [] }
const browser = await chromium.launch({ headless: true })
async function pageFor(username,width) {
 const user = await prisma.user.findUniqueOrThrow({where:{username},include:{staffProfile:true}})
 const session = { token: jwt.sign({userId:user.id},env.JWT_SECRET,{expiresIn:'2h'}), user: {id:user.id,username:user.username,role:user.role,isActive:user.isActive,staffProfile:user.staffProfile} }
 const context = await browser.newContext({viewport:{width,height:width===390?844:900},timezoneId:'Asia/Shanghai'})
 await context.addInitScript(({token,user})=>{localStorage.setItem('club_order_token',token);localStorage.setItem('club_order_user',JSON.stringify(user))},session)
 const page = await context.newPage()
 page.on('console',m=>{if(['warning','error'].includes(m.type()))diagnostics.console.push(m.text())})
 page.on('pageerror',e=>diagnostics.page.push(e.message))
 page.on('response',r=>{if(r.status()>=400)diagnostics.responses.push(`${r.status()} ${r.url()}`)})
 return page
}
async function go(page,route){await page.goto('http://127.0.0.1:8280'+route,{waitUntil:'networkidle'});await page.waitForTimeout(300)}
async function shot(page,name){
 if(await page.evaluate(()=>Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)>innerWidth+2))diagnostics.overflow.push(name)
 await page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'})
}
const results = []
try {
 const proof = await prisma.orderStaffAssignment.findFirstOrThrow({where:{completionProofs:{some:{}}},include:{staff:{include:{user:{select:{username:true}}}},order:{select:{id:true}}}})
 for (const width of [1440,390,1920]) {
  for (const [kind, username, orderId] of [['history',fixture.staffUsername,fixture.positiveId],['completed',fixture.staffUsername,fixture.negativeId],['proof',proof.staff.user.username,proof.order.id]]) {
   const page = await pageFor(username,width)
   if(width===1920) await page.setViewportSize({width,height:1080})
   await go(page,'/workbench/orders?orderId='+orderId)
   const dialog=page.getByRole('dialog',{name:'订单详情'})
   await dialog.waitFor()
   await page.waitForTimeout(500)
   const metrics=await page.evaluate(()=>{
    const rect=document.querySelector('.workbench-order-detail-drawer-root .ant-drawer-content-wrapper').getBoundingClientRect()
    const right=document.querySelector('.workbench-order-detail-right').getBoundingClientRect()
    return {top:rect.top,bottom:rect.bottom,width:rect.width,viewport:innerHeight,rightTop:right.top,layout:getComputedStyle(document.querySelector('.workbench-order-detail-grid')).display}
   })
   assert(metrics.top>=0 && metrics.bottom<=metrics.viewport+1,JSON.stringify(metrics))
   if(width>900){assert(metrics.width>=1000);assert(metrics.rightTop<metrics.viewport-100);assert.equal(metrics.layout,'grid')}
   else assert.equal(metrics.layout,'block')
   if(kind==='proof') assert(await dialog.locator('.workbench-order-proof-frame img').count()>0)
   if(kind==='history') assert(await dialog.locator('.workbench-order-adjustment-item').count()>0)
   await shot(page,`staff-detail-verified-${kind}-${width}`)
   results.push({kind,width,...metrics})
   await page.context().close()
  }
 }
 assert.deepEqual(diagnostics,{console:[],page:[],responses:[],overflow:[]})
 console.log(JSON.stringify({results,diagnostics}))
} finally {
 fs.writeFileSync(path.join(output,'staff-detail-verified.json'),JSON.stringify({results,diagnostics},null,2))
 await browser.close()
 await prisma.$disconnect()
}

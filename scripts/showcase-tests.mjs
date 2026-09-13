import 'dotenv/config'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { testEnvironment } from './feedback-isolated-env.mjs'

const env = { ...testEnvironment(), NODE_ENV: 'development', HOST: '127.0.0.1', TEST_DIST_ROOT: 'dist' }
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const suites = { smoke: ['scripts/run-client-test-smoke.mjs'], security: ['scripts/verify-auth-version.mjs'], collaboration: ['scripts/verify-multi-preassign.mjs'] }
const suite = process.argv[2] ?? 'smoke'; assert(suites[suite], 'Unknown test suite')
for (const directory of ['output/auth-version-20260912', 'output/multi-preassign-20260912', 'output/workbench-password-20260912']) fs.mkdirSync(directory, { recursive: true })
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`Test subprocess exited ${code}`)))
})
const children = []
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
try {
  try { await fetch('http://127.0.0.1:4210/api/health'); throw Error('Test port 4210 already in use; stop the previous test service') } catch (error) { if (error.message.includes('already in use')) throw error }
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'])
  if (await p.user.count() === 0) await run(['--import', 'tsx', 'server/seed.ts'])
  await p.$disconnect()
  for (const script of ['dist/server/index.js', 'scripts/client-test-proxy.mjs']) children.push(spawn(process.execPath, [script], { env, stdio: 'inherit', windowsHide: true }))
  let ready = false
  // Cold Prisma engine loading on a fresh checkout can exceed 10 seconds.
  const startupDeadline = Date.now() + 60_000
  while (Date.now() < startupDeadline) {
    assert(children.every(child => child.exitCode === null && child.signalCode === null), 'An isolated service exited during startup')
    try { if ((await fetch('http://127.0.0.1:4210/api/health', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert(ready, 'Isolated API did not become healthy within 60 seconds')
  for (const script of suites[suite]) await run([script])
  console.log(`PASS: ${suite}; database club_management_showcase_test only`)
} finally {
  for (const child of children) child.kill()
  await p.$disconnect()
}

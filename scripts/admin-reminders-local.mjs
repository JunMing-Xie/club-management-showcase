import assert from 'node:assert/strict'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { testEnvironment } from './feedback-isolated-env.mjs'

export const env = { ...testEnvironment(), TEST_DIST_ROOT: path.resolve('dist') }
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
assert.equal(env.PORT, '4210')
export const db = () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
if (process.argv[2] === '--serve') {
  const client = db()
  await client.$queryRaw`SELECT 1`
  await client.$disconnect()
  const children = ['dist/server/index.js', 'scripts/client-test-proxy.mjs'].map(script => spawn(process.execPath, [script], { env, stdio: 'inherit', windowsHide: true }))
  const stop = () => children.forEach(child => child.kill())
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.log('Independent database only; API 4100 / local entry 8180. No customer mapping.')
} else if (process.argv[2] === '--smoke') {
  // Run the required npm script with its existing independent-database safety guard.
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const result = spawnSync(process.execPath, [npmCli, 'run', 'test:smoke'], { env, stdio: 'inherit', windowsHide: true })
  process.exitCode = result.status ?? 1
}

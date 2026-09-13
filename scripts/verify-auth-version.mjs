import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { io } from 'socket.io-client'
import { testEnvironment } from './feedback-isolated-env.mjs'

const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const root = 'http://127.0.0.1:4210', users = [], sockets = [], tests = []
const marker = `AUTHV_${Date.now()}`, old = randomBytes(20).toString('hex'), next = randomBytes(20).toString('hex'), reset = randomBytes(20).toString('hex')
const request = async (route, token, body, expected = 200) => {
  const r = await fetch(root + '/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert.equal(r.status, expected, `${route}: ${r.status}`)
  return r.json()
}
const login = async (user, password, expected = 200) => (await request('/auth/login', null, { username: user.username, password }, expected)).token
const me = (token, expected = 200) => request('/auth/me', token, undefined, expected)
const open = async (token, accepted = true) => {
  const s = io(root, { auth: { token }, transports: ['websocket'], reconnection: false, autoConnect: false, timeout: 3000 }); sockets.push(s)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('socket result timed out')), 5000)
    s.once('connect', () => { clearTimeout(timer); if (accepted) resolve(); else reject(Error('revoked socket accepted')) })
    s.once('connect_error', () => { clearTimeout(timer); if (accepted) reject(Error('valid socket rejected')); else resolve() })
    s.connect()
  })
  return s
}
const disconnected = s => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('active old socket not disconnected')), 5000)
  s.once('disconnect', reason => { clearTimeout(timer); if (reason === 'io server disconnect') resolve(); else reject(Error('unexpected disconnect')) })
})
const version = async (user, expected) => assert.equal((await p.user.findUnique({ where: { id: user.id }, select: { authVersion: true } })).authVersion, expected)
try {
  for (const role of ['SUPER_ADMIN', 'STAFF', 'STAFF', 'SUPER_ADMIN', 'STORE_MANAGER']) {
    users.push(await p.user.create({ data: { username: `${marker}_${users.length}`, role, passwordHash: await bcrypt.hash(old, 10), ...(role === 'STAFF' ? { staffProfile: { create: { name: `版本验证演示${users.length}` } } } : {}) }, include: { staffProfile: true } }))
  }
  const [admin, a, b, superTarget, manager] = users
  const adminToken = await login(admin, old), tokenA = await login(a, old), tokenB = await login(a, old), unrelated = await login(b, old)
  assert.equal(jwt.decode(tokenA).authVersion, 0)
  const legacy = jwt.sign({ userId: a.id }, env.JWT_SECRET, { expiresIn: '7d' })
  await me(legacy); const legacySocket = await open(legacy)
  for (const bad of [null, -1, '0', 0.5, 1]) {
    const token = jwt.sign({ userId: a.id, authVersion: bad }, env.JWT_SECRET, { expiresIn: '7d' })
    await me(token, 401); await open(token, false)
  }
  tests.push('Legacy tokens only map to zero; malformed/future versions rejected by HTTP and WebSocket')
  const socketA = await open(tokenA), socketB = await open(tokenB), adminSocket = await open(adminToken), unrelatedSocket = await open(unrelated)
  const stopped = Promise.all([socketA, socketB, legacySocket].map(disconnected))
  await request('/workbench/change-password', tokenA, { currentPassword: old, newPassword: next, confirmPassword: next })
  await stopped; await version(a, 1)
  for (const token of [tokenA, tokenB, legacy]) { await me(token, 401); await open(token, false) }
  await login(a, old, 401)
  const fresh = await login(a, next); assert.equal(jwt.decode(fresh).authVersion, 1); await me(fresh)
  const freshSocket = await open(fresh)
  assert(adminSocket.connected && unrelatedSocket.connected); await me(adminToken); await me(unrelated)
  tests.push('Employee A/B and legacy tokens revoked; active sockets disconnected; new password HTTP/socket succeeds; other identities remain valid')
  const stoppedReset = disconnected(freshSocket)
  await request(`/staff/${a.staffProfile.id}/reset-password`, adminToken, { password: reset })
  await stoppedReset; await version(a, 2); await me(fresh, 401); await open(fresh, false); await login(a, next, 401)
  const resetToken = await login(a, reset); await me(resetToken); await open(resetToken)
  tests.push('Administrator employee reset atomically increments version and revokes prior credentials')
  for (const target of [superTarget, manager]) {
    const prior = await login(target, old), live = await open(prior), stop = disconnected(live)
    await request(`/admin/users/${target.id}/reset-password`, adminToken, { password: next })
    await stop; await version(target, 1); await me(prior, 401); await open(prior, false); await login(target, old, 401)
    const renewed = await login(target, next); await me(renewed); await open(renewed)
  }
  tests.push('SUPER_ADMIN and ordinary administrator resets revoke old HTTP/socket tokens without role changes')
  const before = await p.user.findUnique({ where: { id: a.id }, include: { staffProfile: true } })
  const username = `${marker}_renamed`
  await request('/workbench/change-username', resetToken, { currentPassword: reset, newUsername: username })
  const after = await p.user.findUnique({ where: { id: a.id }, include: { staffProfile: true } })
  for (const field of ['id', 'role', 'adminRoleId', 'isActive', 'authVersion', 'passwordHash']) assert.equal(after[field], before[field])
  assert.deepEqual(after.staffProfile, before.staffProfile)
  await me(resetToken); await open(resetToken); await login(a, reset, 401); await login({ username }, reset)
  tests.push('Username-only change preserves version, password, stable identity/profile; old username fails')
  const logs = await p.operationLog.findMany({ where: { operatorId: { in: users.map(u => u.id) } } })
  for (const u of users) { const actual = await p.user.findUnique({ where: { id: u.id } }); assert.equal(actual.role, u.role); assert.equal(actual.adminRoleId, u.adminRoleId) }
  for (const secret of [old, next, reset, tokenA, adminToken, before.passwordHash]) assert(!JSON.stringify(logs).includes(secret))
  assert.equal(logs.filter(l => l.action === 'STAFF_CHANGE_PASSWORD').length, 1)
  assert.equal(logs.filter(l => l.action === 'RESET_PASSWORD').length, 3)
  tests.push('All audit entries retained without password/hash/token; account roles unchanged')
  // A self-reset of the authenticated super-admin must also invalidate its authorizing token.
  const adminStopped = disconnected(adminSocket)
  await request(`/admin/users/${admin.id}/reset-password`, adminToken, { password: next })
  await adminStopped; await me(adminToken, 401); await open(adminToken, false); await version(admin, 1)
  await me(await login(admin, next))
  tests.push('SUPER_ADMIN resetting own password invalidates its currently authorizing token')
  fs.mkdirSync('output/auth-version-20260912', { recursive: true })
  fs.writeFileSync('output/auth-version-20260912/tests.json', JSON.stringify({ result: 'PASS', tests, isolatedDatabase: true }, null, 2))
  console.log(JSON.stringify({ result: 'PASS', checks: tests.length }))
} finally {
  for (const s of sockets) s.disconnect()
  await new Promise(resolve => setTimeout(resolve, 300))
  const ids = users.map(u => u.id)
  await p.operationLog.deleteMany({ where: { operatorId: { in: ids } } })
  await p.staffProfile.deleteMany({ where: { userId: { in: ids } } })
  await p.user.deleteMany({ where: { id: { in: ids } } })
  await p.$disconnect()
}

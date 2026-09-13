import { PrismaClient } from '@prisma/client'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import bcrypt from 'bcryptjs'
import { randomBytes, createHash } from 'node:crypto'
import { testEnvironment } from './feedback-isolated-env.mjs'
const env = testEnvironment()
assert.equal(new URL(env.DATABASE_URL).pathname, '/club_management_showcase_test')
assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1')
const p = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const file = 'output/workbench-password-20260912/restart-fixture.json'
const stable = profile => { const { presence: _presence, updatedAt: _updatedAt, ...rest } = profile; return createHash('sha256').update(JSON.stringify(rest)).digest('hex') }
try {
  if (process.argv[2] === 'prepare') {
    const u = await p.user.create({ data: { username: `DEMO_RESTART_${Date.now()}`, passwordHash: await bcrypt.hash(randomBytes(25).toString('hex'), 10), role: 'STAFF', staffProfile: { create: { name: '重启离线专项演示', presence: 'ONLINE', status: 'BUSY', accepting: 'PAUSED', commissionRateBps: 3210 } } }, include: { staffProfile: true } })
    fs.writeFileSync(file, JSON.stringify({ userId: u.id, profileHash: stable(u.staffProfile) }))
    console.log('Prepared isolated stale ONLINE fixture (no login)')
  } else {
    const f = JSON.parse(fs.readFileSync(file))
    const profile = await p.staffProfile.findUnique({ where: { userId: f.userId } })
    assert.equal(profile.presence, 'OFFLINE'); assert.equal(stable(profile), f.profileHash)
    await p.staffProfile.delete({ where: { userId: f.userId } }); await p.user.delete({ where: { id: f.userId } })
    fs.writeFileSync('output/workbench-password-20260912/restart-test.json', JSON.stringify({ result: 'PASS', test: 'F: startup clears stale ONLINE; status/accepting/profile/commission unchanged' }))
    console.log('PASS: restart clears stale presence without changing other staff fields')
  }
} finally { await p.$disconnect() }

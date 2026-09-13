import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const databaseUrl = process.env.DATABASE_URL ?? ''
const databaseName = (() => {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '')
  } catch {
    return ''
  }
})()

const isolated = databaseName === 'club_management_showcase_test' && process.env.BASE_URL === 'http://127.0.0.1:4210/api'
if (databaseName !== 'club_management_showcase_test' && !isolated) {
  throw new Error('安全保护：客户专项 smoke 只允许连接 club_management_showcase_test')
}

const prisma = new PrismaClient()
const usernames = ['admin', 'lin', 'chen']
const originalUsers = await prisma.user.findMany({
  where: { username: { in: usernames } },
  select: { id: true, username: true, passwordHash: true },
})

if (originalUsers.length !== usernames.length) {
  await prisma.$disconnect()
  throw new Error('测试库缺少 admin、lin 或 chen 测试账号')
}

const temporaryPassword = `Smoke-${randomBytes(18).toString('base64url')}!`
const temporaryHash = await bcrypt.hash(temporaryPassword, 10)
let exitCode = 0

try {
  await prisma.user.updateMany({
    where: { username: { in: usernames } },
    data: { passwordHash: temporaryHash },
  })

  for (const script of ['scripts/final-flow-test.mjs', 'scripts/feedback-flow-test.mjs']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_ADMIN_PASSWORD: temporaryPassword,
        TEST_STAFF_PASSWORD: temporaryPassword,
      },
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      exitCode = result.status ?? 1
      break
    }
  }
} finally {
  await prisma.$transaction(
    originalUsers.map((user) => prisma.user.update({ where: { id: user.id }, data: { passwordHash: user.passwordHash } })),
  )
  await prisma.$disconnect()
}

process.exitCode = exitCode

import http from 'node:http'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { Server } from 'socket.io'
import { verifyToken } from './auth.js'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { router } from './routes.js'
import { config } from './config.js'
import { prisma } from './prisma.js'
import { setRealtimeServer } from './realtime.js'
import { HttpError } from './utils.js'
import { attachStaffPresence, reconcileStaffPresence, resetStaffPresence } from './staff-presence.js'

const app = express()
const httpServer = http.createServer(app)
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false }))
const io = new Server(httpServer, {
  pingInterval: 10000,
  pingTimeout: 20000,
  cors: { origin: config.clientOrigin, credentials: true },
})

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token as string | undefined
    if (!token) return next(new Error('未登录'))
    const payload = verifyToken(token)
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { staffProfile: true } })
    if (!user || !user.isActive || (user.role === 'STAFF' && (!user.staffProfile || user.staffProfile.accountStatus !== 'NORMAL'))) return next(new Error('账号不可用'))
    if (user.authVersion !== payload.authVersion) return next(new Error('登录已失效'))
    socket.data.userId = user.id
    socket.data.authVersion = payload.authVersion
    socket.data.role = user.role
    socket.data.staffProfileId = user.staffProfile?.id
    next()
  } catch {
    next(new Error('登录已失效'))
  }
})

io.on('connection', async (socket) => {
  // Close the race between handshake validation and a committed password reset.
  try {
    const user = await prisma.user.findUnique({ where: { id: socket.data.userId }, select: { authVersion: true, isActive: true } })
    if (!socket.connected) return
    if (!user?.isActive || user.authVersion !== socket.data.authVersion) { socket.disconnect(true); return }
  } catch { socket.disconnect(true); return }
  // Events only announce changes; business data is always re-requested under current permissions.
  if (socket.data.role !== 'STAFF') socket.join('admins')
  if (socket.data.staffProfileId) socket.join(`staff:${socket.data.staffProfileId}`)
  attachStaffPresence(socket)
})
setRealtimeServer(io)

app.use(cors({ origin: config.clientOrigin, credentials: true }))
app.use(express.json({ limit: '2mb' }))
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'club-order-management' }))
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '登录尝试次数过多，请稍后再试' },
})
app.use('/api/auth/login', loginLimiter)
app.use('/api', router)
app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }))
app.use((_req, res) => res.status(404).json({ message: '页面不存在' }))
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ message: error.message })
    return
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ message: '请求数据格式不正确' })
    return
  }
  if (error instanceof ZodError) {
    res.status(400).json({ message: '提交数据不符合要求，请检查后重试' })
    return
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      res.status(409).json({ message: '数据已存在，请更换后重试' })
      return
    }
    if (error.code === 'P2025') {
      res.status(404).json({ message: '要操作的数据不存在' })
      return
    }
    if (error.code === 'P2034') {
      res.status(409).json({ message: '订单状态刚刚发生变化，请刷新后重试' })
      return
    }
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ message: '单张图片不能超过 5MB' })
      return
    }
    if (code === 'LIMIT_UNEXPECTED_FILE' || code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({ message: '完单凭证最多上传 6 张图片' })
      return
    }
  }
  console.error(error)
  res.status(500).json({ message: '服务器暂时无法处理请求' })
})

await resetStaffPresence()
const presenceTimer = setInterval(() => { void reconcileStaffPresence().catch(() => console.error('员工在线状态定时核对失败')) }, 15000)
presenceTimer.unref()
httpServer.listen(config.port, config.host, () => {
  console.log(`Club order API listening on http://${config.host}:${config.port}`)
})

const shutdown = async () => {
  clearInterval(presenceTimer)
  io.disconnectSockets(true)
  await resetStaffPresence()
  io.close(async () => { await prisma.$disconnect(); process.exit(0) })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

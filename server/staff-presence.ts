import type { Socket } from 'socket.io'
import { prisma } from './prisma.js'
import { notifyChange } from './realtime.js'

// The production API is a single PM2 fork. Identity is stable userId, never username.
const connections = new Map<string, { staffId: string; sockets: Set<string> }>()
let writes = Promise.resolve()
export const currentStaffPresence = (userId: string) => connections.get(userId)?.sockets.size ? 'ONLINE' as const : 'OFFLINE' as const

const synchronize = (userId: string, staffId: string) => {
  writes = writes.then(async () => {
    const presence = currentStaffPresence(userId)
    const result = await prisma.staffProfile.updateMany({ where: { id: staffId, userId, presence: { not: presence } }, data: { presence } })
    if (result.count) notifyChange([staffId])
  }).catch(() => { console.error('员工在线状态同步失败，将在连接变化或定时核对时重试') })
  return writes
}

export const attachStaffPresence = (socket: Socket) => {
  if (socket.data.role !== 'STAFF' || socket.handshake.auth.portal !== 'workbench' || !socket.data.staffProfileId) return
  const userId = socket.data.userId as string, staffId = socket.data.staffProfileId as string
  const entry = connections.get(userId) ?? { staffId, sockets: new Set<string>() }
  entry.sockets.add(socket.id)
  connections.set(userId, entry)
  void synchronize(userId, staffId)
  socket.on('disconnect', () => {
    entry.sockets.delete(socket.id)
    if (!entry.sockets.size && connections.get(userId) === entry) connections.delete(userId)
    void synchronize(userId, staffId)
  })
}

export const resetStaffPresence = async () => {
  connections.clear()
  await writes
  await prisma.staffProfile.updateMany({ where: { presence: 'ONLINE' }, data: { presence: 'OFFLINE' } })
}

export const reconcileStaffPresence = async () => {
  // Also repairs a failed disconnect write without waiting for another login.
  const rows = await prisma.staffProfile.findMany({ where: { OR: [{ presence: 'ONLINE' }, { userId: { in: [...connections.keys()] } }] }, select: { id: true, userId: true } })
  for (const row of rows) await synchronize(row.userId, row.id)
}

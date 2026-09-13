import type { Server } from 'socket.io'

let io: Server | null = null

export const setRealtimeServer = (server: Server) => {
  io = server
}

// Single-process PM2 deployment: revoke established connections after commit.
export const revokeUserSockets = (userId: string, authVersion: number) => {
  for (const socket of io?.sockets.sockets.values() ?? []) {
    if (socket.data.userId === userId && socket.data.authVersion < authVersion) socket.disconnect(true)
  }
}

export const notifyChange = (staffIds: Array<string | null | undefined> = []) => {
  io?.to('admins').emit('data:changed')
  for (const staffId of new Set(staffIds.filter(Boolean))) {
    io?.to(`staff:${staffId}`).emit('data:changed')
  }
}

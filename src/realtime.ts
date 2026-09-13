import { useEffect } from 'react'
import { io } from 'socket.io-client'
import { authScope, getAuthToken } from './auth-storage'

export const useRealtimeRefresh = (refresh: () => void) => {
  useEffect(() => {
    const token = getAuthToken()
    if (!token) return
    const socket = io({ auth: { token, portal: authScope() } })
    socket.on('data:changed', refresh)
    return () => { socket.disconnect() }
  }, [refresh])
}

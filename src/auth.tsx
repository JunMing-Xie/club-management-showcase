import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'
import { useLocation } from 'react-router-dom'
import { getAuthToken, getAuthUser, saveAuthUser, saveAuthSession, clearAuthSession } from './auth-storage'
import { AuthContext } from './auth-context'
import type { User } from './types'
import { io } from 'socket.io-client'

const storedUser = getAuthUser

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(storedUser)
  const [loading, setLoading] = useState(true)
  const scope = useLocation().pathname.startsWith('/workbench') ? 'workbench' : 'admin'

  useEffect(() => {
    let active = true
    setLoading(true)
    setUser(getAuthUser())
    const token = getAuthToken()
    if (!token) {
      setLoading(false)
      return
    }
    api.get<{ user: User }>('/auth/me')
      .then(({ data }) => {
        if (!active) return
        setUser(data.user)
        saveAuthUser(data.user)
      })
      .catch(() => {
        if (!active) return
        clearAuthSession()
        setUser(null)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [scope])

  useEffect(() => {
    const handleExpired = () => setUser(null)
    window.addEventListener('club-order-auth-expired', handleExpired)
    return () => window.removeEventListener('club-order-auth-expired', handleExpired)
  }, [])

  const login = useCallback(async (username: string, password: string, expectedRole?: 'ADMIN' | 'STAFF') => {
    const { data } = await api.post<{ token: string; user: User }>('/auth/login', { username, password })
    if (expectedRole === 'STAFF' && data.user.role !== 'STAFF') throw new Error('当前账号不属于该入口')
    if (expectedRole === 'ADMIN' && data.user.role === 'STAFF') throw new Error('当前账号不属于该入口')
    saveAuthSession(data.token, data.user)
    setUser(data.user)
    return data.user
  }, [])

  const logout = useCallback(() => {
    clearAuthSession()
    setUser(null)
  }, [])

  const refreshUser = useCallback(async () => {
    const { data } = await api.get<{ user: User }>('/auth/me')
    setUser(data.user)
    saveAuthUser(data.user)
  }, [])

  useEffect(() => {
    const synchronize = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; role: User['role']; permissions: string[] }>).detail
      setUser((current) => {
        if (!current || current.id !== detail.userId || (current.role === detail.role && JSON.stringify(current.permissions) === JSON.stringify(detail.permissions))) return current
        const next = { ...current, role: detail.role, permissions: detail.permissions }
        saveAuthUser(next)
        return next
      })
    }
    window.addEventListener('club-order-permissions', synchronize)
    return () => window.removeEventListener('club-order-permissions', synchronize)
  }, [])

  useEffect(() => {
    const token = getAuthToken()
    if (!token || !user?.id || scope !== 'admin') return
    const socket = io({ auth: { token } })
    const refresh = () => { void refreshUser().catch(() => {}) }
    socket.on('connect', refresh)
    socket.on('data:changed', refresh)
    window.addEventListener('focus', refresh)
    return () => { socket.disconnect(); window.removeEventListener('focus', refresh) }
  }, [user?.id, scope, refreshUser])

  const value = useMemo(() => ({ user, loading, login, logout, refreshUser }), [user, loading, login, logout, refreshUser])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

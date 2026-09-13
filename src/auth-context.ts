import { createContext, useContext } from 'react'
import type { User } from './types'

export type AuthContextValue = {
  user: User | null
  loading: boolean
  login: (username: string, password: string, expectedRole?: 'ADMIN' | 'STAFF') => Promise<User>
  logout: () => void
  refreshUser: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export const useAuth = () => {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return value
}

import type { User } from './types'

export const authScope = () => window.location.pathname.startsWith('/workbench') ? 'workbench' : 'admin'
const key = (name: 'token' | 'user') => `club_order_${authScope()}_${name}`
const matchesScope = (user: User) => (user.role === 'STAFF') === (authScope() === 'workbench')

// Retain an existing login only in its matching portal. The two portals never
// read each other's credentials after migration.
const migrateLegacy = () => {
  if (localStorage.getItem(key('token'))) return
  try {
    const token = localStorage.getItem('club_order_token')
    const raw = localStorage.getItem('club_order_user')
    if (token && raw && matchesScope(JSON.parse(raw) as User)) {
      localStorage.setItem(key('user'), raw)
      localStorage.setItem(key('token'), token)
      localStorage.removeItem('club_order_token')
      localStorage.removeItem('club_order_user')
    }
  } catch { /* Invalid legacy storage is treated as signed out. */ }
}

export const getAuthToken = () => { migrateLegacy(); return localStorage.getItem(key('token')) }
export const getAuthUser = (): User | null => {
  migrateLegacy()
  try {
    const raw = localStorage.getItem(key('user'))
    const user = raw ? JSON.parse(raw) as User : null
    return user && matchesScope(user) ? user : null
  } catch { return null }
}
export const saveAuthUser = (user: User) => localStorage.setItem(key('user'), JSON.stringify(user))
export const saveAuthSession = (token: string, user: User) => {
  saveAuthUser(user)
  localStorage.setItem(key('token'), token)
}
export const clearAuthSession = (scope: 'admin' | 'workbench' = authScope()) => {
  localStorage.removeItem(`club_order_${scope}_token`)
  localStorage.removeItem(`club_order_${scope}_user`)
}

import axios from 'axios'
import { getAuthToken, clearAuthSession } from './auth-storage'

const syncPermissions = (headers: Record<string, unknown> | undefined) => {
  const raw = headers?.['x-user-permissions']
  const userId = headers?.['x-user-id']
  const role = headers?.['x-user-role']
  if (typeof raw !== 'string' || typeof userId !== 'string' || typeof role !== 'string') return
  try {
    const permissions: unknown = JSON.parse(raw)
    if (Array.isArray(permissions) && permissions.every((key) => typeof key === 'string')) {
      window.dispatchEvent(new CustomEvent('club-order-permissions', { detail: { userId, role, permissions } }))
    }
  } catch { /* Ignore malformed response metadata. Authorization remains server-side. */ }
}

export const api = axios.create({ baseURL: '/api', timeout: 15000 })

api.interceptors.request.use((config) => {
  const token = getAuthToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (response) => { syncPermissions(response.headers); return response },
  (error) => {
    syncPermissions(error.response?.headers)
    if (error.response?.status === 401) {
      clearAuthSession()
      window.dispatchEvent(new Event('club-order-auth-expired'))
    }
    return Promise.reject(error)
  },
)

export const getErrorMessage = (error: unknown, fallback = '操作失败，请稍后重试') => {
  if (axios.isAxiosError(error)) return error.response?.data?.message ?? fallback
  if (error instanceof Error) return error.message
  return fallback
}

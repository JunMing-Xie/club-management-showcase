import type { Permission } from './role-permissions.js'
import type { UserRole } from '@prisma/client'

export type AuthUser = {
  id: string
  username: string
  role: UserRole
  permissions?: readonly Permission[]
  staffProfileId?: string
  name?: string
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

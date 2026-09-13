import type { NextFunction, Request, RequestHandler, Response } from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { UserRole } from '@prisma/client'
import { prisma } from './prisma.js'
import { config } from './config.js'
import type { AuthUser } from './types.js'

export const verifyToken = (token: string): { userId: string; authVersion: number } => {
  const payload = jwt.verify(token, config.jwtSecret)
  if (typeof payload === 'string' || typeof payload.userId !== 'string' || !payload.userId) throw new Error('Invalid token')
  // Tokens issued before this migration belong only to version zero.
  const authVersion = payload.authVersion === undefined ? 0 : payload.authVersion
  if (!Number.isSafeInteger(authVersion) || authVersion < 0) throw new Error('Invalid token version')
  return { userId: payload.userId, authVersion }
}

export { defaultRolePermissions as rolePermissions } from './role-permissions.js'
import { type Permission } from './role-permissions.js'
import { getUserPermissions } from './admin-roles.js'
export type { Permission } from './role-permissions.js'

export const hasPermission = (user: Pick<AuthUser, 'role' | 'permissions'>, permission: Permission) => user.role === UserRole.SUPER_ADMIN || (user.permissions ?? []).includes(permission)

export const hashPassword = (password: string) => bcrypt.hash(password, 10)

export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash)

export const createToken = (user: Pick<AuthUser, 'id'> & { authVersion: number }) => jwt.sign({ userId: user.id, authVersion: user.authVersion }, config.jwtSecret, { expiresIn: '7d' })

export const userView = (user: {
  id: string
  username: string
  role: UserRole
  isActive: boolean
  adminRoleId?: string | null
  adminRole?: { id: string; name: string; isActive: boolean } | null
  staffProfile?: {
    id: string
    name: string
    status: 'IDLE' | 'BUSY'
    presence?: 'ONLINE' | 'OFFLINE'
    accepting?: 'ACCEPTING' | 'PAUSED'
    selfAccepting?: 'ACCEPTING' | 'PAUSED'
    accountStatus?: 'NORMAL' | 'FROZEN' | 'RETIRED'
    tierId?: string | null
  } | null
}) => ({
  id: user.id,
  username: user.username,
  role: user.role,
  isActive: user.isActive,
  adminRoleId: user.adminRoleId ?? null,
  adminRole: user.adminRole ? { id: user.adminRole.id, name: user.adminRole.name, isActive: user.adminRole.isActive } : null,
  staffProfile: user.staffProfile
    ? {
        id: user.staffProfile.id,
        name: user.staffProfile.name,
        status: user.staffProfile.status,
        presence: user.staffProfile.presence ?? 'OFFLINE',
        accepting: user.staffProfile.accepting ?? 'ACCEPTING',
        selfAccepting: user.staffProfile.selfAccepting ?? 'ACCEPTING',
        accountStatus: user.staffProfile.accountStatus ?? 'NORMAL',
        tierId: user.staffProfile.tierId ?? null,
      }
    : null,
})

export const authMiddleware: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    if (!token) {
      res.status(401).json({ message: '请先登录' })
      return
    }
    const payload = verifyToken(token)
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { staffProfile: true } })
    if (!user || !user.isActive || user.authVersion !== payload.authVersion) {
      res.status(401).json({ message: '账号不可用，请重新登录' })
      return
    }
    if (user.role === UserRole.STAFF && (!user.staffProfile || user.staffProfile.accountStatus !== 'NORMAL')) {
      res.status(403).json({ message: '员工账号当前不可用，请联系管理员' })
      return
    }
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      staffProfileId: user.staffProfile?.id,
      name: user.staffProfile?.name,
    }
    req.user.permissions = await getUserPermissions(user)
    res.setHeader('X-User-Permissions', JSON.stringify(req.user.permissions))
    res.setHeader('X-User-Id', user.id)
    res.setHeader('X-User-Role', user.role)
    next()
  } catch {
    res.status(401).json({ message: '登录已失效，请重新登录' })
  }
}

export const requireRole = (...roles: AuthUser['role'][]): RequestHandler => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    res.status(403).json({ message: '没有权限执行此操作' })
    return
  }
  next()
}

export const requirePermission = (...permissions: Permission[]): RequestHandler => (req, res, next) => {
  if (!req.user || !permissions.every((permission) => hasPermission(req.user!, permission))) {
    res.status(403).json({ message: '当前账号没有执行此操作的权限' })
    return
  }
  next()
}

export const isAdminRole = (role: UserRole | undefined) => Boolean(role && role !== UserRole.STAFF)

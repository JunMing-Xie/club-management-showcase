import { randomUUID } from 'node:crypto'
import { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './prisma.js'
import { allPermissions, assertAccountScope, getRolePermissions, type Permission } from './role-permissions.js'
import { ensure, logOperation } from './utils.js'

type Client = Prisma.TransactionClient
export const delegatedPermissions = allPermissions.filter(key => !['rbac.manage', 'dispatch.view', 'settlement.view'].includes(key))
export const adminRoleView = { id: true, name: true, code: true, description: true, authorityLevel: true, isSystem: true, isActive: true, permissions: true, createdBy: true, createdAt: true, updatedAt: true } as const
const reserved = ['超级管理员', '超级管理', '超管', '系统管理员', '管理员', '店长', '客服', '派单员', '财务', 'superadmin', 'storemanager', 'admin', 'root', 'staff', 'customadmin', 'customerservice', 'dispatcher', 'finance']
const nameSchema = z.string().trim().min(1, '请输入职位名称').max(40, '职位名称最多 40 个字符').refine(name => !reserved.includes(name.normalize('NFKC').toLowerCase().replace(/[\s_-]/g, '')), '该名称属于系统保留名称')
export const adminRoleSchema = z.object({ name: nameSchema, description: z.string().trim().max(500).optional(), permissions: z.array(z.enum(allPermissions)).max(allPermissions.length), isActive: z.boolean().optional() }).strict()
export const adminRoleUpdateSchema = adminRoleSchema.partial().refine(body => Object.keys(body).length > 0, '请提供需要修改的字段')

export const getUserPermissions = async (user: { role: UserRole; adminRoleId?: string | null }, tx: Client = prisma): Promise<Permission[]> => {
  if (user.role !== UserRole.CUSTOM_ADMIN) return getRolePermissions(user.role, tx)
  if (!user.adminRoleId) return []
  const role = await tx.adminRole.findUnique({ where: { id: user.adminRoleId } })
  if (!role || role.isSystem || role.authorityLevel < 2 || !Array.isArray(role.permissions)) return []
  // Disabling a job only prevents new assignments; existing members keep their template.
  return delegatedPermissions.filter(key => (role.permissions as Prisma.JsonArray).includes(key))
}

export const checkRoleOperator = async (tx: Client, operatorId: string) => {
  const actor = await tx.user.findUnique({ where: { id: operatorId }, select: { role: true, isActive: true } })
  ensure(actor?.isActive && [UserRole.SUPER_ADMIN, UserRole.STORE_MANAGER].includes(actor.role as 'SUPER_ADMIN' | 'STORE_MANAGER'), 403, '无权管理后台职位')
  const own = await getRolePermissions(actor.role, tx)
  ensure(own.includes('rbac.manage'), 403, '无权管理后台职位')
  return { ...actor, permissions: own }
}

export const assertDelegation = (actor: { role: UserRole; permissions: readonly Permission[] }, requested: readonly string[]) => {
  ensure(requested.every(key => delegatedPermissions.includes(key as Permission) && (actor.role === UserRole.SUPER_ADMIN || actor.permissions.includes(key as Permission))), 403, '不能授予管理层专属权限或超出本人可下放范围的权限')
}

export const validateJobAssignment = async (tx: Client, operatorId: string, role: UserRole, adminRoleId: string | null | undefined, previousId?: string | null) => {
  const actor = await checkRoleOperator(tx, operatorId)
  assertAccountScope(actor.role, role)
  if (role !== UserRole.CUSTOM_ADMIN) {
    ensure(!adminRoleId, 400, '系统角色不能同时关联自定义职位')
    return null
  }
  ensure(adminRoleId, 400, '请选择自定义职位')
  const job = await tx.adminRole.findUnique({ where: { id: adminRoleId } })
  ensure(job && !job.isSystem && job.authorityLevel >= 2, 400, '自定义职位不存在或层级无效')
  ensure(job.isActive || previousId === job.id, 400, '该职位已停用，不能分配给新账号')
  assertDelegation(actor, await getUserPermissions({ role, adminRoleId }, tx))
  return job.id
}

export const saveAdminRole = async (operatorId: string, id: string | undefined, body: z.infer<typeof adminRoleUpdateSchema>) => prisma.$transaction(async tx => {
  const actor = await checkRoleOperator(tx, operatorId)
  const before = id ? await tx.adminRole.findUnique({ where: { id } }) : null
  ensure(!id || before, 404, '职位不存在')
  ensure(!before || (!before.isSystem && before.authorityLevel >= 2), 403, '系统职位不可通过此入口修改')
  if (before) assertDelegation(actor, await getUserPermissions({ role: UserRole.CUSTOM_ADMIN, adminRoleId: before.id }, tx))
  const permissions = body.permissions === undefined ? before?.permissions as string[] ?? [] : allPermissions.filter(key => body.permissions!.includes(key))
  assertDelegation(actor, permissions)
  if (body.name) {
    const duplicate = await tx.adminRole.findUnique({ where: { name: body.name } })
    ensure(!duplicate || duplicate.id === id, 409, '职位名称已存在，请使用其他名称')
  }
  const data = { ...body, permissions }
  const after = before
    ? await tx.adminRole.update({ where: { id: before.id }, data })
    : await tx.adminRole.create({ data: { ...data, name: body.name!, code: `job_${randomUUID().replaceAll('-', '')}`, createdBy: operatorId, authorityLevel: 2, isSystem: false } })
  const oldPermissions = before?.permissions as string[] ?? []
  await logOperation(tx, { operatorId, action: before ? 'UPDATE_ADMIN_ROLE' : 'CREATE_ADMIN_ROLE', entityType: 'ADMIN_ROLE', entityId: after.id, detail: { operatorId, targetRoleId: after.id, before, after, addedPermissions: permissions.filter(key => !oldPermissions.includes(key)), removedPermissions: oldPermissions.filter(key => !permissions.includes(key)), time: new Date().toISOString() } as unknown as Prisma.InputJsonObject })
  return after
}, { isolationLevel: 'Serializable' })

export const deleteAdminRole = async (operatorId: string, id: string) => prisma.$transaction(async tx => {
  const actor = await checkRoleOperator(tx, operatorId)
  const before = await tx.adminRole.findUnique({ where: { id } })
  ensure(before, 404, '职位不存在')
  ensure(!before.isSystem && before.authorityLevel >= 2, 403, '系统职位不可删除')
  assertDelegation(actor, await getUserPermissions({ role: UserRole.CUSTOM_ADMIN, adminRoleId: id }, tx))
  const count = await tx.user.count({ where: { adminRoleId: id } })
  ensure(count === 0, 409, `当前仍有 ${count} 个管理账号使用该职位，请先调整账号职位后再删除。`)
  await tx.adminRole.delete({ where: { id } })
  await logOperation(tx, { operatorId, action: 'DELETE_ADMIN_ROLE', entityType: 'ADMIN_ROLE', entityId: id, detail: { operatorId, targetRoleId: id, before, after: null, addedPermissions: [], removedPermissions: before.permissions, time: new Date().toISOString() } as unknown as Prisma.InputJsonObject })
}, { isolationLevel: 'Serializable' })

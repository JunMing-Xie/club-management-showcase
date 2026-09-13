import { UserRole, type Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'
import { ensure, logOperation } from './utils.js'

export const configurableRoles = ['STORE_MANAGER', 'CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE'] as const
export type ConfigurableRole = typeof configurableRoles[number]
export const rolePermissionKey = (role: ConfigurableRole) => `role_permissions_${role}`

export type Permission =
  | 'dashboard.view'
  | 'orders.view'
  | 'orders.create'
  | 'orders.edit'
  | 'orders.review'
  | 'orders.assign'
  | 'orders.lock'
  | 'orders.cancel'
  | 'staff.view'
  | 'staff.manage'
  | 'customers.view'
  | 'customers.manage'
  | 'customers.recharge'
  | 'funds.adjust'
  | 'stats.view'
  | 'finance.view'
  | 'settlement.view'
  | 'settlement.manage'
  | 'aftersales.view'
  | 'aftersales.manage'
  | 'aftersales.create'
  | 'dispatch.self'
  | 'dispatch.view'
  | 'packages.manage'
  | 'activities.manage'
  | 'coupons.manage'
  | 'campaigns.manage'
  | 'notices.manage'
  | 'imports.manage'
  | 'rbac.manage'

export const allPermissions: Permission[] = [
  'dashboard.view', 'orders.view', 'orders.create', 'orders.edit', 'orders.review', 'orders.assign', 'orders.lock', 'orders.cancel',
  'staff.view', 'staff.manage', 'customers.view', 'customers.manage', 'customers.recharge', 'funds.adjust', 'stats.view',
  'finance.view', 'settlement.view', 'settlement.manage', 'aftersales.view', 'aftersales.manage',
  'packages.manage', 'activities.manage', 'coupons.manage', 'campaigns.manage', 'notices.manage', 'imports.manage', 'rbac.manage', 'aftersales.create', 'dispatch.self', 'dispatch.view',
]

export const defaultRolePermissions: Record<UserRole, readonly Permission[]> = {
  [UserRole.SUPER_ADMIN]: allPermissions,
  // Store managers have all default capabilities, bounded by the enforced role hierarchy.
  [UserRole.STORE_MANAGER]: allPermissions,
  [UserRole.CUSTOMER_SERVICE]: [
    'orders.view', 'orders.create', 'orders.assign', 'orders.review', 'aftersales.view', 'aftersales.create', 'dispatch.self',
  ],
  [UserRole.DISPATCHER]: ['orders.view', 'orders.create', 'orders.assign', 'orders.review', 'aftersales.view', 'aftersales.create', 'dispatch.self'],
  [UserRole.FINANCE]: ['finance.view', 'settlement.view', 'settlement.manage'],
  [UserRole.STAFF]: [],
  [UserRole.CUSTOM_ADMIN]: [],
}


export const permissionCatalog: Array<{ key: Permission; group: string; label: string; description: string; configurable?: boolean }> = [
  { key: 'dashboard.view', group: '经营概览', label: '经营概览查看', description: '查看首页经营数据和提醒入口。' },
  { key: 'orders.view', group: '订单', label: '订单查看', description: '查看订单列表、详情、完单凭证、操作记录和导出订单。' },
  { key: 'orders.create', group: '订单', label: '创建订单', description: '新增订单；表单客户选择还需客户查看权限。' },
  { key: 'orders.edit', group: '订单', label: '订单编辑与金额调整', description: '编辑订单和登记完单后净额调整；不包含完单审核。' },
  { key: 'orders.review', group: '订单', label: '完单审核', description: '验收员工完单凭证，通过或退回现有完单审核；需配合订单查看。' },
  { key: 'aftersales.create', group: '售后', label: '创建售后', description: '为已完成审核结算的订单发起售后，不包含处理和赔付；需配合订单和售后查看。' },
  { key: 'dispatch.self', group: '派单统计', label: '查看我的派单统计', description: '在订单管理查看本人派单数量和明细，不能查询其他人。' },
  { key: 'dispatch.view', group: '派单统计', label: '查看全员派单统计（管理层专属）', description: '仅超级管理员和店长可查看全员；普通岗位永远只能查看本人。' },
  { key: 'orders.assign', group: '审核与派单', label: '派单与退出审核', description: '分配员工、处理退出申请；需配合订单查看。' },
  { key: 'orders.lock', group: '审核与派单', label: '订单锁定与解锁', description: '锁定或解锁订单；需配合订单查看。' },
  { key: 'orders.cancel', group: '订单', label: '取消订单', description: '取消符合条件的订单；需配合订单查看。' },
  { key: 'staff.view', group: '员工', label: '员工查看', description: '查看员工资料、选项、层级和员工操作动态。' },
  { key: 'staff.manage', group: '员工', label: '员工管理与层级配置', description: '维护员工、账号状态和层级；层级列表还需员工查看。' },
  { key: 'customers.view', group: '客户', label: '客户查看', description: '查看客户列表、资料及客户关联记录。' },
  { key: 'customers.manage', group: '客户', label: '客户资料管理', description: '新建、编辑客户资料及黑名单状态。' },
  { key: 'customers.recharge', group: '客户', label: '客户充值', description: '为客户办理充值；需配合客户查看。' },
  { key: 'funds.adjust', group: '财务', label: '资金调整与扣款策略', description: '调整客户资金、配置本金与赠金扣款顺序。' },
  { key: 'stats.view', group: '经营统计', label: '经营统计查看', description: '查看管理端经营统计数据。' },
  { key: 'finance.view', group: '财务', label: '财务查看与导出', description: '查看财务概览、员工结算汇总、结算记录并导出。' },
  { key: 'settlement.view', group: '财务', label: '结算查看（原系统预留项）', description: '保留原默认值，暂不开放调整；实际结算记录由“财务查看与导出”控制。', configurable: false },
  { key: 'settlement.manage', group: '财务', label: '员工结算操作', description: '办理员工结算；财务页面访问还需财务查看。' },
  { key: 'aftersales.view', group: '售后', label: '售后查看', description: '查看售后列表及售后动态。' },
  { key: 'aftersales.manage', group: '售后', label: '处理售后', description: '处理售后、登记补偿退款及追加跟进；不包含创建，需配合售后查看。' },
  { key: 'packages.manage', group: '业务配置', label: '服务套餐配置', description: '新增和编辑服务套餐。' },
  { key: 'activities.manage', group: '业务配置', label: '充值活动配置', description: '查看及维护充值活动与赠金规则。' },
  { key: 'coupons.manage', group: '业务配置', label: '优惠券管理', description: '配置和发放优惠券。' },
  { key: 'campaigns.manage', group: '业务配置', label: '营销活动配置', description: '查看及维护营销活动。' },
  { key: 'notices.manage', group: '业务配置', label: '提醒与首页文案配置', description: '管理公告、风险提示、员工欢迎语及管理首页标语。' },
  { key: 'rbac.manage', group: '账号权限', label: '账号与角色配置（管理层专属）', description: '超级管理员管理全部业务角色；店长只管理客服、派单员和财务，不能调整自己或超级管理员。', configurable: false },
  { key: 'imports.manage', group: '数据导入', label: '批量导入', description: '下载模板并批量导入客户或订单。' },
]

type SettingClient = PrismaClient | Prisma.TransactionClient
export const getRolePermissions = async (role: UserRole, client: SettingClient = prisma): Promise<Permission[]> => {
  if (role === UserRole.SUPER_ADMIN) return [...allPermissions]
  if (role === UserRole.STAFF) return []
  if (role === UserRole.CUSTOM_ADMIN) return []
  const setting = await client.systemSetting.findUnique({ where: { key: rolePermissionKey(role) } })
  if (!setting) return [...defaultRolePermissions[role]]
  try {
    const value: unknown = JSON.parse(setting.value)
    if (!Array.isArray(value) || !value.every((key) => typeof key === 'string' && allPermissions.includes(key as Permission))) return []
    return allPermissions.filter((key) => key === 'rbac.manage' ? role === UserRole.STORE_MANAGER : key === 'dispatch.view' ? role === UserRole.STORE_MANAGER && value.includes(key) : value.includes(key))
  } catch { return [] }
}

export const saveRolePermissions = async (role: ConfigurableRole, requested: Permission[] | null, operatorId: string) => prisma.$transaction(async (tx) => {
  const actor = await tx.user.findUnique({ where: { id: operatorId }, select: { role: true, isActive: true } })
  ensure(actor?.isActive, 403, '操作账号不可用')
  assertRoleConfigScope(actor.role, role)
  ensure(requested === null || requested.includes('rbac.manage') === (role === UserRole.STORE_MANAGER), 403, '管理层专属权限不可下放或改写')
  const before = await getRolePermissions(role, tx)
  const after = requested === null ? [...defaultRolePermissions[role]] : allPermissions.filter((key) => requested.includes(key))
  ensure(role === 'STORE_MANAGER' || !after.includes('dispatch.view'), 403, '下级岗位只能查看自己的派单统计')
  if (actor.role === 'STORE_MANAGER') {
    const own = await getRolePermissions(actor.role, tx)
    ensure(after.every((key) => own.includes(key) && key !== 'rbac.manage' && key !== 'dispatch.view'), 403, '不能分配超出店长自身范围或管理层专属的权限')
  }
  if (requested !== null) ensure(after.includes('settlement.view') === before.includes('settlement.view'), 400, '结算查看预留项暂不支持调整')
  const key = rolePermissionKey(role)
  if (requested === null) await tx.systemSetting.deleteMany({ where: { key } })
  else await tx.systemSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(after), updatedById: operatorId }, update: { value: JSON.stringify(after), updatedById: operatorId } })
  await logOperation(tx, { operatorId, action: requested === null ? 'RESET_ROLE_PERMISSIONS' : 'UPDATE_ROLE_PERMISSIONS', entityType: 'ROLE_PERMISSIONS', entityId: role,
    detail: { role, actorRole: actor.role, targetRole: role, beforePermissions: before, afterPermissions: after, before, after, added: after.filter((key) => !before.includes(key)), removed: before.filter((key) => !after.includes(key)) } })
  return { role, permissions: after, defaults: [...defaultRolePermissions[role]] }
}, { isolationLevel: 'Serializable' })

export const subordinateRoles = ['CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE', 'CUSTOM_ADMIN'] as const
export const isSubordinateRole = (role: string) => (subordinateRoles as readonly string[]).includes(role)
export const manageableRoles = (actor: UserRole) => actor === UserRole.SUPER_ADMIN ? [...configurableRoles] : actor === UserRole.STORE_MANAGER ? configurableRoles.filter(role => role !== 'STORE_MANAGER') : []
export const assertRoleConfigScope = (actor: UserRole, target: string) => {
  ensure(manageableRoles(actor).some((role) => role === target), 403, '无权配置该角色权限')
}
export const assertAccountScope = (actor: UserRole, targetRole: UserRole, nextRole?: UserRole) => {
  if (actor === UserRole.SUPER_ADMIN) return
  ensure(actor === UserRole.STORE_MANAGER && isSubordinateRole(targetRole) && (nextRole === undefined || isSubordinateRole(nextRole)), 403, '店长只能管理客服、派单员和财务，不能操作或提升为店长及超级管理员')
}

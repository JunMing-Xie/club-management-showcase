import { prisma } from './prisma.js'
import { logOperation } from './utils.js'

export const DEFAULT_DASHBOARD_SLOGAN = '这里是俱乐部今天的订单现场。'
const key = 'admin_dashboard_slogan'
export const getDashboardSlogan = async () => {
  const setting = await prisma.systemSetting.findUnique({ where: { key } })
  return setting?.value ?? DEFAULT_DASHBOARD_SLOGAN
}
export const saveDashboardSlogan = async (slogan: string | null, operatorId: string) => prisma.$transaction(async (tx) => {
  const existing = await tx.systemSetting.findUnique({ where: { key } })
  const before = existing?.value ?? DEFAULT_DASHBOARD_SLOGAN
  if (slogan === null) await tx.systemSetting.deleteMany({ where: { key } })
  else await tx.systemSetting.upsert({ where: { key }, update: { value: slogan, updatedById: operatorId }, create: { key, value: slogan, updatedById: operatorId } })
  const after = slogan ?? DEFAULT_DASHBOARD_SLOGAN
  await logOperation(tx, { operatorId, action: slogan === null ? 'RESET_DASHBOARD_SLOGAN' : 'UPDATE_DASHBOARD_SLOGAN', entityType: 'SYSTEM_SETTING', entityId: key, detail: { before, after } })
  return after
})

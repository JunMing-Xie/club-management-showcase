import type { Prisma, PrismaClient } from '@prisma/client'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

export class HttpError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

export const MAX_AMOUNT_CENTS = 2_147_483_647

export const asyncHandler = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}

export function ensure(condition: unknown, statusCode: number, message: string): asserts condition {
  if (!condition) throw new HttpError(statusCode, message)
}

export const startOfDay = (date = new Date()) => {
  const value = new Date(date)
  value.setHours(0, 0, 0, 0)
  return value
}

export const endOfDay = (date = new Date()) => {
  const value = new Date(date)
  value.setHours(23, 59, 59, 999)
  return value
}

export type DateRange = { start: Date; end: Date }

const parseDateOnly = (value: string) => {
  ensure(/^\d{4}-\d{2}-\d{2}$/.test(value), 400, '日期格式应为 YYYY-MM-DD')
  const [year, month, day] = value.split('-').map(Number)
  const start = new Date(0)
  start.setFullYear(year, month - 1, day)
  start.setHours(0, 0, 0, 0)
  ensure(start.getFullYear() === year && start.getMonth() === month - 1 && start.getDate() === day, 400, '日期不存在，请检查日期')
  return start
}

export const parseDateRange = (startValue: unknown, endValue: unknown): DateRange | null => {
  const hasStart = startValue !== undefined
  const hasEnd = endValue !== undefined
  if (!hasStart && !hasEnd) return null
  ensure(typeof startValue === 'string' && typeof endValue === 'string', 400, '开始日期和结束日期需同时填写')
  const startText = startValue.trim()
  const endText = endValue.trim()
  ensure(startText.length > 0 && endText.length > 0, 400, '开始日期和结束日期需同时填写')
  const start = parseDateOnly(startText)
  const end = endOfDay(parseDateOnly(endText))
  ensure(start <= end, 400, '开始日期不能晚于结束日期')
  return { start, end }
}

export const startOfMonth = (date = new Date()) => {
  const value = new Date(date)
  value.setDate(1)
  value.setHours(0, 0, 0, 0)
  return value
}

export const addDays = (date: Date, amount: number) => {
  const value = new Date(date)
  value.setDate(value.getDate() + amount)
  return value
}

export const addMonths = (date: Date, amount: number) => {
  const value = new Date(date)
  value.setMonth(value.getMonth() + amount)
  return value
}

export const parseCents = (value: unknown, fieldName = '金额') => {
  if (typeof value === 'number') {
    ensure(Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT_CENTS, 400, `${fieldName}超出可处理范围`)
    return Math.round(value)
  }
  const text = String(value ?? '').trim()
  ensure(/^\d+(\.\d{1,2})?$/.test(text), 400, `${fieldName}格式不正确`)
  const cents = Math.round(Number(text) * 100)
  ensure(Number.isSafeInteger(cents) && cents <= MAX_AMOUNT_CENTS, 400, `${fieldName}超出可处理范围`)
  return cents
}

export const parseYuanToCents = (value: unknown, fieldName = '金额') => {
  if (typeof value === 'number' || typeof value === 'string') {
    const text = String(value).trim()
    ensure(/^\d+(\.\d{1,2})?$/.test(text), 400, `${fieldName}格式不正确`)
    const cents = Math.round(Number(text) * 100)
    ensure(Number.isSafeInteger(cents) && cents <= MAX_AMOUNT_CENTS, 400, `${fieldName}超出可处理范围`)
    return cents
  }
  throw new HttpError(400, `${fieldName}格式不正确`)
}

export const parseSignedYuanToCents = (value: unknown, fieldName = '金额') => {
  if (typeof value !== 'number' && typeof value !== 'string') throw new HttpError(400, `${fieldName}格式不正确`)
  const text = String(value).trim()
  ensure(/^-?\d+(\.\d{1,2})?$/.test(text), 400, `${fieldName}格式不正确`)
  const cents = Math.round(Number(text) * 100)
  ensure(Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_AMOUNT_CENTS, 400, `${fieldName}超出可处理范围`)
  return cents
}

export const calculateStaffAmount = (amountCents: number, commissionRateBps: number) =>
  Math.round((amountCents * commissionRateBps) / 10000)

export const logOperation = async (
  client: PrismaClient | Prisma.TransactionClient,
  data: {
    operatorId?: string
    action: string
    entityType: string
    entityId?: string
    detail?: Prisma.InputJsonValue
  },
) => {
  const write = async () => {
    const operator = data.operatorId ? await client.user.findUnique({ where: { id: data.operatorId }, select: { role: true, adminRoleId: true, adminRole: { select: { name: true } } } }) : null
    if (operator?.role !== 'CUSTOM_ADMIN') return client.operationLog.create({ data })
    const detail = data.detail && typeof data.detail === 'object' && !Array.isArray(data.detail) ? data.detail : { originalDetail: data.detail ?? null }
    return client.operationLog.create({ data: { ...data, detail: { ...detail, operatorRole: operator.role, operatorAdminRoleId: operator.adminRoleId, operatorRoleName: operator.adminRole?.name ?? '自定义职位' } } })
  }
  return write()
}

export const sumBy = <T>(items: T[], selector: (item: T) => number) =>
  items.reduce((total, item) => total + selector(item), 0)

export const dateKey = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const monthKey = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

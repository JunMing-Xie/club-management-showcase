export const formatMoney = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const yuanToCents = (value: unknown, required = true) => {
  const text = String(value ?? '').trim()
  if (!text && !required) return undefined
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('金额格式不正确')
  return Math.round(amount * 100)
}

export const formatDateTime = (value: string | Date | null | undefined) => {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export const formatDate = (value: string | Date) => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })

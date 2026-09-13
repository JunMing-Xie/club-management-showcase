import { createContext, useContext } from 'react'

export type ReminderKind = 'completion' | 'exit' | 'afterSale'
export const reminderLabels: Record<ReminderKind, string> = { completion: '待完单审核', exit: '待处理退出申请', afterSale: '待处理售后' }
export type ReminderItem = { id: string; title: string; href: string; occurredAt: string; kind: ReminderKind; summary: string | null; orderId: string; orderNo: string }
export type ReminderData = {
  counts: Record<ReminderKind, number>; allowed: Record<ReminderKind, boolean>; total: number
  page: number; pageSize: number; filteredTotal: number
  todos: ReminderItem[]
  activities: Array<{ id: string; title: string; href: string; occurredAt: string; orderNo: string | null }>
}
export type ReminderContextValue = {
  data: ReminderData | null; loading: boolean; error: string | null
  refresh: () => void; open: (kind?: ReminderKind) => void
}
export const ReminderContext = createContext<ReminderContextValue | null>(null)
export const useAdminReminders = () => {
  const value = useContext(ReminderContext)
  if (!value) throw new Error('Reminders require AdminRemindersProvider')
  return value
}

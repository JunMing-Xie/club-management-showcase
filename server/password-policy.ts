import { z } from 'zod'

// Shared by employee creation/reset and the self-service form; no password trimming.
export const passwordSchema = z.string().min(6, '密码长度应为6～72个字符').max(72, '密码长度应为6～72个字符')
export const usernameSchema = z.string().trim().min(2, '登录账号长度应为2～64个字符').max(64, '登录账号长度应为2～64个字符')
export const changeUsernameSchema = z.object({
  newUsername: usernameSchema,
  currentPassword: z.string().min(1, '请输入当前密码').max(72, '当前密码长度不能超过72个字符'),
}).strict()
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(72, '当前密码长度不能超过72个字符'),
  newPassword: passwordSchema,
  confirmPassword: z.string().min(1, '请确认新密码').max(72, '密码长度应为6～72个字符'),
}).strict().refine(body => body.newPassword === body.confirmPassword, {
  message: '两次输入的新密码不一致', path: ['confirmPassword'],
}).refine(body => body.newPassword !== body.currentPassword, {
  message: '新密码不能与当前密码相同', path: ['newPassword'],
})

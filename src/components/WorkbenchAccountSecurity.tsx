import { SafetyOutlined } from '@ant-design/icons'
import { App, Button, Dropdown, Form, Input, Modal } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { changePasswordSchema, changeUsernameSchema, passwordSchema, usernameSchema } from '../../server/password-policy'
import { api, getErrorMessage } from '../api'
import { useAuth } from '../auth-context'
import { authScope, clearAuthSession } from '../auth-storage'

type Values = { currentPassword: string; newPassword?: string; confirmPassword?: string; newUsername?: string }

export const WorkbenchAccountSecurity = () => {
  const [mode, setMode] = useState<'username' | 'password' | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<Values>()
  const { user, logout } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const close = () => { if (!saving) { setMode(null); form.resetFields() } }
  const submit = async (values: Values) => {
    const parsed = (mode === 'username' ? changeUsernameSchema : changePasswordSchema).safeParse(values)
    if (!parsed.success) { message.error(parsed.error.issues[0].message); return }
    if (mode === 'username' && values.newUsername?.trim() === user?.username) { message.error('新登录账号不能与当前账号相同'); return }
    setSaving(true)
    try {
      await api.post(`/workbench/change-${mode}`, parsed.data)
      const notice = mode === 'username' ? '登录账号修改成功，请使用新账号重新登录' : '密码修改成功，请使用新密码重新登录'
      form.resetFields()
      setMode(null)
      clearAuthSession('workbench')
      // A late response after navigating to the admin portal must not clear its session.
      if (authScope() === 'workbench') {
        logout()
        navigate('/workbench/login', { replace: true })
      }
      message.success(notice, 6)
    } catch (error) {
      message.error(getErrorMessage(error, '修改失败，请稍后重试'))
    } finally { setSaving(false) }
  }
  return <>
    <Dropdown trigger={['click']} menu={{ items: [{ key: 'username', label: '修改登录账号' }, { key: 'password', label: '修改登录密码' }], onClick: ({ key }) => { form.resetFields(); setMode(key as 'username' | 'password') } }}>
      <Button size="small" icon={<SafetyOutlined />}>账号与安全</Button>
    </Dropdown>
    <Modal title={mode === 'username' ? '修改登录账号' : '修改登录密码'} open={mode !== null} width={440} style={{ top: 24, paddingBottom: 24 }} styles={{ body: { maxHeight: 'calc(100dvh - 170px)', overflowY: 'auto' } }} onCancel={close} onOk={() => form.submit()} okText="保存" cancelText="取消" confirmLoading={saving} closable={!saving} mask={{ closable: !saving }} keyboard={!saving} cancelButtonProps={{ disabled: saving }} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={submit} preserve={false} disabled={saving}>
        {mode === 'username' && <>
          <Form.Item label="当前登录账号" htmlFor="workbench-current-username"><Input id="workbench-current-username" value={user?.username ?? ''} readOnly /></Form.Item>
          <Form.Item name="newUsername" label="新登录账号" rules={[{ required: true, message: '请输入新登录账号' }, { validator: async (_, value) => {
            if (!value) return
            const result = usernameSchema.safeParse(value)
            if (!result.success) throw new Error(result.error.issues[0].message)
            if (result.data === user?.username) throw new Error('新登录账号不能与当前账号相同')
          } }]}><Input autoComplete="username" maxLength={64} /></Form.Item>
        </>}
        <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" maxLength={72} />
        </Form.Item>
        {mode === 'password' && <>
          <Form.Item name="newPassword" label="新密码" dependencies={['currentPassword']} extra="密码长度为6～72个字符，不会自动去除空格。" rules={[{ required: true, message: '请输入新密码' }, ({ getFieldValue }) => ({ validator: async (_, value) => {
            if (!value) return
            const result = passwordSchema.safeParse(value)
            if (!result.success) throw new Error(result.error.issues[0].message)
            if (value === getFieldValue('currentPassword')) throw new Error('新密码不能与当前密码相同')
          } })]}><Input.Password autoComplete="new-password" maxLength={72} /></Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{ required: true, message: '请确认新密码' }, ({ getFieldValue }) => ({ validator: async (_, value) => {
            if (value && value !== getFieldValue('newPassword')) throw new Error('两次输入的新密码不一致')
          } })]}><Input.Password autoComplete="new-password" maxLength={72} /></Form.Item>
        </>}
      </Form>
    </Modal>
  </>
}

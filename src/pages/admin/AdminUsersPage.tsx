import { AdminRoleManager, type AdminJob } from '../../components/AdminRoleManager'
import { RolePermissionConfig } from '../../components/RolePermissionConfig'
import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { App, Button, Card, Form, Input, Modal, Select, Space, Switch, Table, Tag } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../../api'
import { formatDateTime } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import { roleMeta, type Role } from '../../types'
import { RequestError } from '../../components/RequestState'
import { useAuth } from '../../auth-context'

type AdminAccount = { adminRoleId?: string | null; adminRole?: { id: string; name: string; isActive: boolean } | null; id: string; username: string; role: Exclude<Role, 'STAFF' | 'ADMIN'>; isActive: boolean; createdAt: string }
type FormValues = { username: string; password?: string; role: string; isActive: boolean }
type ResetPasswordValues = { password: string }

export const AdminUsersPage = () => {
  const { message } = App.useApp()
  const { user, refreshUser } = useAuth()
  const [jobs, setJobs] = useState<AdminJob[]>([])
  const [items, setItems] = useState<AdminAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [editing, setEditing] = useState<AdminAccount | null>(null)
  const [resetting, setResetting] = useState<AdminAccount | null>(null)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm<FormValues>()
  const [passwordForm] = Form.useForm<ResetPasswordValues>()
  const load = useCallback(async () => {
    setHasError(false)
    try { const [accounts, positions] = await Promise.all([api.get<{ items: AdminAccount[] }>('/admin/users'), api.get<{ items: AdminJob[] }>('/admin/roles')]); setItems(accounts.data.items); setJobs(positions.data.items) }
    catch (error) { setHasError(true); message.error(getErrorMessage(error)) }
    finally { setLoading(false) }
  }, [message])
  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)
  const save = async (values: FormValues) => {
    try {
      const username = values.username.trim()
      const custom = values.role.startsWith('job:')
      const role = custom ? 'CUSTOM_ADMIN' : values.role
      const adminRoleId = custom ? values.role.slice(4) : null
      if (editing) await api.patch('/admin/users/' + editing.id, { username, role, adminRoleId, isActive: values.isActive })
      else await api.post('/admin/users', { ...values, username, role, adminRoleId })
      const renamed = editing && editing.username !== username
      message.success(renamed ? '登录账号已修改，下次请使用新账号登录。' : '账号权限已保存')
      setOpen(false)
      if (editing?.id === user?.id) {
        try { await refreshUser() }
        catch { message.warning('账号已保存，当前用户信息刷新失败，请刷新页面确认。') }
      }
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  const resetPassword = async () => {
    if (!resetting) return
    try {
      const values = await passwordForm.validateFields()
      await api.post('/admin/users/' + resetting.id + '/reset-password', values)
      message.success('管理账号密码已重置')
      setResetting(null)
      passwordForm.resetFields()
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return
      message.error(getErrorMessage(error))
    }
  }
  if (loading) return <div className="page-loading"><span>正在加载账号权限…</span></div>
  if (hasError) return <RequestError onRetry={() => void load()} />
  const roles = (Object.keys(roleMeta) as Array<Exclude<Role, 'ADMIN'>>).filter((role): role is Exclude<Role, 'STAFF' | 'ADMIN'> => role !== 'STAFF' && role !== 'CUSTOM_ADMIN' && (user?.role === 'SUPER_ADMIN' || ['CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE'].includes(role)))
  return <div className="content-stack"><section className="page-intro compact"><div><div className="eyebrow">系统安全 · 服务端权限</div><h2>账号权限</h2><p>管理后台账号角色；权限由服务端校验，员工账号不能进入管理后台。</p></div><Space wrap><RolePermissionConfig /><AdminRoleManager onChanged={load} /><Button type="text" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); form.setFieldsValue({ role: user?.role === 'SUPER_ADMIN' ? 'STORE_MANAGER' : 'CUSTOMER_SERVICE', isActive: true }); setOpen(true) }}>新增管理账号</Button></Space></section><Card className="table-card" variant="borderless"><Table<AdminAccount> scroll={{ x: 760 }} rowKey="id" dataSource={items} pagination={false} columns={[{ title: '账号', dataIndex: 'username' }, { title: '角色', dataIndex: 'role', render: (value: AdminAccount['role'], row: AdminAccount) => <Tag color="blue">{row.adminRole?.name ?? roleMeta[value]}</Tag> }, { title: '状态', dataIndex: 'isActive', render: (value: boolean) => <Tag color={value ? 'success' : 'default'}>{value ? '启用' : '停用'}</Tag> }, { title: '创建时间', dataIndex: 'createdAt', render: (value: string) => formatDateTime(value) }, { title: '操作', width: 150, render: (_: unknown, item: AdminAccount) => <Space size={0}><Button type="link" onClick={() => { setEditing(item); form.resetFields(); form.setFieldsValue({ username: item.username, role: item.adminRoleId ? 'job:' + item.adminRoleId : item.role, isActive: item.isActive }); setOpen(true) }}>编辑</Button><Button type="link" icon={<KeyOutlined />} aria-label={'重置' + item.username + '密码'} onClick={() => { setResetting(item); passwordForm.resetFields() }}>重置密码</Button></Space> }]} /></Card><Modal title={editing ? '编辑管理账号' : '新增管理账号'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} okText="保存" cancelText="返回"><Form form={form} layout="vertical" onFinish={save}><Form.Item name="username" label="登录账号" normalize={(value: string) => value.trim()} rules={[{ required: true, whitespace: true, message: '请输入登录账号' }, { min: 2, max: 64, message: '登录账号需为 2～64 个字符' }]}><Input maxLength={64} autoComplete="off" /></Form.Item>{!editing && <><Form.Item name="password" label="初始密码" rules={[{ required: true, min: 6, message: '密码至少 6 位' }]}><Input.Password /></Form.Item></>}<Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={[{ label: '系统职位', options: roles.map(role => ({ value: role, label: roleMeta[role] })) }, { label: '自定义职位', options: jobs.filter(job => (job.isActive && job.manageable) || job.id === editing?.adminRoleId).map(job => ({ value: 'job:' + job.id, label: job.name + (job.isActive ? '' : '（已停用，仅保留原关联）'), disabled: !job.manageable })) }]} /></Form.Item><Form.Item name="isActive" label="启用账号" valuePropName="checked"><Switch /></Form.Item></Form></Modal><Modal title={'重置 ' + (resetting?.username ?? '') + ' 的密码'} open={Boolean(resetting)} onCancel={() => setResetting(null)} onOk={() => void resetPassword()} okText="确认重置" cancelText="返回"><Form form={passwordForm} layout="vertical"><Form.Item name="password" label="新密码" rules={[{ required: true, min: 6, message: '密码至少 6 位' }]}><Input.Password placeholder="请输入新密码" /></Form.Item></Form></Modal></div>
}

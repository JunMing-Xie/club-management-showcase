import { Alert, App, Button, Card, Checkbox, Modal, Space, Spin, Tabs, Typography } from 'antd'
import { useState } from 'react'
import { api, getErrorMessage } from '../api'
import { useAuth } from '../auth-context'
import { roleMeta } from '../types'

type BusinessRole = 'STORE_MANAGER' | 'CUSTOMER_SERVICE' | 'DISPATCHER' | 'FINANCE'
type CatalogItem = { key: string; group: string; label: string; description: string; configurable?: boolean }
type RoleConfig = { role: BusinessRole; permissions: string[]; defaults: string[]; customized?: boolean }
type ConfigResponse = { catalog: CatalogItem[]; roles: RoleConfig[] }

export const RolePermissionConfig = () => {
  const { user } = useAuth()
  const { message, modal } = App.useApp()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState<ConfigResponse | null>(null)
  const [role, setRole] = useState<BusinessRole>('STORE_MANAGER')
  const [drafts, setDrafts] = useState<Partial<Record<BusinessRole, string[]>>>({})
  const load = async () => {
    setLoading(true)
    try {
      const { data: response } = await api.get<ConfigResponse>('/admin/role-permissions')
      setData(response)
      setRole(response.roles[0].role)
      setDrafts(Object.fromEntries(response.roles.map((item) => [item.role, item.permissions])))
    } catch (error) { message.error(getErrorMessage(error)) }
    finally { setLoading(false) }
  }
  const save = async (reset = false) => {
    setSaving(true)
    try {
      const endpoint = '/admin/role-permissions/' + role
      const { data: response } = reset
        ? await api.post<{ item: RoleConfig }>(endpoint + '/reset')
        : await api.patch<{ item: RoleConfig }>(endpoint, { permissions: drafts[role] ?? [] })
      setData((current) => current && ({ ...current, roles: current.roles.map((item) => item.role === role ? response.item : item) }))
      setDrafts((current) => ({ ...current, [role]: response.item.permissions }))
      message.success(reset ? '该角色已恢复默认权限' : '角色权限已保存，相关账号下次请求即生效')
    } catch (error) { message.error(getErrorMessage(error)) }
    finally { setSaving(false) }
  }
  if (user?.role !== 'SUPER_ADMIN' && user?.role !== 'STORE_MANAGER') return null
  const selected = drafts[role] ?? []
  const groups = [...new Set(data?.catalog.map((item) => item.group) ?? [])]
  return <>
    <Button onClick={() => { setOpen(true); void load() }}>角色权限配置</Button>
    <Modal title="角色权限配置" open={open} width={860} onCancel={() => { if (!saving) setOpen(false) }} footer={null}>
      <Alert type="info" showIcon title="超级管理员：全部权限，不可修改" description={user.role === 'STORE_MANAGER' ? '店长可配置下级岗位业务权限，系统最高权限由超级管理员管理。' : '可配置店长及下级岗位；店长不能修改自身模板或操作超级管理员，下级岗位不能获得管理层专属权限。'} />
      {loading ? <Spin style={{ display: 'block', margin: 32 }} /> : !data ? <Button onClick={() => void load()}>重新加载权限</Button> : <>
        <Tabs activeKey={role} onChange={(key) => setRole(key as BusinessRole)} items={data.roles.map((item) => ({ key: item.role, label: roleMeta[item.role], disabled: saving }))} />
        <Typography.Paragraph type="secondary">{role === 'STORE_MANAGER' ? '负责日常经营管理，默认拥有除系统最高权限外的大部分管理权限。' : '按实际岗位调整业务权限；查看和处理是不同权限，需分别选择。'} 修改后刷新页面或重新请求数据即可生效。</Typography.Paragraph>
        <Space orientation="vertical" size={12} style={{ width: '100%', maxHeight: '55vh', overflowY: 'auto' }}>
          {groups.map((group) => <Card size="small" title={group} key={group}>
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>{data.catalog.filter((item) => item.group === group).map((item) => <div key={item.key}>
              <Checkbox checked={selected.includes(item.key)} disabled={saving || item.configurable === false || (item.key === 'dispatch.view' && role !== 'STORE_MANAGER')} onChange={(event) => setDrafts((current) => ({ ...current, [role]: event.target.checked ? [...selected, item.key] : selected.filter((key) => key !== item.key) }))}>{item.label}</Checkbox>
              <div style={{ paddingLeft: 24 }}><Typography.Text type="secondary">{item.description}</Typography.Text></div>
            </div>)}</Space>
          </Card>)}
        </Space>
        <Space style={{ marginTop: 20 }}>
          <Button type="primary" loading={saving} onClick={() => void save()}>保存当前角色权限</Button>
          <Button disabled={saving} onClick={() => modal.confirm({ title: `恢复${roleMeta[role]}的默认权限？`, content: '只恢复当前角色，不影响其他角色。', okText: '确认恢复', cancelText: '取消', onOk: () => save(true) })}>恢复默认权限</Button>
        </Space>
      </>}
    </Modal>
  </>
}

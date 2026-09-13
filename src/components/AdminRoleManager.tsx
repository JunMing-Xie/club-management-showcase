import { Alert, App, Button, Card, Checkbox, Form, Input, Modal, Space, Switch, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { api, getErrorMessage } from '../api'

export type AdminJob = { id: string; name: string; description: string | null; permissions: string[]; isActive: boolean; manageable: boolean; _count: { users: number } }
type CatalogItem = { key: string; group: string; label: string; description: string }
type Values = { name: string; description?: string; isActive: boolean }
export const AdminRoleManager = ({ onChanged }: { onChanged: () => Promise<void> }) => {
  const { message, modal } = App.useApp()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AdminJob | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [items, setItems] = useState<AdminJob[]>([])
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<Values>()
  const load = async () => {
    const { data } = await api.get<{ items: AdminJob[]; catalog: CatalogItem[] }>('/admin/roles')
    setItems(data.items); setCatalog(data.catalog)
  }
  const refresh = async () => { try { await load() } catch (error) { message.error(getErrorMessage(error)) } }
  const edit = (item: AdminJob | null) => {
    setEditing(item); setSelected(item?.permissions ?? []); form.resetFields()
    form.setFieldsValue({ name: item?.name ?? '', description: item?.description ?? '', isActive: item?.isActive ?? true }); setEditorOpen(true)
  }
  const save = async (values: Values) => {
    setBusy(true)
    try {
      const body = { ...values, name: values.name.trim(), permissions: selected }
      if (editing) await api.patch('/admin/roles/' + editing.id, body)
      else await api.post('/admin/roles', body)
      message.success('职位已保存，关联账号权限下次请求即生效'); setEditorOpen(false); await load(); await onChanged()
    } catch (error) { message.error(getErrorMessage(error)) } finally { setBusy(false) }
  }
  const remove = (item: AdminJob) => modal.confirm({ title: `删除职位“${item.name}”？`, content: '仅未被任何账号使用的职位允许删除，历史操作日志会保留。', okText: '删除', cancelText: '取消', onOk: async () => { try { await api.delete('/admin/roles/' + item.id); await load(); await onChanged() } catch (error) { message.error(getErrorMessage(error)); throw error } } })
  return <>
    <Button onClick={() => { setOpen(true); void refresh() }}>职位管理</Button>
    <Modal title="职位管理" open={open} width={850} footer={null} onCancel={() => setOpen(false)}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        <Alert type="info" showIcon title="自定义职位均属于店长以下的普通后台岗位" description="停用后不再接受新账号分配，已有账号保留关联和权限。系统最高权限不可下放，系统角色继续在角色权限配置中管理。" />
        <Space wrap><Button type="primary" onClick={() => edit(null)}>新增职位</Button><Button onClick={() => void refresh()}>刷新职位</Button></Space>
        <Table<AdminJob> size="small" rowKey="id" dataSource={items} scroll={{ x: 600 }} columns={[
          { title: '职位', dataIndex: 'name' }, { title: '说明', dataIndex: 'description' },
          { title: '状态', render: (_, row) => <Tag color={row.isActive ? 'success' : 'default'}>{row.isActive ? '启用' : '停用'}</Tag> },
          { title: '账号数', render: (_, row) => row._count.users },
          { title: '操作', render: (_, row) => <Space><Button type="link" disabled={!row.manageable} onClick={() => edit(row)}>编辑</Button><Button type="link" danger disabled={!row.manageable} onClick={() => remove(row)}>删除</Button></Space> },
        ]} />
      </Space>
    </Modal>
    <Modal title={editing ? '编辑职位' : '新增职位'} open={editorOpen} width={800} confirmLoading={busy} onCancel={() => { if (!busy) setEditorOpen(false) }} onOk={() => form.submit()} okText="保存职位" cancelText="取消">
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="name" label="职位名称" normalize={(value: string) => value.trim()} rules={[{ required: true, whitespace: true, message: '请输入职位名称' }, { max: 40 }]}><Input maxLength={40} placeholder="例如：运营、售后专员" /></Form.Item>
        <Form.Item name="description" label="职位说明"><Input.TextArea maxLength={500} rows={2} /></Form.Item>
        <Form.Item name="isActive" label="启用职位" valuePropName="checked"><Switch /></Form.Item>
        <Typography.Paragraph>勾选此职位的业务权限；关联账号统一使用此模板。</Typography.Paragraph>
        <Space orientation="vertical" style={{ width: '100%' }}>{[...new Set(catalog.map(item => item.group))].map(group => <Card size="small" title={group} key={group}>
          <Space orientation="vertical">{catalog.filter(item => item.group === group).map(item => <div key={item.key}><Checkbox disabled={busy} checked={selected.includes(item.key)} onChange={event => setSelected(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))}>{item.label}</Checkbox><div style={{ paddingLeft: 24 }}><Typography.Text type="secondary">{item.description}</Typography.Text></div></div>)}</Space>
        </Card>)}</Space>
      </Form>
    </Modal>
  </>
}

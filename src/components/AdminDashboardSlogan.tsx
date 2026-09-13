import { App, Button, Card, Form, Input, Popconfirm, Space, Spin } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'

type Values = { slogan: string }
export const AdminDashboardSlogan = () => {
  const { message } = App.useApp()
  const [form] = Form.useForm<Values>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const load = useCallback(async () => {
    setLoading(true); setFailed(false)
    try { const { data } = await api.get<{ item: Values }>('/settings/admin-dashboard'); form.setFieldsValue(data.item) }
    catch (error) { setFailed(true); message.error(getErrorMessage(error)) }
    finally { setLoading(false) }
  }, [form, message])
  useEffect(() => { void load() }, [load])
  const save = async (values: Values | null) => {
    setSaving(true)
    try {
      const { data } = values ? await api.patch<{ item: Values }>('/settings/admin-dashboard', values) : await api.post<{ item: Values }>('/settings/admin-dashboard/reset')
      form.setFieldsValue(data.item)
      message.success(values ? '管理后台首页标语已保存' : '管理后台首页标语已恢复默认')
    } catch (error) { message.error(getErrorMessage(error)) }
    finally { setSaving(false) }
  }
  return <Card className="table-card" variant="borderless" title="管理后台首页标语">
    {loading ? <Spin /> : failed ? <Button onClick={() => void load()}>重新加载首页标语</Button> : <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
      <Form.Item name="slogan" label="首页标语" normalize={(value: string) => value.trim()} rules={[{ required: true, whitespace: true, message: '请输入首页标语' }, { max: 240, message: '标语最多 240 个字符' }, { pattern: /^[^<>]+$/, message: '仅支持纯文本，不能包含 HTML 标签' }]}><Input maxLength={240} /></Form.Item>
      <Space><Button type="primary" htmlType="submit" loading={saving}>保存首页标语</Button><Popconfirm title="恢复默认首页标语？" onConfirm={() => save(null)} okText="确认恢复" cancelText="取消"><Button disabled={saving}>恢复默认标语</Button></Popconfirm></Space>
    </Form>}
  </Card>
}

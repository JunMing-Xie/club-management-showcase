import { useAuth } from '../../auth-context'
import { hasUserPermission } from '../../types'
import { canAdjustOrderNet, unsettledAdjustmentMessage, canCreateAfterSale, unsettledAfterSaleMessage } from '../../order-adjustment'
import { CheckOutlined, EyeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Descriptions, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, getErrorMessage } from '../../api'
import { formatDateTime, formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import type { Order } from '../../types'
import { AfterSaleMessages, type AfterSaleMessage } from '../../components/AfterSaleMessages'
import { RequestError } from '../../components/RequestState'
import { useAdminReminders } from '../../admin-reminders'

type AfterSale = {
  messages?: AfterSaleMessage[]
  id: string
  caseNo: string
  orderId: string
  issueType: string
  description: string
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED'
  resultType: string | null
  compensationCents: number
  refundCents: number
  supplementaryOrderId: string | null
  supplementaryOrder?: { id: string; orderNo: string } | null
  handlingNote: string | null
  createdAt: string
  handledAt: string | null
  customer: { id: string; customerCode: string; teamCode: string }
  staff: { name: string } | null
  order: Order
}
type CreateValues = { orderId: string; issueType: string; description: string }
type UpdateValues = { issueType: string; description: string; status: AfterSale['status']; resultType?: string; compensationAmount?: number; refundAmount?: number; supplementaryOrderId?: string; handlingNote?: string }

const statusMeta = { PENDING: { label: '待处理', color: 'warning' }, PROCESSING: { label: '处理中', color: 'processing' }, COMPLETED: { label: '已完成', color: 'success' } } as const

export const AfterSalesPage = () => {
  const { message } = App.useApp()
  const { user } = useAuth()
  const canCreate = hasUserPermission(user, 'aftersales.create')
  const canManage = hasUserPermission(user, 'aftersales.manage')
  const canEditOrder = hasUserPermission(user, 'orders.edit')
  const canReadOrders = hasUserPermission(user, 'orders.view')
  const { data: reminders } = useAdminReminders()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const requestedAfterSaleId = searchParams.get('afterSaleId')
  const pendingOnly = searchParams.get('pending') === '1'
  const openedLocation = useRef<string | null>(null)
  const [items, setItems] = useState<AfterSale[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<AfterSale | null>(null)
  const [viewing, setViewing] = useState<AfterSale | null>(null)
  const [createForm] = Form.useForm<CreateValues>()
  const [updateForm] = Form.useForm<UpdateValues>()
  const load = useCallback(async () => {
    setHasError(false)
    try {
      const [cases, orderResponse] = await Promise.all([
        api.get<{ items: AfterSale[] }>('/after-sales'),
        canReadOrders ? api.get<{ items: Order[] }>('/orders') : Promise.resolve({ data: { items: [] as Order[] } }),
      ])
      setItems(cases.data.items.filter((item) => !pendingOnly || item.status !== 'COMPLETED'))
      setViewing((current) => current ? cases.data.items.find((item) => item.id === current.id) ?? null : null)
      setOrders(orderResponse.data.items)
    } catch (error) {
      setHasError(true)
      message.error(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [message, pendingOnly, canReadOrders])
  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)

  useEffect(() => {
    if (loading || hasError || !requestedAfterSaleId || openedLocation.current === location.key) return
    openedLocation.current = location.key
    const requested = items.find((item) => item.id === requestedAfterSaleId)
    if (requested) setViewing(requested)
    else message.info('该售后记录已不存在或当前不可查看')
  }, [items, loading, hasError, requestedAfterSaleId, location.key, message])

  const eligibleOrders = orders.filter(canCreateAfterSale)
  const createCase = async (values: CreateValues) => {
    if (!eligibleOrders.some((item) => item.id === values.orderId)) { message.warning({ key: 'create-after-sale', content: unsettledAfterSaleMessage }); return }
    try {
      await api.post('/after-sales', values)
      message.success('售后记录已创建')
      setCreateOpen(false)
      createForm.resetFields()
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  const openUpdate = (item: AfterSale, complete = false) => {
    setEditing(item)
    updateForm.setFieldsValue({ issueType: item.issueType, description: item.description, status: complete ? 'COMPLETED' : item.status, resultType: item.resultType ?? undefined, compensationAmount: item.compensationCents / 100, refundAmount: item.refundCents / 100, supplementaryOrderId: item.supplementaryOrderId ?? undefined, handlingNote: item.handlingNote ?? '' })
  }
  const updateCase = async (values: UpdateValues) => {
    if (!editing) return
    if (values.status === 'COMPLETED' && !values.handlingNote?.trim()) {
      message.error('完成售后时必须填写处理备注')
      return
    }
    try {
      await api.patch('/after-sales/' + editing.id, values)
      message.success('售后记录已更新')
      setEditing(null)
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  if (loading) return <div className="page-loading"><span>正在加载售后记录…</span></div>
  if (hasError) return <RequestError onRetry={() => void load()} />
  return (
    <div className="content-stack">
      {pendingOnly && <Alert type="info" showIcon title="当前仅显示待处理及处理中的售后" action={<Button size="small" onClick={() => navigate('/admin/after-sales')}>查看全部售后</Button>} />}
      <section className="page-intro compact"><div><div className="eyebrow">售后管理 · 处理队列</div><h2>售后管理</h2><p>记录服务问题、处理结果和必要的线下补偿；不接在线退款。</p></div><Space><Button type="text" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button><Tooltip title={eligibleOrders.length ? undefined : '暂无可创建正式售后的已审核结算订单'}><Button style={canCreate ? undefined : { display: 'none' }} type="primary" disabled={!eligibleOrders.length} icon={<PlusOutlined />} onClick={() => { createForm.resetFields(); setCreateOpen(true) }}>新建售后</Button></Tooltip></Space></section>
      <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>售后队列</strong><span className="card-subtitle">共 {items.length} 条</span></div></div><Table<AfterSale> rowKey="id" dataSource={items} pagination={{ pageSize: 8, showTotal: (total) => '共 ' + total + ' 条' }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无售后记录" /> }} columns={[{ title: '售后编号', dataIndex: 'caseNo', render: (value: string) => <span className="mono-text">{value}</span> }, { title: '订单号', dataIndex: ['order', 'orderNo'], render: (value: string) => <Button type="link" onClick={() => { const item = items.find((caseItem) => caseItem.order.orderNo === value); if (item) setViewing(item) }}>{value}</Button> }, { title: '客户ID', dataIndex: ['customer', 'customerCode'] }, { title: '问题类型', dataIndex: 'issueType' }, { title: '员工', dataIndex: ['staff', 'name'], render: (value: string | null) => value || '—' }, { title: '状态', dataIndex: 'status', render: (value: AfterSale['status']) => <Tag color={statusMeta[value].color}>{statusMeta[value].label}</Tag> }, { title: '补偿 / 退款记录', render: (_: unknown, item: AfterSale) => formatMoney(item.compensationCents) + ' / ' + formatMoney(item.refundCents) }, { title: '创建时间', dataIndex: 'createdAt', render: (value: string) => formatDateTime(value) }, { title: '操作', fixed: 'right', width: 190, render: (_: unknown, item: AfterSale) => <Space size={0}><Tooltip title="查看售后详情"><Button type="text" icon={<EyeOutlined />} onClick={() => setViewing(item)} /></Tooltip>{canManage && item.status !== 'COMPLETED' && <><Button type="link" onClick={() => openUpdate(item)}>更新</Button><Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => openUpdate(item, true)}>完成售后</Button></>}</Space> }]} /></Card>
      <Modal title="新建售后记录" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => createForm.submit()} okText="创建记录" cancelText="返回"><p role="note">{unsettledAfterSaleMessage}</p><Form form={createForm} layout="vertical" onFinish={createCase}><Form.Item name="orderId" label="关联订单" rules={[{ required: true, message: '请选择订单' }]}><Select showSearch optionFilterProp="label" placeholder="选择已审核结算且尚无售后的订单" options={eligibleOrders.map((item) => ({ value: item.id, label: item.orderNo + ' · ' + item.customer.customerCode + ' · ' + item.serviceItem }))} /></Form.Item><Form.Item name="issueType" label="问题类型" rules={[{ required: true, message: '请输入问题类型' }]}><Input placeholder="例如：服务补偿 / 订单争议" /></Form.Item><Form.Item name="description" label="问题描述" rules={[{ required: true, message: '请填写问题描述' }]}><Input.TextArea rows={4} placeholder="记录客户反馈与处理背景" /></Form.Item></Form></Modal>
      <Modal title="更新售后处理" open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => updateForm.submit()} okText="保存处理结果" cancelText="返回"><Form form={updateForm} layout="vertical" onFinish={updateCase}><Form.Item name="issueType" label="问题类型" rules={[{ required: true, message: '请输入问题类型' }]}><Input /></Form.Item><Form.Item name="description" label="问题描述" rules={[{ required: true, message: '请填写问题描述' }]}><Input.TextArea rows={4} /></Form.Item><Form.Item name="status" label="处理状态" rules={[{ required: true }]}><Select options={Object.entries(statusMeta).map(([value, item]) => ({ value, label: item.label }))} /></Form.Item><Form.Item name="resultType" label="处理结果"><Select allowClear options={[{ value: 'COMPENSATION', label: '补偿' }, { value: 'SUPPLEMENTARY_ORDER', label: '补单' }, { value: 'REFUND', label: '退款记录（线下）' }]} /></Form.Item><Form.Item name="supplementaryOrderId" label="关联补单"><Select allowClear showSearch optionFilterProp="label" placeholder="选择同一客户的新订单" options={orders.filter((item) => item.id !== editing?.orderId && item.customer.id === editing?.customer.id).map((item) => ({ value: item.id, label: item.orderNo + ' · ' + item.serviceItem }))} /></Form.Item><div className="form-grid-two"><Form.Item name="compensationAmount" label="补偿金额（元）"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item><Form.Item name="refundAmount" label="退款记录金额（元）"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></div><Form.Item name="handlingNote" label="处理备注"><Input.TextArea rows={3} /></Form.Item></Form></Modal>
      <Modal title="售后详情" open={Boolean(viewing)} footer={<Space>{reminders?.allowed.afterSale && viewing && viewing.status !== 'COMPLETED' && <Button type="primary" onClick={() => openUpdate(viewing)}>处理售后</Button>}{canEditOrder && viewing && ['COMPLETED', 'AFTER_SALE'].includes(viewing.order.status) && <Tooltip title={canAdjustOrderNet(viewing.order) ? undefined : unsettledAdjustmentMessage}><Button type="primary" disabled={!canAdjustOrderNet(viewing.order)} onClick={() => navigate(`/admin/orders?orderId=${viewing.order.id}`)}>订单净额调整</Button></Tooltip>}<Button onClick={() => setViewing(null)}>关闭</Button></Space>} onCancel={() => setViewing(null)}><Descriptions column={1} bordered size="small" items={viewing ? [{ key: 'caseNo', label: '售后编号', children: viewing.caseNo }, { key: 'order', label: '关联订单', children: viewing.order.orderNo }, { key: 'customerCode', label: '客户ID', children: viewing.customer.customerCode }, { key: 'teamCode', label: '客户组队码', children: viewing.customer.teamCode }, { key: 'issue', label: '问题类型', children: viewing.issueType }, { key: 'description', label: '问题描述', children: viewing.description }, { key: 'status', label: '处理状态', children: <Tag color={statusMeta[viewing.status].color}>{statusMeta[viewing.status].label}</Tag> }, { key: 'result', label: '处理结果', children: `${viewing.resultType === 'COMPENSATION' ? '补偿' : viewing.resultType === 'SUPPLEMENTARY_ORDER' ? '补单' : viewing.resultType === 'REFUND' ? '退款记录' : '待登记'} · 补偿 ${formatMoney(viewing.compensationCents)} · 退款记录 ${formatMoney(viewing.refundCents)}` }, { key: 'supplementary', label: '关联补单', children: viewing.supplementaryOrder?.orderNo || '—' }, { key: 'note', label: '处理备注', children: viewing.handlingNote || '—' }, { key: 'createdAt', label: '创建时间', children: formatDateTime(viewing.createdAt) }] : []} />{viewing && !canAdjustOrderNet(viewing.order) && <p role="note">{unsettledAdjustmentMessage}</p>}{viewing && <AfterSaleMessages messages={viewing.messages ?? []} />}</Modal>
    </div>
  )
}

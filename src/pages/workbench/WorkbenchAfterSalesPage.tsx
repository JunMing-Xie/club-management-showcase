import { EyeOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons'
import { App, Button, Card, Descriptions, Drawer, Empty, Form, Input, Tag } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../../api'
import { formatDateTime, formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import type { Order } from '../../types'
import { AfterSaleMessages, type AfterSaleMessage } from '../../components/AfterSaleMessages'
import { RequestError } from '../../components/RequestState'

type AfterSale = {
  id: string
  caseNo: string
  issueType: string
  description: string
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED'
  resultType: string | null
  compensationCents: number
  refundCents: number
  supplementaryOrder?: { id: string; orderNo: string } | null
  handlingNote: string | null
  createdAt: string
  handledAt: string | null
  order: Order
  messages?: AfterSaleMessage[]
}

const statusMeta = { PENDING: { label: '待处理', color: 'warning' }, PROCESSING: { label: '处理中', color: 'processing' }, COMPLETED: { label: '已完成', color: 'success' } } as const

export const WorkbenchAfterSalesPage = () => {
  const { message } = App.useApp()
  const [items, setItems] = useState<AfterSale[]>([])
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [viewing, setViewing] = useState<AfterSale | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    setHasError(false)
    try {
      const { data } = await api.get<{ items: AfterSale[] }>('/workbench/aftersales')
      setItems(data.items)
      setViewing((current) => current ? data.items.find((item) => item.id === current.id) ?? null : null)
    } catch (error) {
      setHasError(true)
      message.error(getErrorMessage(error))
    } finally { setLoading(false) }
  }, [message])

  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)

  const sendNote = async () => {
    if (!viewing || !note.trim()) return
    setSending(true)
    try {
      await api.post(`/after-sales/${viewing.id}/messages`, { content: note.trim() })
      message.success('说明已提交')
      setNote('')
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
    finally { setSending(false) }
  }

  if (loading) return <div className="page-loading"><span>正在加载我的售后…</span></div>
  if (hasError) return <RequestError onRetry={() => void load()} />

  return (
    <div className="workbench-stack">
      <section className="mobile-page-heading"><div><div className="eyebrow">我的售后 · 问题跟进</div><h1>我的售后</h1></div><Button type="text" icon={<ReloadOutlined />} onClick={() => void load()} aria-label="刷新售后" /></section>
      {items.length === 0 ? <Card variant="borderless" className="empty-card"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无与本人相关的售后记录" /></Card> : <div className="mobile-after-sale-list">{items.map((item) => <Card key={item.id} variant="borderless" className="mobile-after-sale-card"><div className="mobile-order-top"><span className="mono-text">{item.caseNo}</span><Tag color={statusMeta[item.status].color}>{statusMeta[item.status].label}</Tag></div><h3>{item.issueType}</h3><div className="mobile-after-sale-order">订单 {item.order.orderNo} · {item.order.serviceItem}</div><p className="mobile-after-sale-description">{item.description}</p><div className="mobile-after-sale-foot"><span>{formatDateTime(item.createdAt)}</span><Button type="link" icon={<EyeOutlined />} onClick={() => setViewing(item)}>查看详情</Button></div></Card>)}</div>}
      <Drawer className="workbench-order-drawer" rootClassName="workbench-order-drawer-root" getContainer={false} title="售后详情" open={Boolean(viewing)} onClose={() => { setViewing(null); setNote('') }} placement="bottom" size="min(82vh, 640px)">
        {viewing && <div className="workbench-aftersale-detail"><Descriptions column={1} size="small" items={[{ key: 'caseNo', label: '售后编号', children: viewing.caseNo }, { key: 'order', label: '关联订单', children: viewing.order.orderNo }, { key: 'service', label: '服务项目', children: viewing.order.serviceItem }, { key: 'issue', label: '问题类型', children: viewing.issueType }, { key: 'description', label: '问题描述', children: viewing.description }, { key: 'status', label: '处理状态', children: <Tag color={statusMeta[viewing.status].color}>{statusMeta[viewing.status].label}</Tag> }, { key: 'result', label: '处理结果', children: `${viewing.resultType === 'COMPENSATION' ? '补偿' : viewing.resultType === 'SUPPLEMENTARY_ORDER' ? '补单' : viewing.resultType === 'REFUND' ? '退款记录' : '待登记'} · 补偿 ${formatMoney(viewing.compensationCents)} · 退款记录 ${formatMoney(viewing.refundCents)}` }, { key: 'supplementary', label: '关联补单', children: viewing.supplementaryOrder?.orderNo || '—' }, { key: 'note', label: '处理备注', children: viewing.handlingNote || '—' }, { key: 'handledAt', label: '处理时间', children: viewing.handledAt ? formatDateTime(viewing.handledAt) : '尚未处理' }]} /><div className="workbench-aftersale-messages"><AfterSaleMessages messages={viewing.messages ?? []} /><Form onFinish={() => void sendNote()}><Form.Item><Input.TextArea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={4000} placeholder="补充服务情况或处理说明" /></Form.Item><Button type="primary" htmlType="submit" icon={<SendOutlined />} loading={sending} disabled={!note.trim()}>提交说明</Button></Form></div></div>}
      </Drawer>
    </div>
  )
}

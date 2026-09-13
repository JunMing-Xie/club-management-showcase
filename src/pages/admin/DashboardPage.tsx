import { beijingGreeting } from '../../beijing-greeting'
import { ArrowRightOutlined, CheckCircleOutlined, ClockCircleOutlined, DollarOutlined, TeamOutlined } from '@ant-design/icons'
import { App, Card, Col, Empty, Row, Spin, Statistic, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getErrorMessage } from '../../api'
import { useRealtimeRefresh } from '../../realtime'
import { formatDateTime, formatMoney } from '../../helpers'
import { getOrderDisplayStatus, type Order } from '../../types'
import { RequestError } from '../../components/RequestState'
import { AdminReminderOverview } from '../../components/AdminReminders'

type DashboardData = {
  slogan: string
  today: { orderCount: number; completedOrderCount: number; revenueCents: number; staffEarningsCents: number }
  inProgressCount: number
  idleStaffCount: number
  busyStaffCount: number
  recentOrders: Order[]
  dailyStats: Array<{ date: string; label: string; revenueCents: number; orderCount: number; completedOrderCount: number }>
  monthlyStats: Array<{ month: string; label: string; revenueCents: number; orderCount: number; completedOrderCount: number; staffEarningsCents: number }>
}

export const DashboardPage = () => {
  const { message } = App.useApp()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30000); return () => window.clearInterval(timer) }, [])
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    setHasError(false)
    try {
      const response = await api.get<DashboardData>('/dashboard/summary')
      setData(response.data)
    } catch (error) {
      setHasError(true)
      message.error(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)

  if (loading) return <div className="page-loading"><Spin /></div>
  if (hasError || !data) return <RequestError onRetry={() => void load()} />

  const cards = [
    { label: '今日订单数', value: data.today.orderCount, suffix: '单', icon: <ClockCircleOutlined />, tone: 'primary', path: '/admin/orders?scope=today' },
    { label: '进行中订单', value: data.inProgressCount, suffix: '单', icon: <ArrowRightOutlined />, tone: 'blue', path: '/admin/orders?status=IN_PROGRESS' },
    { label: '已完成订单', value: data.today.completedOrderCount, suffix: '单', icon: <CheckCircleOutlined />, tone: 'green', path: '/admin/orders?status=COMPLETED&scope=today' },
    { label: '今日订单金额', value: formatMoney(data.today.revenueCents), icon: <DollarOutlined />, tone: 'ink', path: '/admin/finance?scope=today' },
    { label: '今日员工实际应得', value: formatMoney(data.today.staffEarningsCents), icon: <DollarOutlined />, tone: 'sand', path: '/admin/finance?scope=today' },
    { label: '员工在线状态', value: `${data.idleStaffCount} / ${data.busyStaffCount}`, suffix: '空闲 / 忙碌', icon: <TeamOutlined />, tone: 'purple', path: '/admin/staff' },
  ]
  const maxRevenue = Math.max(...data.dailyStats.map((item) => item.revenueCents), 1)

  return (
    <div className="content-stack">
      <section className="page-intro"><div><div className="eyebrow">今日概览 · {now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div><Typography.Title level={2}>{beijingGreeting(now)}，管理员</Typography.Title><Typography.Paragraph>{data.slogan}</Typography.Paragraph></div><div className="intro-pulse"><span className="live-dot" /><span>实时更新</span></div></section>
      <AdminReminderOverview />
      <Row gutter={[16, 16]} className="metric-grid">{cards.map((card) => <Col xs={24} sm={12} xl={8} key={card.label}><Card className={`metric-card metric-${card.tone} metric-card-link`} variant="borderless" role="link" tabIndex={0} onClick={() => navigate(card.path)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(card.path) }}><div className="metric-icon">{card.icon}</div><Statistic title={card.label} value={card.value} suffix={card.suffix} /></Card></Col>)}</Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}><Card title={<div><span>近 7 日经营节奏</span><span className="card-subtitle">订单金额 / 每日</span></div>} className="chart-card"><div className="bar-chart" role="img" aria-label="近七日订单金额柱状图">{data.dailyStats.map((item) => <div className="bar-column" key={item.date}><div className="bar-value">{item.revenueCents ? formatMoney(item.revenueCents).replace('¥', '') : '—'}</div><div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max(item.revenueCents / maxRevenue * 100, item.revenueCents ? 12 : 3)}%` }} /></div><div className="bar-label">{item.label}</div><div className="bar-count">{item.orderCount} 单</div></div>)}</div></Card></Col>
        <Col xs={24} xl={9}><Card title={<div><span>本月进度</span><span className="card-subtitle">月度累计</span></div>} className="chart-card"><div className="month-summary"><div className="month-total">{formatMoney(data.monthlyStats[data.monthlyStats.length - 1]?.revenueCents ?? 0)}</div><div className="month-label">本月订单金额</div><div className="month-detail-row"><span>订单量</span><strong>{data.monthlyStats[data.monthlyStats.length - 1]?.orderCount ?? 0} 单</strong></div><div className="month-detail-row"><span>已完成</span><strong>{data.monthlyStats[data.monthlyStats.length - 1]?.completedOrderCount ?? 0} 单</strong></div><div className="month-detail-row"><span>员工实际应得</span><strong>{formatMoney(data.monthlyStats[data.monthlyStats.length - 1]?.staffEarningsCents ?? 0)}</strong></div></div></Card></Col>
      </Row>
      <Card title={<div><span>最近订单</span><span className="card-subtitle">最新 8 条 · 点击订单号查看详情</span></div>} className="table-card"><Table<Order> rowKey="id" dataSource={data.recentOrders} pagination={false} scroll={{ x: 680 }} columns={[{ title: '订单号', dataIndex: 'orderNo', render: (value: string, order: Order) => <button type="button" className="dashboard-order-link mono-text" onClick={() => navigate(`/admin/orders?orderId=${order.id}`)}>{value}</button> }, { title: '客户', dataIndex: ['customer', 'name'] }, { title: '服务项目', dataIndex: 'serviceItem' }, { title: '金额', dataIndex: 'amountCents', render: (value: number) => <strong>{formatMoney(value)}</strong> }, { title: '员工', key: 'staff', render: (_: unknown, order: Order) => order.assignments.filter((assignment) => assignment.staff && assignment.assignmentStatus !== 'EXITED').map((assignment) => assignment.staff?.name).join('、') || <span className="muted">待接单</span> }, { title: '状态', dataIndex: 'status', render: (_: unknown, order: Order) => { const status = getOrderDisplayStatus(order); return <Tag color={status.color}>{status.tagLabel}</Tag> } }, { title: '创建时间', dataIndex: 'createdAt', render: (value: string) => formatDateTime(value) }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有订单" /> }} /></Card>
    </div>
  )
}

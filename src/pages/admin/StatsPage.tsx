import { useAuth } from '../../auth-context'
import { hasUserPermission } from '../../types'
import { DispatchStatistics } from '../../components/DispatchStatistics'
import { BarChartOutlined, CheckCircleOutlined, DollarOutlined, TeamOutlined } from '@ant-design/icons'
import { App, Card, Col, Row, Spin, Statistic, Table, Tag } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../../api'
import { formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import { staffStatusMeta, type StaffStatus } from '../../types'
import { RequestError } from '../../components/RequestState'

type Overview = {
  today: { orderCount: number; completedOrderCount: number; revenueCents: number; staffEarningsCents: number }
  month: { orderCount: number; completedOrderCount: number; revenueCents: number; staffEarningsCents: number }
  dailyStats: Array<{ date: string; label: string; orderCount: number; completedOrderCount: number; revenueCents: number }>
  monthlyStats: Array<{ month: string; label: string; orderCount: number; completedOrderCount: number; revenueCents: number; staffEarningsCents: number }>
  byStaff: Array<{ id: string; name: string; status: StaffStatus; orderCount: number; completedOrderCount: number; revenueCents: number; staffEarningsCents: number }>
}

const BusinessStatistics = () => {
  const { message } = App.useApp()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const load = useCallback(async () => {
    setHasError(false)
    try { const { data } = await api.get<Overview>('/stats/overview'); setOverview(data) }
    catch (error) { setHasError(true); message.error(getErrorMessage(error)) }
    finally { setLoading(false) }
  }, [message])
  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)
  if (loading) return <div className="page-loading"><Spin /></div>
  if (hasError || !overview) return <RequestError onRetry={() => void load()} />
  const max = Math.max(...overview.dailyStats.map((item) => item.revenueCents), 1)
  return (
    <div className="content-stack"><section className="page-intro compact"><div><div className="eyebrow">经营报表 · 数据趋势</div><h2>经营统计</h2><p>按日、按月和按员工查看基础经营数据。</p></div><BarChartOutlined className="heading-icon" /></section><Row gutter={[16, 16]} className="metric-grid"><Col xs={24} sm={12} xl={6}><Card className="metric-card metric-primary" variant="borderless"><Statistic title="今日订单金额" value={formatMoney(overview.today.revenueCents)} prefix={<DollarOutlined />} /></Card></Col><Col xs={24} sm={12} xl={6}><Card className="metric-card metric-blue" variant="borderless"><Statistic title="今日完成订单" value={overview.today.completedOrderCount} suffix="单" prefix={<CheckCircleOutlined />} /></Card></Col><Col xs={24} sm={12} xl={6}><Card className="metric-card metric-primary" variant="borderless"><Statistic title="本月订单金额" value={formatMoney(overview.month.revenueCents)} prefix={<DollarOutlined />} /></Card></Col><Col xs={24} sm={12} xl={6}><Card className="metric-card metric-blue" variant="borderless"><Statistic title="本月员工实际应得" value={formatMoney(overview.month.staffEarningsCents)} prefix={<TeamOutlined />} /></Card></Col></Row><Row gutter={[16, 16]}><Col xs={24} xl={14}><Card title="日统计 · 近 7 日" className="chart-card"><div className="bar-chart" role="img" aria-label="近七日经营统计图">{overview.dailyStats.map((item) => <div className="bar-column" key={item.date}><div className="bar-value">{item.revenueCents ? formatMoney(item.revenueCents).replace('¥', '') : '—'}</div><div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max(item.revenueCents / max * 100, item.revenueCents ? 12 : 3)}%` }} /></div><div className="bar-label">{item.label}</div><div className="bar-count">{item.orderCount} 单</div></div>)}</div></Card></Col><Col xs={24} xl={10}><Card title="月统计 · 近 6 个月" className="table-card"><Table size="small" rowKey="month" pagination={false} dataSource={overview.monthlyStats} columns={[{ title: '月份', dataIndex: 'label' }, { title: '订单', dataIndex: 'orderCount', render: (value: number) => `${value} 单` }, { title: '订单金额', dataIndex: 'revenueCents', render: (value: number) => formatMoney(value) }]} /></Card></Col></Row><Card title={<div><span>员工统计 · 本月</span><span className="card-subtitle">完成量与实际应得金额</span></div>} className="table-card"><Table size="small" rowKey="id" dataSource={overview.byStaff} pagination={false} scroll={{ x: 720 }} columns={[{ title: '员工', dataIndex: 'name', render: (value: string, item) => <span><strong>{value}</strong> <Tag color={staffStatusMeta[item.status].color}>{staffStatusMeta[item.status].label}</Tag></span> }, { title: '订单总数', dataIndex: 'orderCount', render: (value: number) => `${value} 单` }, { title: '完成订单', dataIndex: 'completedOrderCount', render: (value: number) => `${value} 单` }, { title: '订单金额', dataIndex: 'revenueCents', render: (value: number) => formatMoney(value) }, { title: '员工实际应得', dataIndex: 'staffEarningsCents', render: (value: number) => <strong className="money-strong">{formatMoney(value)}</strong> }]} /></Card></div>
  )
}

export const StatsPage = () => { const { user } = useAuth(); return <div className="content-stack">{hasUserPermission(user, 'dispatch.view') && <DispatchStatistics />}{hasUserPermission(user, 'stats.view') && <BusinessStatistics />}</div> }

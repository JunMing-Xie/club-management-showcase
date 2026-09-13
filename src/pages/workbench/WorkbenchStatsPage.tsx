import { BarChartOutlined, RightOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, DatePicker, Drawer, Empty, Row, Space, Spin, Statistic } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getErrorMessage } from '../../api'
import { formatDateTime, formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import { RequestError } from '../../components/RequestState'

type Query = { period?: string; startDate?: string; endDate?: string }
type Summary = { completedCount: number; earningsCents: number; settledCents: number; pendingSettlementCents: number; overSettledCents: number }
type Range = { start: string; end: string } | null
type StaffStats = {
  todayCompletedCount: number; monthCompletedCount: number; todayEarningsCents: number; monthEarningsCents: number
  totalCompletedCount: number; totalEarningsCents: number; settledCents: number; pendingSettlementCents: number; overSettledCents: number
  profile?: { tier?: { name: string } | null }; selected: (Summary & { range: Range }) | null
  history: Array<{ month: string; label: string; completedOrderCount: number; staffEarningsCents: number }>
}
type Detail = {
  range: Range; summary: Summary; allocationNote: string
  orders: Array<{ id: string; orderNo: string; serviceItem: string; completedAt: string; status: string; customerCode: string; currentActualEarningCents: number; allocatedSettlementCents: number; pendingSettlementCents: number }>
  settlements: Array<{ id: string; amountCents: number; settlementMethod: string; settledAt: string; note: string | null }>
}
type Drill = { title: string; kind: 'orders' | 'earnings' | 'settled' | 'pending'; query: Query }
const rangeLabel = (range: Range) => range ? `${dayjs(range.start).format('YYYY-MM-DD')} → ${dayjs(range.end).format('YYYY-MM-DD')}（含结束日全天）` : '累计全部时间'

export const WorkbenchStatsPage = () => {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [stats, setStats] = useState<StaffStats | null>(null)
  const [query, setQuery] = useState<Query>({})
  const [start, setStart] = useState<Dayjs | null>(null)
  const [end, setEnd] = useState<Dayjs | null>(null)
  const [hasError, setHasError] = useState(false)
  const [drill, setDrill] = useState<Drill | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailError, setDetailError] = useState(false)
  const requestId = useRef(0)
  const detailId = useRef(0)
  const load = useCallback(async () => {
    const id = ++requestId.current
    try {
      const { data } = await api.get<{ item: StaffStats }>('/workbench/stats', { params: query })
      if (id === requestId.current) { setStats(data.item); setHasError(false) }
    } catch (error) { if (id === requestId.current) { setHasError(true); message.error(getErrorMessage(error)) } }
  }, [message, query])
  const loadDetail = useCallback(async () => {
    const id = ++detailId.current
    if (!drill) return
    try {
      const { data } = await api.get<{ item: Detail }>('/workbench/stats/details', { params: drill.query })
      if (id === detailId.current) { setDetail(data.item); setDetailError(false) }
    } catch (error) { if (id === detailId.current) { setDetailError(true); message.error(getErrorMessage(error)) } }
  }, [drill, message])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadDetail() }, [loadDetail])
  const refresh = useCallback(() => { void load(); void loadDetail() }, [load, loadDetail])
  useRealtimeRefresh(refresh)
  const open = (title: string, kind: Drill['kind'], selectedQuery: Query) => {
    setDetail(null); setDetailError(false); setDrill({ title, kind, query: selectedQuery })
  }
  const applyRange = () => {
    if (!start || !end || start.startOf('day').isAfter(end.startOf('day'))) { message.error('请选择有效的开始和结束日期'); return }
    setStats(null); setQuery({ startDate: start.format('YYYY-MM-DD'), endDate: end.format('YYYY-MM-DD') })
  }
  const thisWeek = () => {
    const monday = dayjs().startOf('day').subtract((dayjs().day() + 6) % 7, 'day')
    setStart(monday); setEnd(monday.add(6, 'day')); setStats(null); setQuery({ period: 'week' })
  }
  const metric = (title: string, value: number, kind: Drill['kind'], selectedQuery: Query, count = false) => <Col span={12} key={title}>
    <button type="button" className="staff-stat-click" onClick={() => open(title, kind, selectedQuery)} aria-label={`查看${title}明细`}>
      <Card variant="borderless"><Statistic title={<span>{title} <RightOutlined /></span>} value={count ? value : formatMoney(value)} suffix={count ? '单' : undefined} /></Card>
    </button>
  </Col>
  const max = Math.max(...(stats?.history ?? []).map((item) => item.staffEarningsCents), 1)
  return <div className="workbench-stack">
    <section className="mobile-page-heading"><div><div className="eyebrow">我的统计 · 收入</div><h1>我的统计</h1></div><BarChartOutlined className="heading-icon" /></section>
    <Card title="日期范围" variant="borderless">
      <div className="staff-stat-dates"><DatePicker aria-label="开始日期" value={start} onChange={setStart} placeholder="开始日期" inputReadOnly /><DatePicker aria-label="结束日期" value={end} onChange={setEnd} placeholder="结束日期" inputReadOnly /></div>
      <Space wrap style={{ marginTop: 12 }}><Button type="primary" onClick={applyRange}>查询</Button><Button onClick={thisWeek}>本周</Button><Button onClick={() => { setStart(null); setEnd(null); setStats(null); setQuery({}) }}>重置</Button></Space>
      <p className="card-subtitle">按北京时间，完单日期查询当前净应得；已结算按结算日期查询。</p>
    </Card>
    {hasError ? <RequestError onRetry={() => void load()} /> : !stats ? <Spin /> : <>
      {stats.selected && <section aria-label="所选区间统计"><h3>所选区间统计</h3><p>{rangeLabel(stats.selected.range)}</p><Row gutter={[12, 12]} className="workbench-metrics">
        {metric('区间完成订单', stats.selected.completedCount, 'orders', query, true)}
        {metric('区间实际应得', stats.selected.earningsCents, 'earnings', query)}
        {metric('区间已结算', stats.selected.settledCents, 'settled', query)}
        {metric('区间订单待结算', stats.selected.pendingSettlementCents, 'pending', query)}
      </Row><p className="card-subtitle">待结算为区间完单订单的当前余额；账户累计待冲抵 {formatMoney(stats.selected.overSettledCents)}。</p></section>}
      <Row gutter={[12, 12]} className="workbench-metrics">
        {metric('今日完成订单', stats.todayCompletedCount, 'orders', { period: 'today' }, true)}
        {metric('本月完成订单', stats.monthCompletedCount, 'orders', { period: 'month' }, true)}
        {metric('今日实际应得', stats.todayEarningsCents, 'earnings', { period: 'today' })}
        {metric('本月实际应得', stats.monthEarningsCents, 'earnings', { period: 'month' })}
      </Row>
      <Card className="workbench-period-card" variant="borderless">
        <div className="period-line"><span>累计完成订单</span><strong>{stats.totalCompletedCount} 单</strong></div>
        <div className="period-line"><span>累计实际应得</span><strong>{formatMoney(stats.totalEarningsCents)}</strong></div>
        <button className="period-line staff-stat-line" onClick={() => open('已结算', 'settled', { period: 'all' })}><span>已结算 <RightOutlined /></span><strong>{formatMoney(stats.settledCents)}</strong></button>
        <button className="period-line staff-stat-line" onClick={() => open('待结算', 'pending', { period: 'all' })}><span>待结算 <RightOutlined /></span><strong>{formatMoney(stats.pendingSettlementCents)}</strong></button>
        {stats.overSettledCents > 0 && <div className="period-line"><span>待冲抵 / 超额结算</span><strong>{formatMoney(stats.overSettledCents)}</strong></div>}
        <div className="period-line"><span>当前档位</span><strong>{stats.profile?.tier?.name ?? '未设置'}</strong></div>
      </Card>
      <Card title="近 6 个月实际应得" variant="borderless" className="history-card"><div className="history-bars">{stats.history.map((item) => <div className="history-bar-item" key={item.month}><div className="history-bar-track"><div className="history-bar-fill" style={{ height: `${Math.max(item.staffEarningsCents / max * 100, item.staffEarningsCents ? 12 : 3)}%` }} /></div><strong>{item.staffEarningsCents ? formatMoney(item.staffEarningsCents).replace('¥', '') : '—'}</strong><span>{item.label.replace(/\d{4}年/, '')}</span><small>{item.completedOrderCount} 单</small></div>)}</div></Card>
      <Card variant="borderless">实际应得 = 原始实际应得 + 售后收益调整。未完单金额不计入；工资 / 佣金由俱乐部线下发放。</Card>
    </>}
    <Drawer title={`${drill?.title ?? ''}明细`} open={Boolean(drill)} onClose={() => { ++detailId.current; setDrill(null) }} placement="bottom" size="88vh" className="workbench-order-drawer" rootClassName="workbench-order-drawer-root" getContainer={false}>
      {detailError ? <RequestError onRetry={() => void loadDetail()} /> : !detail ? <Spin /> : <div className="workbench-stack">
        <p>{rangeLabel(detail.range)}</p>
        <strong>合计：{drill?.kind === 'orders' ? `${detail.summary.completedCount} 单` : formatMoney(drill?.kind === 'settled' ? detail.summary.settledCents : drill?.kind === 'pending' ? detail.summary.pendingSettlementCents : detail.summary.earningsCents)}</strong>
        {drill?.kind === 'pending' && <><p>{detail.allocationNote}</p><strong>账户累计待冲抵 {formatMoney(detail.summary.overSettledCents)}</strong></>}
        {drill?.kind === 'settled' ? detail.settlements.length ? detail.settlements.map((item) => <Card key={item.id} size="small"><strong>{formatMoney(item.amountCents)}</strong><p>{item.settlementMethod} · {formatDateTime(item.settledAt)}</p><p>{item.note || '无备注'}</p></Card>) : <Empty description="该区间暂无结算记录" />
          : detail.orders.length ? detail.orders.map((item) => <Card key={item.id} size="small"><Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/workbench/orders?orderId=${encodeURIComponent(item.id)}`)}>{item.orderNo} <RightOutlined /></Button><p>{item.serviceItem} · {item.status === 'AFTER_SALE' ? '售后中（已完单）' : '已完成'}</p><p>完成时间：{formatDateTime(item.completedAt)}</p><p>客户ID：{item.customerCode}</p><strong>当前实际应得 {formatMoney(item.currentActualEarningCents)}</strong>{drill?.kind === 'pending' && <p>已结算（展示分摊）{formatMoney(item.allocatedSettlementCents)} · 当前待结算 {formatMoney(item.pendingSettlementCents)}</p>}</Card>) : <Empty description="该区间暂无完成订单" />}
      </div>}
    </Drawer>
  </div>
}

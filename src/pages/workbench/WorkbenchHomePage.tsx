import { ArrowRightOutlined, CheckCircleOutlined, ClockCircleOutlined, DollarOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, Row, Statistic } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getErrorMessage } from '../../api'
import { useRealtimeRefresh } from '../../realtime'
import { formatMoney } from '../../helpers'
import { staffStatusMeta, type StaffStatus } from '../../types'
import { RequestError } from '../../components/RequestState'

type WorkbenchSummary = {
  profile: { name: string; status: StaffStatus; presence?: 'ONLINE' | 'OFFLINE'; accepting?: 'ACCEPTING' | 'PAUSED'; tier?: { name: string } | null }
  welcome?: { title: string; subtitle: string }
  todayOrderCount: number
  todayCompletedCount: number
  todayPendingCount: number
  todayInProgressCount: number
  todayEarningsCents: number
  monthCompletedCount: number
  monthEarningsCents: number
  availableOrderCount?: number
}

export const WorkbenchHomePage = () => {
  const { message } = App.useApp()
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const navigate = useNavigate()
  const load = useCallback(async () => {
    setHasError(false)
    try { const { data } = await api.get<WorkbenchSummary>('/workbench/summary'); setSummary(data) }
    catch (error) { setHasError(true); message.error(getErrorMessage(error)) }
    finally { setLoading(false) }
  }, [message])
  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)
  if (loading) return <div className="page-loading"><span>正在加载工作台…</span></div>
  if (hasError || !summary) return <RequestError onRetry={() => void load()} />
  const status = staffStatusMeta[summary.profile.status]
  const availableOrderCount = summary.availableOrderCount ?? 0
  const hasAvailableOrders = availableOrderCount > 0
  const hasPendingOrders = summary.todayPendingCount > 0
  const nextOrderTitle = hasAvailableOrders ? '你有 ' + availableOrderCount + ' 个可接订单' : hasPendingOrders ? '你有 ' + summary.todayPendingCount + ' 个待处理订单' : '当前没有待处理订单'
  const nextOrderText = hasAvailableOrders ? '进入可接订单，接取下一项服务。' : hasPendingOrders ? '进入待处理订单，开始下一项服务。' : '可接订单会实时出现在订单池中。'
  const nextOrderPath = hasAvailableOrders ? '/workbench/orders?tab=AVAILABLE' : hasPendingOrders ? '/workbench/orders?tab=PENDING' : '/workbench/orders?tab=AVAILABLE'
  const nextOrderActionLabel = hasAvailableOrders ? '查看可接订单' : hasPendingOrders ? '查看待处理订单' : '查看可接订单'

  return (
    <div className="workbench-stack">
      <section className="workbench-welcome"><div><div className="eyebrow">工作台 · 今日</div><h1>{summary.welcome?.title ?? `${summary.profile.name}，今天辛苦了。`}</h1><p>{summary.welcome?.subtitle ?? '把每个进度更新好，现场就会一直清楚。'}</p></div><div className={'workbench-status-card ' + summary.profile.status.toLowerCase()}><span className="status-pip" /><span>{status.label}</span><small>当前状态</small></div></section>
      <Card className="next-order-card" variant="borderless"><div className="next-order-icon"><ThunderboltOutlined /></div><div><div className="eyebrow">下一步</div><h3>{nextOrderTitle}</h3><p>{nextOrderText}</p></div><Button type="primary" shape="circle" icon={<ArrowRightOutlined />} onClick={() => navigate(nextOrderPath)} aria-label={nextOrderActionLabel} /></Card>
      <Row gutter={[12, 12]} className="workbench-metrics"><Col span={12}><Card variant="borderless"><Statistic title="今日订单" value={summary.todayOrderCount} suffix="单" prefix={<ClockCircleOutlined />} /></Card></Col><Col span={12}><Card variant="borderless"><Statistic title="今日完成" value={summary.todayCompletedCount} suffix="单" prefix={<CheckCircleOutlined />} /></Card></Col><Col span={12}><Card variant="borderless"><Statistic title="进行中" value={summary.todayInProgressCount} suffix="单" prefix={<ThunderboltOutlined />} /></Card></Col><Col span={12}><Card variant="borderless"><Statistic title="今日实际应得" value={formatMoney(summary.todayEarningsCents)} prefix={<DollarOutlined />} /></Card></Col></Row>
      <Card className="workbench-period-card" variant="borderless"><div className="period-line"><span>本月完成</span><strong>{summary.monthCompletedCount} 单</strong></div><div className="period-line"><span>本月实际应得</span><strong>{formatMoney(summary.monthEarningsCents)}</strong></div><div className="period-rule" /><div className="period-note">待处理、进行中的金额仅作预计，不计入实际应得汇总；实际工资 / 佣金由俱乐部线下发放。</div></Card>
    </div>
  )
}

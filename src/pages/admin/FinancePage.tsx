import { useAuth } from '../../auth-context'
import { hasUserPermission } from '../../types'
import { DollarOutlined, ReloadOutlined, TeamOutlined, WalletOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, DatePicker, Empty, Form, Input, InputNumber, Modal, Row, Select, Spin, Statistic, Table, Tag } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, getErrorMessage } from '../../api'
import { formatDateTime, formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import { FinanceStaffSettlements, type StaffSettlementReport } from '../../components/FinanceStaffSettlements'
import { RequestError } from '../../components/RequestState'

type FinanceOverview = {
  completedOrderCount: number
  revenueCents: number
  staffEarningsCents: number
  afterSaleExpenseCents: number
  totalExpenseCents: number
  profitCents: number
  pendingStaffEarningsCents: number
  overSettledCents?: number
  principalRechargeCents: number
  bonusRechargeCents: number
  consumptionCents: number
  settlementMode: string
}
type Settlement = { id: string; amountCents: number; settlementMethod: string; note: string | null; createdAt: string; settledAt: string; staff: { name: string }; operator: { username: string } }
type SettlementOption = { id: string; name: string; earnedCents: number; settledCents: number; pendingSettlementCents: number; overSettledCents: number }
type SettlementForm = { staffId: string; amount: number; settlementMethod: string; settlementDate: Dayjs; note?: string }
type AppliedDateRange = [Dayjs, Dayjs] | null
type PickerDateRange = [Dayjs | null, Dayjs | null] | null

export const FinancePage = () => {
  const { message } = App.useApp()
  const { user } = useAuth()
  const canSettle = hasUserPermission(user, 'settlement.manage')
  const [searchParams] = useSearchParams()
  const initialRange: AppliedDateRange = searchParams.get('scope') === 'today' ? [dayjs().startOf('day'), dayjs().endOf('day')] : null
  const [period, setPeriod] = useState(searchParams.get('scope') === 'today' ? 'today' : 'week')
  const [staffReport, setStaffReport] = useState<StaffSettlementReport | null>(null)
  const [overview, setOverview] = useState<FinanceOverview | null>(null)
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [settlementOptions, setSettlementOptions] = useState<SettlementOption[]>([])
  const [settlementOpen, setSettlementOpen] = useState(false)
  const [settlementRequestId, setSettlementRequestId] = useState('')
  const [settlementForm] = Form.useForm<SettlementForm>()
  const [range, setRange] = useState<PickerDateRange>(initialRange)
  const [appliedRange, setAppliedRange] = useState<AppliedDateRange>(initialRange)
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const loadSequence = useRef(0)
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setHasError(false)
    setLoading(true)
    const query = period === 'custom' && appliedRange ? { period, startDate: appliedRange[0].format('YYYY-MM-DD'), endDate: appliedRange[1].format('YYYY-MM-DD') } : { period }
    try {
      const staffResponse = await api.get<{ item: StaffSettlementReport }>('/finance/staff-settlement-summary', { params: query })
      const report = staffResponse.data.item
      const params = { startDate: report.range.startDate, endDate: report.range.endDate }
      const [overviewResponse, settlementsResponse, optionsResponse] = await Promise.all([
        api.get<{ item: FinanceOverview }>('/finance/overview', { params }),
        api.get<{ items: Settlement[] }>('/finance/settlements', { params }),
        canSettle ? api.get<{ items: SettlementOption[] }>('/finance/settlement-options') : Promise.resolve({ data: { items: [] as SettlementOption[] } }),
      ])
      if (sequence !== loadSequence.current) return
      setStaffReport(report)
      if (period !== 'custom') setRange([dayjs(params.startDate), dayjs(params.endDate)])
      setOverview(overviewResponse.data.item)
      setSettlements(settlementsResponse.data.items)
      setSettlementOptions(optionsResponse.data.items)
    } catch (error) {
      if (sequence !== loadSequence.current) return
      setHasError(true)
      message.error(getErrorMessage(error))
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [appliedRange, period, message, canSettle])
  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)
  const applyRange = () => {
    if (!range || !range[0] || !range[1]) {
      message.warning('请选择完整的开始日期和结束日期')
      return
    }
    setPeriod('custom')
    setAppliedRange([range[0], range[1]])
  }
  const resetRange = () => {
    setPeriod('week')
    setAppliedRange(null)
  }
  const exportFinance = async () => {
    try {
      const params = staffReport ? { startDate: staffReport.range.startDate, endDate: staffReport.range.endDate } : undefined
      const response = await api.get('/finance/export', { responseType: 'blob', params })
      const url = URL.createObjectURL(response.data as Blob)
      const link = document.createElement('a')
      link.href = url
      link.download = '俱乐部运营财务经营明细.xlsx'
      link.click()
      URL.revokeObjectURL(url)
      message.success('财务明细已导出')
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  const openSettlement = () => {
    setSettlementRequestId(crypto.randomUUID())
    settlementForm.resetFields()
    settlementForm.setFieldsValue({ settlementMethod: '线下现金', settlementDate: dayjs() })
    setSettlementOpen(true)
  }
  const saveSettlement = async (values: SettlementForm) => {
    try {
      await api.post(`/staff/${values.staffId}/settlements`, { requestId: settlementRequestId, amount: values.amount, settlementMethod: values.settlementMethod, settlementDate: values.settlementDate.format('YYYY-MM-DD'), note: values.note ?? '' })
      message.success('线下结算已登记')
      setSettlementOpen(false)
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  if (loading) return <div className="page-loading"><Spin /></div>
  if (hasError || !overview || !staffReport) return <RequestError onRetry={() => void load()} />
  const rangeDescription = `当前统计区间：${staffReport.range.startDate} 至 ${staffReport.range.endDate}（含结束日全天）`
  return (
    <div className="content-stack finance-page">
      <section className="page-intro compact"><div><div className="eyebrow">财务中心 · 系统经营口径</div><h2>财务中心</h2><p>只统计已完成订单与已记录费用，员工工资采用线下人工结算。</p></div><div><Button type="primary" disabled={!canSettle} onClick={openSettlement}>线下人工结算</Button><Button type="text" onClick={() => void exportFinance()}>导出明细</Button><Button type="text" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button></div></section>
      <Card className="filter-card finance-range-filter" variant="borderless"><div className="finance-period-shortcuts">{([{ key: 'week', label: '本周' }, { key: 'lastWeek', label: '上周' }, { key: 'month', label: '本月' }, { key: 'lastMonth', label: '上月' }] as const).map(item => <Button key={item.key} type={period === item.key ? 'primary' : 'default'} onClick={() => { setPeriod(item.key); setAppliedRange(null) }}>{item.label}</Button>)}<Tag>自定义日期：选择后点击查询</Tag></div><div className="finance-range-controls"><span className="finance-range-label">统计日期</span><DatePicker.RangePicker value={range} onChange={(values) => setRange(values as PickerDateRange)} placeholder={['开始日期', '结束日期']} allowClear /><Button type="primary" onClick={applyRange}>查询</Button><Button onClick={resetRange}>重置</Button><span className="filter-note">{rangeDescription}</span></div></Card>
      <Card className="filter-card finance-notice" variant="borderless"><Tag color="processing">系统经营口径</Tag><span>收入、员工实际应得和售后费用均按已完成记录统计，不接在线支付、不自动打款。</span></Card>
      <Row gutter={[16, 16]} className="metric-grid">
        <Col xs={24} sm={12} xl={6}><Card className="metric-card metric-primary" variant="borderless"><Statistic title="已完成订单收入" value={formatMoney(overview.revenueCents)} prefix={<DollarOutlined />} /></Card></Col>
        <Col xs={24} sm={12} xl={6}><Card className="metric-card metric-blue" variant="borderless"><Statistic title="期间员工净应得" value={formatMoney(staffReport.summary.netEarningCents)} prefix={<TeamOutlined />} /></Card></Col>
        <Col xs={24} sm={12} xl={6}><Card className="metric-card metric-primary" variant="borderless"><Statistic title="经营利润（系统口径）" value={formatMoney(overview.profitCents)} prefix={<WalletOutlined />} /></Card></Col>
        <Col xs={24} sm={12} xl={6}><Card className="metric-card metric-blue" variant="borderless"><Statistic title="截至期末待结算" value={formatMoney(staffReport.summary.pendingCents)} prefix={<TeamOutlined />} /></Card></Col>
      </Row>
      {Boolean(staffReport.summary.offsetCents) && <Card className="filter-card finance-notice" variant="borderless"><Tag color="warning">待冲抵 / 超额结算</Tag><span>截至期末，部分员工已结算金额超过净应得，共待冲抵 {formatMoney(staffReport.summary.offsetCents)}，请在线下后续结算中处理。</span></Card>}
      <Card className="table-card" variant="borderless"><div className="finance-summary-grid"><div><span>期间员工参与订单金额</span><strong>{formatMoney(staffReport.summary.participationAmountCents)}</strong></div><div><span>期间已结算</span><strong>{formatMoney(staffReport.summary.settledCents)}</strong></div><div><span>截至期末待冲抵</span><strong>{formatMoney(staffReport.summary.offsetCents)}</strong></div></div><p className="finance-payroll-note">参与订单金额按本期正式完单的原订单金额计入个人业绩，多人订单每人各计一次；不是公司营业额，也不是工资。净应得按完单收益与本期售后调整计算，付款按实际结算日期计入。时间口径：{staffReport.range.timeZone}。</p></Card>
      <Card className="table-card" variant="borderless">
        <div className="table-heading"><div><strong>资金摘要</strong><span className="card-subtitle">充值与消费只作经营记录</span></div><Tag color="default">{overview.settlementMode}</Tag></div>
        <div className="finance-summary-grid"><div><span>已完成订单</span><strong>{overview.completedOrderCount} 单</strong></div><div><span>本金充值</span><strong>{formatMoney(overview.principalRechargeCents)}</strong></div><div><span>赠金入账</span><strong>{formatMoney(overview.bonusRechargeCents)}</strong></div><div><span>订单消费</span><strong>{formatMoney(overview.consumptionCents)}</strong></div><div><span>总支出</span><strong>{formatMoney(overview.totalExpenseCents)}</strong></div><div><span>售后费用</span><strong>{formatMoney(overview.afterSaleExpenseCents)}</strong></div></div>
      </Card>
      <FinanceStaffSettlements report={staffReport} />
      <Card className="table-card finance-payment-records" variant="borderless"><div className="table-heading"><div><strong>员工线下结算记录</strong><span className="card-subtitle">系统只记录，不自动打款</span></div></div><Table<Settlement> rowKey="id" dataSource={settlements} pagination={{ pageSize: 8, showTotal: (total) => '共 ' + total + ' 笔' }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无线下结算记录" /> }} columns={[{ title: '员工', dataIndex: ['staff', 'name'] }, { title: '结算金额', dataIndex: 'amountCents', render: (value: number) => formatMoney(value) }, { title: '方式', dataIndex: 'settlementMethod' }, { title: '操作人', dataIndex: ['operator', 'username'] }, { title: '结算日期', dataIndex: 'settledAt', render: (value: string) => formatDateTime(value) }, { title: '备注', dataIndex: 'note', render: (value: string | null) => value || '—' }]} /></Card>
      <Modal title="登记线下人工结算" open={settlementOpen} onCancel={() => setSettlementOpen(false)} onOk={() => settlementForm.submit()} okText="保存结算记录" cancelText="返回" destroyOnHidden><Form<SettlementForm> form={settlementForm} layout="vertical" onFinish={saveSettlement} preserve={false}><Form.Item name="staffId" label="员工" rules={[{ required: true, message: '请选择员工' }]}><Select showSearch optionFilterProp="label" placeholder="选择有待结算金额的员工" options={settlementOptions.map((item) => ({ value: item.id, label: `${item.name} · 待结算 ${formatMoney(item.pendingSettlementCents)}`, disabled: item.pendingSettlementCents <= 0 }))} /></Form.Item><Form.Item noStyle shouldUpdate={(previous, current) => previous.staffId !== current.staffId}>{({ getFieldValue }) => { const selected = settlementOptions.find((item) => item.id === getFieldValue('staffId')); return <Form.Item name="amount" label="结算金额（元）" extra={selected ? `最多可结算 ${formatMoney(selected.pendingSettlementCents)}` : undefined} rules={[{ required: true, message: '请输入结算金额' }]}><InputNumber min={0.01} max={(selected?.pendingSettlementCents ?? 0) / 100} precision={2} style={{ width: '100%' }} /></Form.Item> }}</Form.Item><Form.Item name="settlementMethod" label="结算方式" rules={[{ required: true, message: '请选择结算方式' }]}><Select options={[{ value: '线下现金', label: '线下现金' }, { value: '银行转账', label: '银行转账' }, { value: '其他线下方式', label: '其他线下方式' }]} /></Form.Item><Form.Item name="settlementDate" label="结算日期" rules={[{ required: true, message: '请选择结算日期' }]}><DatePicker style={{ width: '100%' }} /></Form.Item><Form.Item name="note" label="备注"><Input.TextArea rows={3} maxLength={2000} /></Form.Item></Form></Modal>
    </div>
  )
}

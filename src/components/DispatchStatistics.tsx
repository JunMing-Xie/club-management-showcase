import { Alert, App, Button, Card, Col, DatePicker, Modal, Row, Select, Space, Statistic, Table } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import type { Dayjs } from 'dayjs'
import { api, getErrorMessage } from '../api'
import { roleMeta, orderStatusMeta, type Role, type OrderStatus } from '../types'
import { useRealtimeRefresh } from '../realtime'

type RowItem = { id: string; username: string; role: Exclude<Role, 'ADMIN'>; roleName?: string | null; orderCount: number; operationCount: number; lastAssignedAt: string | null }
type Detail = { id: string; orderId: string; createdAt: string; orderNo: string | null; status: OrderStatus | null; staffName: string | null; slotIndex: string | null; result: string }
type Report = { rows: RowItem[]; details?: Detail[]; total?: number; page?: number; pageSize?: number; summary?: Record<string, number>; history: string; range: { startDate: string; endDate: string } }
const beijingTime = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(value)) : '—'

export const DispatchStatistics = ({ personal = false }: { personal?: boolean }) => {
  const { message } = App.useApp()
  const [period, setPeriod] = useState('week')
  const [dates, setDates] = useState<[Dayjs, Dayjs] | null>(null)
  const [person, setPerson] = useState<RowItem | null>(null)
  const [page, setPage] = useState(1)
  const [report, setReport] = useState<Report | null>(null)
  const [detail, setDetail] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const load = useCallback(async () => {
    if (period === 'custom' && !dates) return
    setLoading(true)
    try {
      const params = { period, ...(period === 'custom' && dates ? { from: dates[0].format('YYYY-MM-DD'), to: dates[1].format('YYYY-MM-DD') } : {}), page }
      const { data } = await api.get<Report>(personal ? '/dispatch-statistics/me' : '/dispatch-statistics', { params })
      setReport(data)
      if (!personal && person) setDetail((await api.get<Report>('/dispatch-statistics', { params: { ...params, operatorId: person.id } })).data)
      setFailed(false)
    } catch (error) { setFailed(true); setReport(null); setDetail(null); message.error(getErrorMessage(error)) }
    finally { setLoading(false) }
  }, [period, dates, page, person, personal, message])
  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)
  const detailTable = (data: Report | null) => <Table<Detail> size="small" rowKey="id" loading={loading} dataSource={data?.details ?? []} scroll={{ x: 730 }} pagination={{ current: data?.page ?? page, pageSize: data?.pageSize ?? 30, total: data?.total ?? 0, showSizeChanger: false, onChange: setPage }} columns={[
    { title: '派单时间（北京时间）', dataIndex: 'createdAt', render: beijingTime },
    { title: '订单号', render: (_, row) => row.orderNo ?? '历史订单已不可用' },
    { title: '被派员工', dataIndex: 'staffName', render: value => value ?? '历史未保留' },
    { title: '名额', dataIndex: 'slotIndex', render: value => value ?? '历史未记录' },
    { title: '当前状态', dataIndex: 'status', render: (value: OrderStatus | null) => value ? orderStatusMeta[value].label : '—' },
    { title: '操作结果', dataIndex: 'result' },
  ]} />
  return <Card title={personal ? '我的派单统计' : '派单统计'} extra={<Button onClick={() => void load()} loading={loading}>刷新</Button>}>
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {personal && <Row gutter={16}>{[['today', '今日派单订单数'], ['week', '本周派单订单数'], ['month', '本月派单订单数']].map(([key, title]) => <Col span={8} key={key}><Statistic title={title} value={report?.summary?.[key] ?? 0} /></Col>)}</Row>}
      <Space wrap><Select aria-label="派单统计时间范围" value={period} style={{ width: 130 }} onChange={value => { setPeriod(value); setPage(1) }} options={[['today', '今日'], ['week', '本周'], ['lastWeek', '上周'], ['month', '本月'], ['lastMonth', '上月'], ['custom', '自定义日期']].map(([value, label]) => ({ value, label }))} />{period === 'custom' && <DatePicker.RangePicker onChange={value => { setDates(value?.[0] && value?.[1] ? [value[0], value[1]] : null); setPage(1) }} />}{report && <span>{report.range.startDate} 至 {report.range.endDate}（北京时间，含结束日全天）</span>}</Space>
      {failed && <Alert type="error" title="统计加载失败，请刷新重试" />}
      <Alert type="info" showIcon title={personal ? '仅统计当前登录账号；相同订单在所选周期内去重' : '展示有派单权限的后台账号及本期有派单记录的账号，未派单账号显示 0'} description={report?.history} />
      <Table<RowItem> size="small" rowKey="id" loading={loading} dataSource={report?.rows ?? []} pagination={false} scroll={{ x: 640 }} columns={[
        { title: '登录账号', dataIndex: 'username', render: (value, row) => personal ? value : <Button type="link" onClick={() => { setPerson(row); setDetail(null); setPage(1) }}>{value}</Button> },
        { title: '角色', dataIndex: 'role', render: (value: Exclude<Role, 'ADMIN'>, row: RowItem) => row.roleName ?? roleMeta[value] },
        { title: '派单订单数', dataIndex: 'orderCount' }, { title: '派单操作次数', dataIndex: 'operationCount' },
        { title: '最近派单时间', dataIndex: 'lastAssignedAt', render: beijingTime },
      ]} />
      {personal && detailTable(report)}
    </Space>
    <Modal title={`${person?.username ?? ''} · 派单明细`} open={Boolean(person)} width={960} footer={null} onCancel={() => { setPerson(null); setPage(1) }}>{detailTable(detail)}</Modal>
  </Card>
}

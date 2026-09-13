import { BellOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Badge, Button, Card, Drawer, Empty, Pagination, Select, Spin, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { io } from 'socket.io-client'
import { api, getErrorMessage } from '../api'
import { getAuthToken } from '../auth-storage'
import { useAuth } from '../auth-context'
import { ReminderContext, reminderLabels, useAdminReminders, type ReminderData, type ReminderKind } from '../admin-reminders'
import { formatDateTime } from '../helpers'
import { hasUserPermission } from '../types'

export const AdminRemindersProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth()
  const canReadReminders = ['dashboard.view', 'orders.view', 'aftersales.view'].some(key => hasUserPermission(user, key))
  const navigate = useNavigate()
  const [data, setData] = useState<ReminderData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [tab, setTab] = useState('todos')
  const [kind, setKind] = useState<ReminderKind | undefined>()
  const [page, setPage] = useState(1)
  const sequence = useRef(0)
  const invalidate = useCallback(() => { sequence.current += 1 }, [])
  const load = useCallback(async () => {
    const request = ++sequence.current
    if (!canReadReminders) { setData(null); setError(null); setLoading(false); return }
    setLoading(true)
    try {
      const response = await api.get<ReminderData>('/admin/reminders', { params: { page, kind } })
      if (request !== sequence.current) return
      setData(response.data)
      setError(null)
    } catch (cause) {
      if (request === sequence.current) setError(getErrorMessage(cause))
    } finally {
      if (request === sequence.current) setLoading(false)
    }
  }, [page, kind, canReadReminders])
  useEffect(() => {
    void load()
    const token = getAuthToken()
    const socket = token ? io({ auth: { token } }) : null
    // Reconnect also re-fetches the state missed while offline. Never increment a local counter.
    socket?.on('connect', load)
    socket?.on('data:changed', load)
    window.addEventListener('focus', load)
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 30000)
    return () => { invalidate(); socket?.disconnect(); window.removeEventListener('focus', load); window.clearInterval(timer) }
  }, [load, user?.id, invalidate])
  const open = (nextKind?: ReminderKind) => { setKind(nextKind); setPage(1); setTab('todos'); setVisible(true); void load() }
  const follow = (href: string) => { setVisible(false); navigate(href) }
  const allowedKinds = (Object.keys(reminderLabels) as ReminderKind[]).filter((key) => data?.allowed[key])
  return <ReminderContext.Provider value={{ data, loading, error, refresh: () => void load(), open }}>
    {children}
    <Drawer title="提醒与待办" open={visible} onClose={() => setVisible(false)} size={460} styles={{ wrapper: { maxWidth: '100vw' } }} className="admin-reminders-drawer" extra={<Button onClick={() => void load()} loading={loading}>刷新</Button>}>
      {error ? <Alert type="error" showIcon title="提醒暂时无法更新" description={error} action={<Button onClick={() => void load()}>重试</Button>} /> : <>
        <Typography.Paragraph type="secondary">待办需处理业务后消除；操作动态仅作记录。</Typography.Paragraph>
        <Tabs activeKey={tab} onChange={setTab} items={[
          { key: 'todos', label: `待办${data ? `（${data.total}）` : ''}`, children: <>
            <Select<ReminderKind | 'all'> aria-label="待办类型" className="reminder-filter" value={kind ?? 'all'} onChange={(value) => { setKind(value === 'all' ? undefined : value); setPage(1) }} options={[{ value: 'all', label: '全部待办' }, ...allowedKinds.map((key) => ({ value: key, label: `${reminderLabels[key]} ${data?.counts[key] ?? 0}` }))]} />
            {loading && !data ? <Spin /> : data?.todos.length ? <div className="reminder-list">{data.todos.map((item) => <button type="button" className="reminder-item" key={item.id} onClick={() => follow(item.href)}>
              <Tag color={item.kind === 'completion' ? 'blue' : item.kind === 'exit' ? 'orange' : 'purple'}>{reminderLabels[item.kind]}</Tag>
              <strong>{item.title}</strong><span>{item.summary}</span><time>{formatDateTime(item.occurredAt)}</time><span className="reminder-hint">前往处理 <RightOutlined /></span>
            </button>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前暂无待处理事项" />}
            {data && data.filteredTotal > data.pageSize && <Pagination size="small" simple current={data.page} total={data.filteredTotal} pageSize={data.pageSize} onChange={setPage} showSizeChanger={false} />}
          </> },
          { key: 'activity', label: '动态', children: <><Typography.Paragraph type="secondary">最近 30 条员工操作，不计入待办数量。</Typography.Paragraph>{data?.activities.length ? <div className="reminder-list">{data.activities.map((item) => <button type="button" className="reminder-item reminder-activity" key={item.id} onClick={() => follow(item.href)}><strong>{item.title}</strong><time>{formatDateTime(item.occurredAt)}</time></button>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无员工操作动态" />}</> },
        ]} />
      </>}
    </Drawer>
  </ReminderContext.Provider>
}

export const AdminReminderBell = () => {
  const { data, error, open } = useAdminReminders()
  return <Badge count={error ? '!' : data?.total ?? 0} overflowCount={999} offset={[-4, 8]} className="reminder-badge">
    <Button type="text" icon={<BellOutlined />} aria-label={error ? '提醒更新失败' : `提醒与待办，${data?.total ?? 0} 项`} onClick={() => open()} />
  </Badge>
}

export const AdminReminderOverview = () => {
  const { data, loading, error, refresh } = useAdminReminders()
  const navigate = useNavigate()
  return <Card className="reminder-overview" title="待办事项" extra={data && !error ? <Typography.Text>待办 <strong>{data.total}</strong> 项</Typography.Text> : undefined}>
    {error ? <Alert type="warning" title="待办暂时无法更新" action={<Button onClick={refresh}>重试</Button>} /> : loading && !data ? <Spin /> : data?.total ? <div className="reminder-overview-grid">{(Object.keys(reminderLabels) as ReminderKind[]).filter((key) => data.allowed[key]).map((key) => <Button key={key} onClick={() => navigate(key === 'afterSale' ? '/admin/after-sales?pending=1' : `/admin/orders?reminderKind=${key}`)}><span>{reminderLabels[key]}</span><strong>{data.counts[key]}</strong><RightOutlined /></Button>)}</div> : <Typography.Text type="secondary">当前暂无待处理事项</Typography.Text>}
  </Card>
}

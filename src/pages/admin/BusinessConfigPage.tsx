import { AdminDashboardSlogan } from '../../components/AdminDashboardSlogan'
import { DeleteOutlined, EditOutlined, MinusCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Switch, Table, Tabs, Tag } from 'antd'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../../api'
import { formatDateTime, formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import { RequestError } from '../../components/RequestState'
import { hasUserPermission, type StaffTier } from '../../types'
import { useAuth } from '../../auth-context'

type PackageItem = { id: string; name: string; category: string | null; description?: string | null; basePriceCents: number; isEnabled: boolean; sort: number; note: string | null }
type ScheduleStatus = 'ENABLED' | 'DISABLED' | 'EXPIRED' | 'NOT_STARTED'
type ActivityItem = { id: string; name: string; startAt: string; endAt: string; isEnabled: boolean; status?: ScheduleStatus; note: string | null; tiers: Array<{ thresholdCents: number; bonusCents: number }> }
type CouponItem = { id: string; name: string; amountCents: number; minSpendCents: number; startAt: string; endAt: string; isEnabled: boolean; status?: ScheduleStatus; _count?: { customerCoupons: number } }
type CampaignItem = { id: string; name: string; type: string; startAt: string; endAt: string; isEnabled: boolean; status?: ScheduleStatus; note: string | null; rule?: { description?: string } | null }
type NoticeItem = { id: string; type: string; title: string; content: string; isEnabled: boolean }
type ActivityTierValue = { threshold: number; bonus: number }
type Kind = 'tier' | 'package' | 'activity' | 'coupon' | 'campaign' | 'notice' | 'funding'
type FundingPolicyValue = 'PRINCIPAL_FIRST' | 'BONUS_FIRST'
type WorkbenchWelcome = { titleTemplate: string; subtitle: string }

const kindTitle: Record<Kind, string> = { tier: '员工层级', package: '服务套餐', activity: '充值活动', coupon: '优惠券', campaign: '活动配置', notice: '提醒配置', funding: '资金扣款策略' }
const scheduleMeta: Record<ScheduleStatus, { label: string; color: string }> = { ENABLED: { label: '启用', color: 'success' }, DISABLED: { label: '停用', color: 'default' }, EXPIRED: { label: '已过期', color: 'default' }, NOT_STARTED: { label: '未开始', color: 'processing' } }
const scheduleStatusOf = (item: { isEnabled: boolean; startAt: string; endAt: string }): ScheduleStatus => {
  if (!item.isEnabled) return 'DISABLED'
  const now = Date.now()
  if (new Date(item.endAt).getTime() < now) return 'EXPIRED'
  if (new Date(item.startAt).getTime() > now) return 'NOT_STARTED'
  return 'ENABLED'
}

export const BusinessConfigPage = () => {
  const { message } = App.useApp()
  const { user } = useAuth()
  const [tiers, setTiers] = useState<StaffTier[]>([])
  const [packages, setPackages] = useState<PackageItem[]>([])
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [coupons, setCoupons] = useState<CouponItem[]>([])
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([])
  const [notices, setNotices] = useState<NoticeItem[]>([])
  const [fundingPolicy, setFundingPolicy] = useState<FundingPolicyValue>('PRINCIPAL_FIRST')
  const [welcome, setWelcome] = useState<WorkbenchWelcome>({ titleTemplate: '{员工昵称}，今天辛苦了。', subtitle: '把每个进度更新好，现场就会一直清楚。' })
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [kind, setKind] = useState<Kind>('tier')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm()
  const [welcomeForm] = Form.useForm<WorkbenchWelcome>()

  const canManage = useCallback((permissionKind: Kind) => {
    const permissions: Record<Kind, string> = { tier: 'staff.manage', package: 'packages.manage', activity: 'activities.manage', coupon: 'coupons.manage', campaign: 'campaigns.manage', notice: 'notices.manage', funding: 'funds.adjust' }
    return hasUserPermission(user, permissions[permissionKind])
  }, [user])

  const load = useCallback(async () => {
    setHasError(false)
    try {
      const [tierResponse, packageResponse, activityResponse, couponResponse, campaignResponse, noticeResponse, fundingResponse, welcomeResponse] = await Promise.allSettled([
        hasUserPermission(user, 'staff.view') ? api.get<{ items: StaffTier[] }>('/staff-tiers') : Promise.resolve({ data: { items: [] as StaffTier[] } }),
        canManage('package') ? api.get<{ items: PackageItem[] }>('/packages') : Promise.resolve({ data: { items: [] as PackageItem[] } }),
        canManage('activity') ? api.get<{ items: ActivityItem[] }>('/recharge-activities') : Promise.resolve({ data: { items: [] as ActivityItem[] } }),
        canManage('coupon') ? api.get<{ items: CouponItem[] }>('/coupons') : Promise.resolve({ data: { items: [] as CouponItem[] } }),
        canManage('campaign') ? api.get<{ items: CampaignItem[] }>('/campaigns') : Promise.resolve({ data: { items: [] as CampaignItem[] } }),
        canManage('notice') ? api.get<{ items: NoticeItem[] }>('/notices') : Promise.resolve({ data: { items: [] as NoticeItem[] } }),
        canManage('funding') ? api.get<{ item: { policy: FundingPolicyValue } }>('/settings/funding-policy') : Promise.resolve(null),
        canManage('notice') ? api.get<{ item: WorkbenchWelcome }>('/settings/workbench-welcome') : Promise.resolve(null),
      ])
      setTiers(tierResponse.status === 'fulfilled' ? tierResponse.value.data.items : [])
      setPackages(packageResponse.status === 'fulfilled' ? packageResponse.value.data.items : [])
      setActivities(activityResponse.status === 'fulfilled' ? activityResponse.value.data.items : [])
      setCoupons(couponResponse.status === 'fulfilled' ? couponResponse.value.data.items : [])
      setCampaigns(campaignResponse.status === 'fulfilled' ? campaignResponse.value.data.items : [])
      setNotices(noticeResponse.status === 'fulfilled' ? noticeResponse.value.data.items : [])
      if (fundingResponse.status === 'fulfilled' && fundingResponse.value) setFundingPolicy(fundingResponse.value.data.item.policy)
      if (welcomeResponse.status === 'fulfilled' && welcomeResponse.value) {
        setWelcome(welcomeResponse.value.data.item)
      }
    } catch (error) {
      setHasError(true)
      message.error(getErrorMessage(error))
    } finally { setLoading(false) }
  }, [canManage, message, user])

  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)

  useEffect(() => {
    if (!loading && !hasError && kind === 'notice' && canManage('notice')) welcomeForm.setFieldsValue(welcome)
  }, [loading, hasError, kind, canManage, welcome, welcomeForm])

  const openCreate = (nextKind: Kind) => {
    setKind(nextKind)
    setEditingId(null)
    form.resetFields()
    if (nextKind === 'tier') form.setFieldsValue({ level: 1, priceMultiplier: 100, canAcceptOrders: true, isEnabled: true, sort: 0 })
    if (nextKind === 'package') form.setFieldsValue({ basePrice: 0, isEnabled: true, sort: 0 })
    if (nextKind === 'activity') form.setFieldsValue({ isEnabled: true, tiers: [{ threshold: 1000, bonus: 0 }] })
    if (nextKind === 'coupon') form.setFieldsValue({ amount: 0, minSpend: 0, isEnabled: true })
    if (nextKind === 'campaign') form.setFieldsValue({ type: 'NEW_CUSTOMER', ruleDescription: '', isEnabled: true })
    if (nextKind === 'notice') form.setFieldsValue({ type: 'ANNOUNCEMENT', isEnabled: true })
    setModalOpen(true)
  }

  const openEdit = (nextKind: Kind, item: StaffTier | PackageItem | ActivityItem | CouponItem | CampaignItem | NoticeItem) => {
    setKind(nextKind)
    setEditingId(item.id)
    if (nextKind === 'tier') {
      const value = item as StaffTier
      form.setFieldsValue({ name: value.name, description: value.description ?? '', level: value.level, priceMultiplier: value.priceMultiplierBps / 100, canAcceptOrders: value.canAcceptOrders, isEnabled: value.isEnabled, sort: value.sort })
    } else if (nextKind === 'package') {
      const value = item as PackageItem
      form.setFieldsValue({ name: value.name, category: value.category ?? '', description: value.description ?? '', basePrice: value.basePriceCents / 100, isEnabled: value.isEnabled, sort: value.sort, note: value.note ?? '' })
    } else if (nextKind === 'activity') {
      const value = item as ActivityItem
      form.setFieldsValue({ name: value.name, startAt: dayjs(value.startAt), endAt: dayjs(value.endAt), isEnabled: value.isEnabled, note: value.note ?? '', tiers: value.tiers.map((tier) => ({ threshold: tier.thresholdCents / 100, bonus: tier.bonusCents / 100 })) })
    } else if (nextKind === 'coupon') {
      const value = item as CouponItem
      form.setFieldsValue({ name: value.name, amount: value.amountCents / 100, minSpend: value.minSpendCents / 100, isEnabled: value.isEnabled, startAt: dayjs(value.startAt), endAt: dayjs(value.endAt) })
    } else if (nextKind === 'campaign') {
      const value = item as CampaignItem
      form.setFieldsValue({ name: value.name, type: value.type, ruleDescription: value.rule?.description ?? value.note ?? '', isEnabled: value.isEnabled, note: value.note ?? '', startAt: dayjs(value.startAt), endAt: dayjs(value.endAt) })
    } else {
      const value = item as NoticeItem
      form.setFieldsValue({ title: value.title, content: value.content, type: value.type, isEnabled: value.isEnabled })
    }
    setModalOpen(true)
  }

  const save = async (values: Record<string, unknown>) => {
    try {
      if (kind === 'funding') {
        await api.patch('/settings/funding-policy', { policy: values.policy })
        setFundingPolicy(values.policy as FundingPolicyValue)
      } else if (kind === 'tier') {
        const body = { name: values.name, description: values.description, level: values.level, priceMultiplierBps: Math.round(Number(values.priceMultiplier) * 100), canAcceptOrders: values.canAcceptOrders, isEnabled: values.isEnabled, sort: values.sort }
        if (editingId) await api.patch('/staff-tiers/' + editingId, body)
        else await api.post('/staff-tiers', body)
      } else if (kind === 'package') {
        const body = { name: values.name, category: values.category, description: values.description, basePriceCents: Math.round(Number(values.basePrice) * 100), isEnabled: values.isEnabled, sort: values.sort, note: values.note }
        if (editingId) await api.patch('/packages/' + editingId, body)
        else await api.post('/packages', body)
      } else if (kind === 'activity') {
        const activityTiers = (Array.isArray(values.tiers) ? values.tiers : []) as ActivityTierValue[]
        const body = { name: values.name, startAt: (values.startAt as Dayjs).toISOString(), endAt: (values.endAt as Dayjs).toISOString(), isEnabled: values.isEnabled, note: values.note, tiers: activityTiers.map((tier) => ({ thresholdCents: Math.round(Number(tier.threshold) * 100), bonusCents: Math.round(Number(tier.bonus ?? 0) * 100) })) }
        if (editingId) await api.patch('/recharge-activities/' + editingId, body)
        else await api.post('/recharge-activities', body)
      } else if (kind === 'coupon') {
        const body = { name: values.name, amountCents: Math.round(Number(values.amount) * 100), minSpendCents: Math.round(Number(values.minSpend) * 100), startAt: (values.startAt as Dayjs).toISOString(), endAt: (values.endAt as Dayjs).toISOString(), isEnabled: values.isEnabled }
        if (editingId) await api.patch('/coupons/' + editingId, body)
        else await api.post('/coupons', body)
      } else if (kind === 'campaign') {
        const body = { name: values.name, type: values.type, rule: { description: String(values.ruleDescription ?? '').trim() }, startAt: (values.startAt as Dayjs).toISOString(), endAt: (values.endAt as Dayjs).toISOString(), isEnabled: values.isEnabled, note: values.note }
        if (editingId) await api.patch('/campaigns/' + editingId, body)
        else await api.post('/campaigns', body)
      } else {
        const body = { type: values.type, title: values.title, content: values.content, isEnabled: values.isEnabled }
        if (editingId) await api.patch('/notices/' + editingId, body)
        else await api.post('/notices', body)
      }
      message.success(kindTitle[kind] + '已保存')
      setModalOpen(false)
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  const saveWelcome = async (values: WorkbenchWelcome) => {
    try {
      const { data } = await api.patch<{ item: WorkbenchWelcome }>('/settings/workbench-welcome', values)
      setWelcome(data.item)
      message.success('员工工作台欢迎语已保存')
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  const resetWelcome = async () => {
    try {
      const { data } = await api.post<{ item: WorkbenchWelcome }>('/settings/workbench-welcome/reset')
      setWelcome(data.item)
      welcomeForm.setFieldsValue(data.item)
      message.success('已恢复默认欢迎语')
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  const removeTier = async (item: StaffTier) => {
    try {
      const { data } = await api.delete<{ message: string }>('/staff-tiers/' + item.id)
      message.success(data.message)
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  if (loading) return <div className="page-loading"><span>正在加载业务配置…</span></div>
  if (hasError) return <RequestError onRetry={() => void load()} />

  const allowedKinds: Kind[] = (['tier', 'package', 'activity', 'coupon', 'campaign', 'notice', 'funding'] as Kind[]).filter((value) => canManage(value))
  const tabItems = [
    { key: 'tier', label: '员工层级', children: <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>员工服务层级</strong><span className="card-subtitle">控制接单权限与价格倍率</span></div><Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('tier')}>新增层级</Button></div><Table<StaffTier> rowKey="id" dataSource={tiers} pagination={false} locale={{ emptyText: '暂无员工层级' }} columns={[{ title: '层级', dataIndex: 'name' }, { title: '说明', dataIndex: 'description', render: (value: string | null) => value || '—' }, { title: '价格倍率', dataIndex: 'priceMultiplierBps', render: (value: number) => (value / 100).toFixed(0) + '%' }, { title: '接单权限', dataIndex: 'canAcceptOrders', render: (value: boolean) => <Tag color={value ? 'success' : 'default'}>{value ? '可接单' : '不可接单'}</Tag> }, { title: '状态', dataIndex: 'isEnabled', render: (value: boolean) => value ? '启用' : '停用' }, { title: '操作', width: 150, render: (_: unknown, item: StaffTier) => <Space size={0}><Button type="link" icon={<EditOutlined />} onClick={() => openEdit('tier', item)}>编辑</Button><Popconfirm title="安全删除员工层级" description="系统会先检查员工和订单引用；历史已完成订单会保留名称并归档。" okText="确认删除" cancelText="返回" onConfirm={() => void removeTier(item)}><Button type="link" danger icon={<DeleteOutlined />}>删除</Button></Popconfirm></Space> }]} /></Card> },
    { key: 'package', label: '服务套餐', children: <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>服务套餐</strong><span className="card-subtitle">电竞护航服务项目</span></div><Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('package')}>新增套餐</Button></div><Table<PackageItem> rowKey="id" dataSource={packages} pagination={false} locale={{ emptyText: '暂无服务套餐' }} columns={[{ title: '套餐名称', dataIndex: 'name' }, { title: '分类', dataIndex: 'category', render: (value: string | null) => value || '—' }, { title: '建议价格', dataIndex: 'basePriceCents', render: (value: number) => formatMoney(value) }, { title: '排序', dataIndex: 'sort', width: 80 }, { title: '状态', dataIndex: 'isEnabled', render: (value: boolean) => value ? '启用' : '停用' }, { title: '操作', width: 90, render: (_: unknown, item: PackageItem) => <Button type="link" icon={<EditOutlined />} onClick={() => openEdit('package', item)}>编辑</Button> }]} /></Card> },
    { key: 'activity', label: '充值活动', children: <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>充值活动</strong><span className="card-subtitle">自动匹配最高档奖励</span></div><Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('activity')}>新增活动</Button></div><Table<ActivityItem> rowKey="id" dataSource={activities} pagination={false} locale={{ emptyText: '暂无充值活动' }} columns={[{ title: '活动名称', dataIndex: 'name' }, { title: '有效期', render: (_: unknown, item: ActivityItem) => formatDateTime(item.startAt) + ' 至 ' + formatDateTime(item.endAt) }, { title: '奖励档位', render: (_: unknown, item: ActivityItem) => item.tiers.map((tier) => formatMoney(tier.thresholdCents) + ' 送 ' + formatMoney(tier.bonusCents)).join('；') }, { title: '状态', render: (_: unknown, item: ActivityItem) => { const meta = scheduleMeta[scheduleStatusOf(item)]; return <Tag color={meta.color}>{meta.label}</Tag> } }, { title: '操作', width: 90, render: (_: unknown, item: ActivityItem) => <Button type="link" onClick={() => openEdit('activity', item)}>编辑</Button> }]} /></Card> },
    { key: 'coupon', label: '优惠券', children: <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>优惠券</strong><span className="card-subtitle">仅后台发放与订单核销</span></div><Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('coupon')}>新增优惠券</Button></div><Table<CouponItem> rowKey="id" dataSource={coupons} pagination={false} locale={{ emptyText: '暂无优惠券' }} columns={[{ title: '名称', dataIndex: 'name' }, { title: '面额', dataIndex: 'amountCents', render: (value: number) => formatMoney(value) }, { title: '最低消费', dataIndex: 'minSpendCents', render: (value: number) => formatMoney(value) }, { title: '已发放', dataIndex: ['_count', 'customerCoupons'], render: (value: number | undefined) => (value ?? 0) + ' 张' }, { title: '状态', render: (_: unknown, item: CouponItem) => { const meta = scheduleMeta[scheduleStatusOf(item)]; return <Tag color={meta.color}>{meta.label}</Tag> } }, { title: '操作', width: 90, render: (_: unknown, item: CouponItem) => <Button type="link" onClick={() => openEdit('coupon', item)}>编辑</Button> }]} /></Card> },
    { key: 'campaign', label: '活动配置', children: <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>新客 / 推荐活动</strong><span className="card-subtitle">只配置规则与有效期，暂不提供前台页面</span></div><Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('campaign')}>新增活动</Button></div><Table<CampaignItem> rowKey="id" dataSource={campaigns} pagination={false} locale={{ emptyText: '暂无活动配置' }} columns={[{ title: '活动名称', dataIndex: 'name' }, { title: '类型', dataIndex: 'type', render: (value: string) => value === 'NEW_CUSTOMER' ? '新客活动' : value === 'REFERRAL' ? '推荐活动' : '其他活动' }, { title: '规则说明', render: (_: unknown, item: CampaignItem) => item.rule?.description || item.note || '—' }, { title: '有效期', render: (_: unknown, item: CampaignItem) => formatDateTime(item.startAt) + ' 至 ' + formatDateTime(item.endAt) }, { title: '状态', render: (_: unknown, item: CampaignItem) => { const meta = scheduleMeta[scheduleStatusOf(item)]; return <Tag color={meta.color}>{meta.label}</Tag> } }, { title: '操作', width: 90, render: (_: unknown, item: CampaignItem) => <Button type="link" onClick={() => openEdit('campaign', item)}>编辑</Button> }]} /></Card> },
    { key: 'notice', label: '提醒配置', children: <Space orientation="vertical" size={16} style={{ width: '100%' }}><AdminDashboardSlogan /><Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>员工工作台欢迎语</strong><span className="card-subtitle">主标题必须保留 {'{员工昵称}'} 占位符</span></div></div><Form<WorkbenchWelcome> form={welcomeForm} layout="vertical" initialValues={welcome} onFinish={saveWelcome}><Form.Item name="titleTemplate" label="主标题模板" rules={[{ required: true, message: '请输入主标题模板' }, { validator: async (_, value: string) => { if (!value?.includes('{员工昵称}')) throw new Error('主标题模板必须包含 {员工昵称}') } }]}><Input maxLength={120} /></Form.Item><Form.Item name="subtitle" label="辅助文案" rules={[{ required: true, message: '请输入辅助文案' }]}><Input maxLength={240} /></Form.Item><Space><Button type="primary" htmlType="submit">保存欢迎语</Button><Button onClick={() => void resetWelcome()}>恢复默认</Button></Space></Form></Card><Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>公告与风险提示</strong><span className="card-subtitle">后台提示配置</span></div><Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('notice')}>新增提示</Button></div><Table<NoticeItem> rowKey="id" dataSource={notices} pagination={false} locale={{ emptyText: '暂无提示配置' }} columns={[{ title: '类型', dataIndex: 'type', render: (value: string) => value === 'RISK' ? <Tag color="warning">风险提示</Tag> : <Tag color="blue">公告</Tag> }, { title: '标题', dataIndex: 'title' }, { title: '内容', dataIndex: 'content' }, { title: '状态', dataIndex: 'isEnabled', render: (value: boolean) => value ? '启用' : '停用' }, { title: '操作', width: 90, render: (_: unknown, item: NoticeItem) => <Button type="link" onClick={() => openEdit('notice', item)}>编辑</Button> }]} /></Card></Space> },
    { key: 'funding', label: '资金扣款策略', children: <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>全局资金扣款策略</strong><span className="card-subtitle">所有客户统一使用，完成订单时生效</span></div></div><div className="funding-policy-panel"><div><strong>当前策略</strong><p>只允许配置一套全局扣款顺序，不对单个客户单独设置。</p></div><Radio.Group value={fundingPolicy} onChange={(event) => setFundingPolicy(event.target.value as FundingPolicyValue)} options={[{ value: 'PRINCIPAL_FIRST', label: '本金优先' }, { value: 'BONUS_FIRST', label: '赠金优先' }]} /><Button type="primary" onClick={() => void save({ policy: fundingPolicy })}>保存策略</Button></div></Card> },
  ]

  return (
    <div className="content-stack">
      <section className="page-intro compact"><div><div className="eyebrow">业务配置 · 层级与活动</div><h2>业务配置</h2><p>维护员工层级、服务套餐和后台活动规则，不改变现有业务流程。</p></div><Button type="text" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button></section>
      <Tabs activeKey={allowedKinds.includes(kind) ? kind : allowedKinds[0]} onChange={(value) => setKind(value as Kind)} items={tabItems.filter((item) => allowedKinds.includes(item.key as Kind))} />
      <Modal title={(editingId ? '编辑' : '新增') + kindTitle[kind]} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => form.submit()} okText="保存" cancelText="返回" destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={save}>
          {kind === 'notice' ? <>
            <Form.Item name="type" label="提示类型" rules={[{ required: true }]}><Select options={[{ value: 'ANNOUNCEMENT', label: '公告' }, { value: 'RISK', label: '风险提示' }]} /></Form.Item>
            <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}><Input /></Form.Item>
            <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}><Input.TextArea rows={4} /></Form.Item>
            <Form.Item name="isEnabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
          </> : <>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}><Input /></Form.Item>
            {kind === 'tier' && <>
              <Form.Item name="description" label="说明"><Input.TextArea rows={2} /></Form.Item>
              <div className="form-grid-two"><Form.Item name="level" label="层级等级"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item><Form.Item name="priceMultiplier" label="价格倍率（%）"><InputNumber min={1} max={500} style={{ width: '100%' }} /></Form.Item></div>
              <Form.Item name="canAcceptOrders" label="允许接单" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="isEnabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </>}
            {kind === 'package' && <>
              <Form.Item name="category" label="游戏 / 服务分类"><Input placeholder="例如：英雄联盟 / 无畏契约" /></Form.Item>
              <Form.Item name="description" label="服务说明"><Input.TextArea rows={2} /></Form.Item>
              <div className="form-grid-two"><Form.Item name="basePrice" label="建议价格（元）"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item><Form.Item name="sort" label="排序"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item></div>
              <Form.Item name="note" label="备注"><Input.TextArea rows={2} /></Form.Item>
              <Form.Item name="isEnabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </>}
            {kind === 'activity' && <>
              <div className="form-grid-two"><Form.Item name="startAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item><Form.Item name="endAt" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item></div>
              <Form.List name="tiers" rules={[{ validator: async (_, value) => { if (!value?.length) throw new Error('至少配置一档充值奖励') } }]}>
                {(fields, { add, remove }, { errors }) => <>
                  {fields.map((field, index) => {
                    const { key, ...fieldProps } = field
                    return <div className="form-grid-two" key={key}>
                      <Form.Item {...fieldProps} name={[field.name, 'threshold']} label={`充值门槛（元）· 第 ${index + 1} 档`} rules={[{ required: true, message: '请输入充值门槛' }]}><InputNumber min={0.01} precision={2} style={{ width: '100%' }} /></Form.Item>
                      <Space align="end" style={{ width: '100%' }}><Form.Item {...fieldProps} name={[field.name, 'bonus']} label="赠金（元）" rules={[{ required: true, message: '请输入赠金' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item>{fields.length > 1 && <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} aria-label={`删除第 ${index + 1} 档奖励`} />}</Space>
                    </div>
                  })}
                  <Form.ErrorList errors={errors} />
                  <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ threshold: 1000, bonus: 0 })}>新增奖励档</Button>
                </>}
              </Form.List>
              <Form.Item name="note" label="活动说明"><Input.TextArea rows={2} /></Form.Item>
              <Form.Item name="isEnabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </>}
            {kind === 'coupon' && <>
              <div className="form-grid-two"><Form.Item name="amount" label="面额（元）" rules={[{ required: true, message: '请输入面额' }]}><InputNumber min={0.01} precision={2} style={{ width: '100%' }} /></Form.Item><Form.Item name="minSpend" label="最低消费（元）"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></div>
              <div className="form-grid-two"><Form.Item name="startAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item><Form.Item name="endAt" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item></div>
              <Form.Item name="isEnabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </>}
            {kind === 'campaign' && <>
              <Form.Item name="type" label="活动类型"><Select options={[{ value: 'NEW_CUSTOMER', label: '新客活动' }, { value: 'REFERRAL', label: '推荐活动' }, { value: 'OTHER', label: '其他活动' }]} /></Form.Item>
              <div className="form-grid-two"><Form.Item name="startAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item><Form.Item name="endAt" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item></div>
              <Form.Item name="ruleDescription" label="规则说明" rules={[{ required: true, message: '请输入规则说明' }]}><Input.TextArea rows={3} placeholder="例如：新客首单可享一次服务礼遇；推荐活动由客服核验后登记" /></Form.Item>
              <Form.Item name="note" label="备注"><Input.TextArea rows={2} /></Form.Item>
              <Form.Item name="isEnabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </>}
          </>}
        </Form>
      </Modal>
    </div>
  )
}

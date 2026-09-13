import { hasUserPermission } from '../../types'
import { EditOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, WalletOutlined } from '@ant-design/icons'
import { App, Button, Card, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Tooltip } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../../api'
import { formatDateTime, formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import { getOrderDisplayStatus, type Customer, type CustomerDetail } from '../../types'
import { RequestError } from '../../components/RequestState'
import { useAuth } from '../../auth-context'

type CustomerForm = { customerCode: string; teamCode: string; tags?: string; isBlacklisted?: boolean; note?: string }
type RechargeForm = { amount: number; bonusAmount?: number; note?: string }
type CouponOption = { id: string; name: string; amountCents: number; minSpendCents: number; startAt: string; endAt: string; isEnabled: boolean }
type IssueCouponForm = { couponId: string }
type AdjustmentForm = { principalAmount?: number; bonusAmount?: number; note: string }

export const CustomersPage = () => {
  const { message } = App.useApp()
  const { user } = useAuth()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [search, setSearch] = useState('')
  const [form] = Form.useForm<CustomerForm>()
  const [rechargeForm] = Form.useForm<RechargeForm>()
  const [editing, setEditing] = useState<Customer | null>(null)
  const [recharging, setRecharging] = useState<Customer | null>(null)
  const [detail, setDetail] = useState<CustomerDetail | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [coupons, setCoupons] = useState<CouponOption[]>([])
  const [issuing, setIssuing] = useState<Customer | null>(null)
  const [adjusting, setAdjusting] = useState<Customer | null>(null)
  const [issueForm] = Form.useForm<IssueCouponForm>()
  const [adjustmentForm] = Form.useForm<AdjustmentForm>()
  const canManage = hasUserPermission(user, 'customers.manage')
  const canRecharge = hasUserPermission(user, 'customers.recharge')
  const canIssueCoupons = hasUserPermission(user, 'coupons.manage')
  const canAdjustFunds = hasUserPermission(user, 'funds.adjust')

  const load = useCallback(async () => {
    setHasError(false)
    try {
      const [customerResponse, couponResponse] = await Promise.allSettled([
        api.get<{ items: Customer[] }>('/customers', { params: { search } }),
        canIssueCoupons ? api.get<{ items: CouponOption[] }>('/coupons') : Promise.resolve({ data: { items: [] as CouponOption[] } }),
      ])
      if (customerResponse.status === 'rejected') throw customerResponse.reason
      setCustomers(customerResponse.value.data.items)
      setCoupons(couponResponse.status === 'fulfilled' ? couponResponse.value.data.items : [])
    } catch (error) {
      setHasError(true)
      message.error(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [canIssueCoupons, message, search])

  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)

  if (loading) return <div className="page-loading"><span>正在加载客户资料…</span></div>
  if (hasError) return <RequestError onRetry={() => void load()} />

  const openCreate = () => { setEditing(null); form.resetFields(); form.setFieldsValue({ isBlacklisted: false }); setModalOpen(true) }
  const openEdit = (item: Customer) => { setEditing(item); form.setFieldsValue({ customerCode: item.customerCode, teamCode: item.teamCode, tags: item.tags ?? '', isBlacklisted: item.isBlacklisted ?? false, note: item.note ?? '' }); setModalOpen(true) }
  const save = async (values: CustomerForm) => {
    try {
      if (editing) await api.patch(`/customers/${editing.id}`, values)
      else await api.post('/customers', values)
      message.success(editing ? '客户资料已更新' : '客户已创建')
      setModalOpen(false)
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  const recharge = async (values: RechargeForm) => {
    try {
      await api.post(`/customers/${recharging?.id}/recharges`, { amount: values.amount, bonusAmount: values.bonusAmount, note: values.note ?? '' })
      message.success('充值已登记，客户余额已更新')
      setRecharging(null)
      rechargeForm.resetFields()
      await load()
      if (detail && recharging && detail.id === recharging.id) await openDetail(recharging)
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  const openDetail = async (item: Customer) => {
    try {
      const { data } = await api.get<{ item: CustomerDetail }>(`/customers/${item.id}`)
      setDetail(data.item)
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  const issueCoupon = async (values: IssueCouponForm) => {
    if (!issuing) return
    try {
      await api.post(`/coupons/${values.couponId}/issue`, { customerId: issuing.id })
      message.success('优惠券已发放给客户')
      setIssuing(null)
      issueForm.resetFields()
      await load()
      if (detail && detail.id === issuing.id) await openDetail(issuing)
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  const adjustFunds = async (values: AdjustmentForm) => {
    if (!adjusting) return
    try {
      await api.post(`/customers/${adjusting.id}/fund-adjustment`, values)
      message.success('账户调整已登记')
      setAdjusting(null)
      adjustmentForm.resetFields()
      await load()
      if (detail && detail.id === adjusting.id) await openDetail(adjusting)
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  return (
    <div className="content-stack">
      <section className="page-intro compact">
        <div><div className="eyebrow">客户管理 · 余额流水</div><h2>客户管理</h2><p>维护客户资料、余额与线下充值消费流水。</p></div>
        <Button style={canManage ? undefined : { display: 'none' }} type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增客户</Button>
      </section>
      <Card className="filter-card" variant="borderless">
        <div className="filter-row">
          <Input.Search placeholder="搜索客户ID或客户组队码" allowClear value={search} onChange={(event) => setSearch(event.target.value)} onSearch={() => void load()} style={{ maxWidth: 360 }} />
          <span className="filter-note">余额只通过后台手动充值变更，不接在线支付。</span>
        </div>
      </Card>
      <Card className="table-card" variant="borderless">
        <div className="table-heading"><div><strong>客户档案</strong><span className="card-subtitle">共 {customers.length} 位</span></div><Button type="text" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button></div>
        <Table<Customer>
          rowKey="id"
          dataSource={customers}
          scroll={{ x: 1040 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search ? '没有找到匹配的客户' : '还没有客户档案'} /> }}
          columns={[
            { title: '客户', width: 220, render: (_: unknown, item: Customer) => <div className="person-cell"><div className="person-avatar customer">{item.customerCode.slice(0, 1)}</div><div><strong>{item.customerCode}</strong><div className="table-secondary">组队码 {item.teamCode}</div><div>{item.isBlacklisted ? <Tag color="error">黑名单</Tag> : null}{item.tags ? <Tag color="default">{item.tags}</Tag> : null}</div></div></div> },
            { title: '当前余额', dataIndex: 'balanceCents', width: 150, render: (value: number, item: Customer) => <div><strong className="balance-value">{formatMoney(value)}</strong><div className="table-secondary">本金 {formatMoney(item.principalBalanceCents ?? value)} · 赠金 {formatMoney(item.bonusBalanceCents ?? 0)}</div></div> },
            { title: '累计本金充值', dataIndex: 'totalPrincipalRechargeCents', width: 130, render: (value: number | undefined, item: Customer) => formatMoney(value ?? item.totalRechargeCents ?? 0) },
            { title: '累计消费', dataIndex: 'totalConsumptionCents', width: 120, render: (value: number | undefined) => <span className="money-muted">{formatMoney(value ?? 0)}</span> },
            { title: '消费次数', width: 90, render: (_value: unknown, item: Customer) => (item.consumptionCount ?? item._count?.consumptionRecords ?? 0) + ' 次' },
            { title: '充值次数', dataIndex: ['_count', 'rechargeRecords'], width: 90, render: (value: number | undefined) => `${value ?? 0} 次` },
            { title: '建档时间', dataIndex: 'createdAt', width: 170, render: (value: string) => formatDateTime(value) },
            { title: '操作', fixed: 'right', width: 142, render: (_: unknown, item: Customer) => <Space size={0}><Tooltip title="查看资料与余额流水"><Button type="text" aria-label={`查看${item.customerCode}资料与流水`} icon={<EyeOutlined />} onClick={() => void openDetail(item)} /></Tooltip><Tooltip title="编辑资料"><Button style={canManage ? undefined : { display: 'none' }} type="text" aria-label={`编辑${item.customerCode}资料`} icon={<EditOutlined />} onClick={() => openEdit(item)} /></Tooltip><Tooltip title="手动充值"><Button style={canRecharge ? undefined : { display: 'none' }} type="text" aria-label={`给${item.customerCode}手动充值`} icon={<WalletOutlined />} onClick={() => { setRecharging(item); rechargeForm.resetFields() }} /></Tooltip></Space> },
          ]}
        />
      </Card>
      <Modal title={editing ? '编辑客户资料' : '新增客户'} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => form.submit()} okText="保存" cancelText="返回" destroyOnHidden><Form<CustomerForm> form={form} layout="vertical" onFinish={save} preserve={false}><Form.Item name="customerCode" label="客户ID" rules={[{ required: true, message: '请输入客户ID' }]}><Input /></Form.Item><Form.Item name="teamCode" label="客户组队码" rules={[{ required: true, message: '请输入客户组队码' }]}><Input /></Form.Item><Form.Item name="tags" label="消费标签"><Input placeholder="例如：赛事包场 / 常客" /></Form.Item><Form.Item name="isBlacklisted" label="列入黑名单" valuePropName="checked"><Switch checkedChildren="限制下单" unCheckedChildren="正常" /></Form.Item><Form.Item name="note" label="备注"><Input.TextArea rows={3} /></Form.Item></Form></Modal>
      <Modal title={`给 ${recharging?.customerCode ?? ''} 充值`} open={Boolean(recharging)} onCancel={() => setRecharging(null)} onOk={() => rechargeForm.submit()} okText="确认充值" cancelText="返回"><Form<RechargeForm> form={rechargeForm} layout="vertical" onFinish={recharge}><Form.Item name="amount" label="本金充值（元）" rules={[{ required: true, message: '请输入充值金额' }]}><InputNumber min={0.01} precision={2} style={{ width: '100%' }} /></Form.Item><Form.Item name="bonusAmount" label="赠金（元）" extra="留空时按当前有效充值活动自动匹配最高档"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item><Form.Item name="note" label="充值备注"><Input placeholder="例如：线下收款 / 收据编号" /></Form.Item></Form></Modal>
      <Modal title={`给 ${issuing?.customerCode ?? ''} 发放优惠券`} open={Boolean(issuing)} onCancel={() => setIssuing(null)} onOk={() => issueForm.submit()} okText="确认发放" cancelText="返回"><Form<IssueCouponForm> form={issueForm} layout="vertical" onFinish={issueCoupon}><Form.Item name="couponId" label="优惠券" rules={[{ required: true, message: '请选择优惠券' }]}><Select showSearch optionFilterProp="label" placeholder="选择可用优惠券" options={coupons.filter((item) => item.isEnabled).map((item) => ({ value: item.id, label: `${item.name} · 减 ${formatMoney(item.amountCents)} · 满 ${formatMoney(item.minSpendCents)}` }))} /></Form.Item></Form></Modal>
      <Modal title={`调整 ${adjusting?.customerCode ?? ''} 的账户`} open={Boolean(adjusting)} onCancel={() => setAdjusting(null)} onOk={() => adjustmentForm.submit()} okText="保存调整" cancelText="返回"><Form<AdjustmentForm> form={adjustmentForm} layout="vertical" onFinish={adjustFunds}><div className="form-grid-two"><Form.Item name="principalAmount" label="本金调整（元）"><InputNumber precision={2} style={{ width: '100%' }} placeholder="可填正数或负数" /></Form.Item><Form.Item name="bonusAmount" label="赠金调整（元）"><InputNumber precision={2} style={{ width: '100%' }} placeholder="可填正数或负数" /></Form.Item></div><Form.Item name="note" label="调整原因" rules={[{ required: true, message: '请填写调整原因' }]}><Input.TextArea rows={3} placeholder="记录账户调整原因" /></Form.Item></Form></Modal>
      <Drawer title={detail ? `${detail.customerCode} · 客户流水` : '客户流水'} extra={detail ? <Space>{canIssueCoupons && <Button size="small" onClick={() => { setIssuing({ ...detail }); issueForm.resetFields() }}>发放优惠券</Button>}{canAdjustFunds && <Button size="small" onClick={() => { setAdjusting({ ...detail }); adjustmentForm.resetFields() }}>账户调整</Button>}</Space> : null} open={Boolean(detail)} onClose={() => setDetail(null)} styles={{ wrapper: { width: 560 } }}>
        <div className="drawer-balance"><span>当前余额</span><strong>{formatMoney(detail?.balanceCents ?? 0)}</strong><small>本金 {formatMoney(detail?.principalBalanceCents ?? detail?.balanceCents ?? 0)} · 赠金 {formatMoney(detail?.bonusBalanceCents ?? 0)}</small></div>
        <div className="drawer-ledger-summary">
          <div><span>累计本金充值</span><strong>{formatMoney(detail?.totalPrincipalRechargeCents ?? detail?.totalRechargeCents ?? 0)}</strong></div><div><span>累计赠金</span><strong>{formatMoney(detail?.totalBonusCents ?? 0)}</strong></div>
          <div><span>累计消费</span><strong>{formatMoney(detail?.totalConsumptionCents ?? 0)}</strong></div>
          <div><span>充值 / 消费次数</span><strong>{detail?.rechargeRecords.length ?? 0} / {detail?.consumptionCount ?? detail?.consumptionRecords.length ?? 0}</strong></div>
        </div>
        <Descriptions column={1} size="small" items={detail ? [{ key: 'customerCode', label: '客户ID', children: detail.customerCode }, { key: 'teamCode', label: '客户组队码', children: detail.teamCode }, { key: 'policy', label: '当前扣款策略', children: <Tag color="default">{detail.fundingPolicy === 'BONUS_FIRST' ? '赠金优先' : '本金优先'}（全局配置）</Tag> }, { key: 'blacklist', label: '客户状态', children: detail.isBlacklisted ? <Tag color="error">黑名单</Tag> : <Tag color="success">正常</Tag> }, { key: 'tags', label: '消费标签', children: detail.tags || '—' }, { key: 'note', label: '客户备注', children: detail.note || '—' }] : []} />
        <div className="drawer-section"><div className="drawer-section-title">充值流水 <span>{detail?.rechargeRecords.length ?? 0}</span></div><div className="drawer-record-list">{detail?.rechargeRecords.length ? detail.rechargeRecords.map((item) => <div className="drawer-record-item" key={item.id}><div className="drawer-record-title money-strong">+ {formatMoney(item.amountCents)}</div><div className="drawer-record-description">{formatDateTime(item.createdAt)} · 操作人 {item.operator.username}{item.note ? ` · ${item.note}` : ''}</div></div>) : <div className="drawer-empty">暂无充值流水</div>}</div></div>
        <div className="drawer-section"><div className="drawer-section-title">消费流水 <span>{detail?.consumptionRecords.length ?? 0}</span></div><div className="drawer-record-list">{detail?.consumptionRecords.length ? detail.consumptionRecords.map((item) => <div className="drawer-record-item" key={item.id}><div className="drawer-record-title money-muted">- {formatMoney(item.amountCents)} <Tag color="success">已完成</Tag></div><div className="drawer-record-description">订单 {item.order.orderNo} · {formatDateTime(item.createdAt)} · {item.note || '订单完成消费'}</div><div className="drawer-record-description">扣款前 {formatMoney(item.balanceBeforeCents)} · 扣款后 {formatMoney(item.balanceAfterCents)} · 操作人 {item.operator.username}</div></div>) : <div className="drawer-empty">暂无消费流水</div>}</div></div>
        <div className="drawer-section"><div className="drawer-section-title">资金流水 <span>{detail?.fundTransactions?.length ?? 0}</span></div><div className="drawer-record-list">{detail?.fundTransactions?.length ? detail.fundTransactions.map((item) => <div className="drawer-record-item" key={item.id}><div className="drawer-record-title">{item.type === 'PRINCIPAL_RECHARGE' ? '本金充值' : item.type === 'BONUS_RECHARGE' ? '活动赠金' : item.type === 'PRINCIPAL_CONSUMPTION' ? '本金消费' : item.type === 'BONUS_CONSUMPTION' ? '赠金消费' : item.type === 'AFTER_SALE' ? '售后补偿' : item.type === 'ORDER_ADJUSTMENT' ? '订单净额调整' : '账户调整'} <strong className={item.amountCents < 0 ? 'money-muted' : 'money-strong'}>{item.amountCents >= 0 ? '+' : ''}{formatMoney(item.amountCents)}</strong></div><div className="drawer-record-description">{formatDateTime(item.createdAt)} · {item.order?.orderNo ? `订单 ${item.order.orderNo} · ` : ''}操作人 {item.operator?.username || '系统'}</div><div className="drawer-record-description">余额 {formatMoney(item.balanceBeforeCents)} → {formatMoney(item.balanceAfterCents)} · {item.note || '—'}</div></div>) : <div className="drawer-empty">暂无资金流水</div>}</div></div>
        <div className="drawer-section"><div className="drawer-section-title">优惠券记录 <span>{detail?.customerCoupons?.length ?? 0}</span></div><div className="drawer-record-list">{detail?.customerCoupons?.length ? detail.customerCoupons.map((item) => <div className="drawer-record-item" key={item.id}><div className="drawer-record-title">{item.coupon.name} <Tag color={item.status === 'USED' ? 'default' : item.status === 'EXPIRED' ? 'error' : 'blue'}>{item.status === 'USED' ? '已使用' : item.status === 'EXPIRED' ? '已过期' : '未使用'}</Tag></div><div className="drawer-record-description">减 {formatMoney(item.coupon.amountCents)} · 满 {formatMoney(item.coupon.minSpendCents)} · 发放 {formatDateTime(item.issuedAt)}{item.usedAt ? ` · 使用 ${formatDateTime(item.usedAt)}` : ''}</div></div>) : <div className="drawer-empty">暂无优惠券记录</div>}</div></div>
        <div className="drawer-section"><div className="drawer-section-title">订单记录 <span>{detail?.orders.length ?? 0}</span></div><div className="drawer-record-list">{detail?.orders.length ? detail.orders.map((item) => { const status = getOrderDisplayStatus(item); return <div className="drawer-record-item" key={item.id}><div className="drawer-record-title">{item.serviceItem} <Tag color={status.color}>{status.tagLabel}</Tag></div><div className="drawer-record-description">{item.orderNo} · {formatDateTime(item.createdAt)} · {formatMoney(item.amountCents)} · {item.staff?.name || '待分配'}</div></div> }) : <div className="drawer-empty">暂无订单记录</div>}</div></div>
      </Drawer>
    </div>
  )
}

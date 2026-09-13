import { useAuth } from '../../auth-context'
import { hasUserPermission } from '../../types'
import { EditOutlined, KeyOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, WalletOutlined, WarningOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Empty, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Tooltip } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../../api'
import { formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import { staffSelfAcceptingMeta, staffAcceptingMeta, staffAccountMeta, staffPresenceMeta, staffStatusMeta, type Staff, type StaffTier } from '../../types'
import { RequestError } from '../../components/RequestState'

type StaffFormValues = { username: string; password: string; name: string; phone?: string; contact?: string; realName?: string; idNumber?: string; note?: string; tierId?: string; commissionRate: number; accepting?: 'ACCEPTING' | 'PAUSED' }
type SettlementValues = { amount: number; settlementMethod: string; settlementDate: Dayjs; note?: string }
type WorkloadItem = { staffId: string; name: string; tier?: StaffTier | null; claimedCount: number; completedCount: number; inProgressCount: number; exitedCount: number; actualEarningCents: number }
type IncidentValues = { type: 'BAD_REVIEW' | 'ROLLOVER' | 'COMPLAINT'; note: string }
const identityMeta = { PENDING: { label: '待审核', color: 'warning' }, APPROVED: { label: '已通过', color: 'success' }, REJECTED: { label: '已驳回', color: 'error' } } as const

export const StaffPage = () => {
  const { user } = useAuth()
  const canManage = hasUserPermission(user, 'staff.manage')
  const canSettle = hasUserPermission(user, 'settlement.manage')
  const { message } = App.useApp()
  const [staff, setStaff] = useState<Staff[]>([])
  const [tiers, setTiers] = useState<StaffTier[]>([])
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [form] = Form.useForm<StaffFormValues>()
  const [passwordForm] = Form.useForm<{ password: string }>()
  const [reviewForm] = Form.useForm<{ status: 'APPROVED' | 'REJECTED'; note?: string }>()
  const [settlementForm] = Form.useForm<SettlementValues>()
  const [incidentForm] = Form.useForm<IncidentValues>()
  const [editing, setEditing] = useState<Staff | null>(null)
  const [resetting, setResetting] = useState<Staff | null>(null)
  const [reviewing, setReviewing] = useState<Staff | null>(null)
  const [settling, setSettling] = useState<Staff | null>(null)
  const [recordingIncident, setRecordingIncident] = useState<Staff | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [workload, setWorkload] = useState<WorkloadItem[]>([])
  const [workloadRange, setWorkloadRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('week'), dayjs().endOf('week')])

  const load = useCallback(async () => {
    setHasError(false)
    try {
      const [staffResponse, tierResponse] = await Promise.allSettled([api.get<{ items: Staff[] }>('/staff'), api.get<{ items: StaffTier[] }>('/staff-tiers')])
      if (staffResponse.status === 'rejected') throw staffResponse.reason
      setStaff(staffResponse.value.data.items)
      setTiers(tierResponse.status === 'fulfilled' ? tierResponse.value.data.items : [])
    }
    catch (error) { setHasError(true); message.error(getErrorMessage(error)) }
    finally { setLoading(false) }
  }, [message])
  useEffect(() => { void load() }, [load])

  const openCreate = () => { setEditing(null); form.resetFields(); form.setFieldsValue({ commissionRate: 30 }); setModalOpen(true) }
  const openEdit = (item: Staff) => { setEditing(item); form.setFieldsValue({ name: item.name, phone: item.phone ?? '', contact: item.contact ?? '', realName: item.realName ?? '', tierId: item.tier?.id, commissionRate: item.commissionRateBps / 100, username: item.username, note: item.note ?? '', accepting: item.accepting }); setModalOpen(true) }
  const save = async (values: StaffFormValues) => {
    try {
      if (editing) await api.patch('/staff/' + editing.id, { name: values.name, phone: values.phone ?? '', contact: values.contact ?? '', realName: values.realName ?? '', idNumber: values.idNumber ?? '', note: values.note ?? '', tierId: values.tierId || null, accepting: values.accepting, commissionRateBps: Math.round(values.commissionRate * 100) })
      else await api.post('/staff', { username: values.username, password: values.password, name: values.name, phone: values.phone ?? '', contact: values.contact ?? '', realName: values.realName ?? '', idNumber: values.idNumber ?? '', note: values.note ?? '', tierId: values.tierId, commissionRateBps: Math.round(values.commissionRate * 100) })
      message.success(editing ? '员工资料已更新' : '员工账号已创建')
      setModalOpen(false)
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }
  const toggleActive = async (item: Staff, isActive: boolean) => {
    try { await api.patch('/staff/' + item.id, { isActive }); message.success(isActive ? '账号已启用' : '账号已禁用'); await load() }
    catch (error) { message.error(getErrorMessage(error)) }
  }
  const updateAccountStatus = async (item: Staff, accountStatus: 'NORMAL' | 'FROZEN' | 'RETIRED') => {
    try { await api.patch('/staff/' + item.id, { accountStatus }); message.success('员工状态已更新'); await load() }
    catch (error) { message.error(getErrorMessage(error)) }
  }
  const reviewIdentity = async (values: { status: 'APPROVED' | 'REJECTED'; note?: string }) => {
    if (!reviewing) return
    try { await api.patch('/staff/' + reviewing.id + '/identity-review', values); message.success('实名资料审核结果已保存'); setReviewing(null); await load() }
    catch (error) { message.error(getErrorMessage(error)) }
  }
  const resetPassword = async () => {
    try { const values = await passwordForm.validateFields(); await api.post('/staff/' + resetting?.id + '/reset-password', values); message.success('密码已重置'); setResetting(null); passwordForm.resetFields() }
    catch (error) { if ((error as { errorFields?: unknown }).errorFields) return; message.error(getErrorMessage(error)) }
  }
  const settle = async (values: SettlementValues) => {
    if (!settling) return
    try { await api.post(`/staff/${settling.id}/settlements`, { ...values, requestId: crypto.randomUUID(), settlementDate: values.settlementDate.format('YYYY-MM-DD') }); message.success('线下结算已登记'); setSettling(null); settlementForm.resetFields(); await load() }
    catch (error) { message.error(getErrorMessage(error)) }
  }
  const loadWorkload = useCallback(async (range = workloadRange) => {
    try {
      const { data } = await api.get<{ items: WorkloadItem[] }>('/staff/workload', { params: { startDate: range[0].format('YYYY-MM-DD'), endDate: range[1].format('YYYY-MM-DD') } })
      setWorkload(data.items)
    } catch (error) { message.error(getErrorMessage(error)) }
  }, [message, workloadRange])
  useEffect(() => { void loadWorkload() }, [loadWorkload])
  const refreshStatistics = useCallback(() => { void load(); void loadWorkload() }, [load, loadWorkload])
  useRealtimeRefresh(refreshStatistics)
  const recordIncident = async (values: IncidentValues) => {
    if (!recordingIncident) return
    try { await api.post(`/staff/${recordingIncident.id}/incidents`, values); message.success('员工事件已记录'); setRecordingIncident(null); incidentForm.resetFields(); await load() }
    catch (error) { message.error(getErrorMessage(error)) }
  }

  if (loading) return <div className="page-loading"><span>正在加载员工资料…</span></div>
  if (hasError) return <RequestError onRetry={() => void load()} />

  return (
    <div className="content-stack">
      <section className="page-intro compact"><div><div className="eyebrow">人员管理 · 服务状态</div><h2>员工管理</h2><p>掌握员工账号、接单状态、服务层级与累计实际应得金额。</p></div><Button style={canManage ? undefined : { display: 'none' }} type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增员工</Button></section>
      <div className="staff-overview"><div><span className="overview-number">{staff.filter((item) => item.isActive).length}</span><span>个启用账号</span></div><div><span className="overview-number">{staff.filter((item) => item.status === 'IDLE').length}</span><span>人当前空闲</span></div><div><span className="overview-number">{staff.filter((item) => item.status === 'BUSY').length}</span><span>人正在服务</span></div></div>
      <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>区间工作量</strong><span className="card-subtitle">按员工参与记录统计接单、完单、退出与实际应得</span></div><Space wrap><DatePicker.RangePicker value={workloadRange} onChange={(value) => { if (value?.[0] && value[1]) setWorkloadRange([value[0], value[1]]) }} /><Button onClick={() => { const range: [Dayjs, Dayjs] = [dayjs().startOf('week'), dayjs().endOf('week')]; setWorkloadRange(range); void loadWorkload(range) }}>本周</Button><Button type="primary" onClick={() => void loadWorkload()}>查询</Button><Button onClick={() => { const range: [Dayjs, Dayjs] = [dayjs().startOf('month'), dayjs().endOf('month')]; setWorkloadRange(range); void loadWorkload(range) }}>重置</Button></Space></div><Table<WorkloadItem> rowKey="staffId" size="small" dataSource={workload} pagination={false} locale={{ emptyText: '所选区间暂无工作量记录' }} columns={[{ title: '员工', dataIndex: 'name' }, { title: '服务层级', render: (_: unknown, item: WorkloadItem) => item.tier?.name || '未设置' }, { title: '接单', dataIndex: 'claimedCount', render: (value: number) => `${value} 单` }, { title: '完成', dataIndex: 'completedCount', render: (value: number) => `${value} 单` }, { title: '当前进行中', dataIndex: 'inProgressCount', render: (value: number) => `${value} 单` }, { title: '退出', dataIndex: 'exitedCount', render: (value: number) => `${value} 次` }, { title: '区间实际应得', dataIndex: 'actualEarningCents', render: (value: number) => formatMoney(value) }]} /></Card>
      <Card className="table-card" variant="borderless"><div className="table-heading"><div><strong>员工档案</strong><span className="card-subtitle">状态与产能实时同步，空闲员工优先派单</span></div><Button type="text" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button></div><Table<Staff> rowKey="id" dataSource={staff} scroll={{ x: 2230 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有员工档案" /> }} columns={[{ title: '员工', width: 190, render: (_: unknown, item: Staff) => <div className="person-cell"><div className="person-avatar">{item.name.slice(0, 1)}</div><div><strong>{item.name}</strong><div className="table-secondary">{item.username} · {item.phone || '未留电话'}</div></div></div> }, { title: '服务状态', width: 150, render: (_: unknown, item: Staff) => <Space size={4} wrap><Tag color={staffStatusMeta[item.status].color}>{staffStatusMeta[item.status].label}</Tag></Space> }, { title: '管理接单权限', width: 140, render: (_: unknown, item: Staff) => <Select aria-label={item.name + '管理接单权限'} size="small" disabled={!canManage} value={item.accepting ?? 'ACCEPTING'} options={Object.entries(staffAcceptingMeta).map(([value, label]) => ({ value, label }))} onChange={async value => { try { await api.patch('/staff/' + item.id, { accepting: value }); message.success('管理接单权限已更新'); await load() } catch (error) { message.error(getErrorMessage(error)) } }} /> }, { title: '员工当前接单状态', width: 150, render: (_: unknown, item: Staff) => staffSelfAcceptingMeta[item.selfAccepting ?? 'ACCEPTING'] }, { title: '在线状态', width: 90, render: (_: unknown, item: Staff) => item.presence ? staffPresenceMeta[item.presence] : '—' }, { title: '进行中工单', dataIndex: 'inProgressCount', width: 110, render: (value: number) => <strong>{value} 单</strong> }, { title: '累计完成', dataIndex: 'completedCount', width: 100, render: (value: number) => value + ' 单' }, { title: '完成率', dataIndex: 'completionRate', width: 86, render: (value: number | undefined) => value === undefined ? '—' : `${(value * 100).toFixed(0)}%` }, { title: '事件记录', width: 170, render: (_: unknown, item: Staff) => { const counts = item.incidentCounts ?? { BAD_REVIEW: 0, ROLLOVER: 0, COMPLAINT: 0 }; return <div className="table-secondary">差评 {counts.BAD_REVIEW} · 翻车 {counts.ROLLOVER} · 投诉 {counts.COMPLAINT}</div> } }, { title: '累计实际应得', dataIndex: 'totalEarningsCents', width: 135, render: (value: number) => <strong>{formatMoney(value)}</strong> }, { title: '待结算', dataIndex: 'pendingSettlementCents', width: 110, render: (value: number | undefined) => formatMoney(value ?? 0) }, { title: '提成比例', dataIndex: 'commissionRateBps', width: 95, render: (value: number) => (value / 100).toFixed(2) + '%' }, { title: '服务层级', width: 120, render: (_: unknown, item: Staff) => item.tier?.name || '未设置' }, { title: '账号状态', width: 120, render: (_: unknown, item: Staff) => <Select disabled={!canManage} size="small" value={item.accountStatus ?? (item.isActive ? 'NORMAL' : 'FROZEN')} onChange={(value) => void updateAccountStatus(item, value)} options={Object.entries(staffAccountMeta).map(([value, label]) => ({ value, label }))} /> }, { title: '启用账号', width: 95, render: (_: unknown, item: Staff) => <Switch disabled={!canManage} size="small" checked={item.isActive} checkedChildren="启用" unCheckedChildren="禁用" onChange={(checked) => void toggleActive(item, checked)} /> }, { title: '实名审核', width: 115, render: (_: unknown, item: Staff) => <Button disabled={!canManage} type="link" icon={<SafetyCertificateOutlined />} onClick={() => { setReviewing(item); reviewForm.setFieldsValue({ status: item.identityStatus === 'APPROVED' ? 'APPROVED' : 'REJECTED', note: item.identityReviewNote ?? '' }) }}>{item.identityStatus ? identityMeta[item.identityStatus].label : '待审核'}</Button> }, { title: '操作', fixed: 'right', width: 190, render: (_: unknown, item: Staff) => <Space size={0}><Tooltip title="编辑资料"><Button style={canManage ? undefined : { display: 'none' }} type="text" aria-label={'编辑' + item.name + '资料'} icon={<EditOutlined />} onClick={() => openEdit(item)} /></Tooltip><Tooltip title="重置密码"><Button style={canManage ? undefined : { display: 'none' }} type="text" aria-label={'重置' + item.name + '密码'} icon={<KeyOutlined />} onClick={() => { setResetting(item); passwordForm.resetFields() }} /></Tooltip><Tooltip title="登记线下结算"><Button style={canSettle ? undefined : { display: 'none' }} type="text" aria-label={'登记' + item.name + '线下结算'} icon={<WalletOutlined />} disabled={!item.pendingSettlementCents} onClick={() => { setSettling(item); settlementForm.resetFields() }} /></Tooltip><Tooltip title="记录员工事件"><Button style={canManage ? undefined : { display: 'none' }} type="text" aria-label={'记录' + item.name + '事件'} icon={<WarningOutlined />} onClick={() => { setRecordingIncident(item); incidentForm.resetFields() }} /></Tooltip></Space> }]} /></Card>
      <Modal title={editing ? '编辑员工资料' : '新增员工账号'} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => form.submit()} okText="保存" cancelText="返回" destroyOnHidden><Form<StaffFormValues> form={form} layout="vertical" onFinish={save} preserve={false}><div className="form-grid-two"><Form.Item name="name" label="员工昵称" rules={[{ required: true, message: '请输入员工昵称' }]}><Input placeholder="例如：阿凯" /></Form.Item><Form.Item name="realName" label="实名姓名"><Input placeholder="选填，提交后由管理员审核" /></Form.Item></div><div className="form-grid-two"><Form.Item name="phone" label="联系电话"><Input placeholder="选填" /></Form.Item><Form.Item name="idNumber" label="证件信息"><Input placeholder="选填，列表仅显示脱敏结果" /></Form.Item></div><Form.Item name="contact" label="其他联系方式"><Input placeholder="选填" /></Form.Item>{!editing && <><Form.Item name="username" label="登录账号" rules={[{ required: true, message: '请输入登录账号' }]}><Input placeholder="至少 2 位字符" /></Form.Item><Form.Item name="password" label="初始密码" rules={[{ required: true, min: 6, message: '密码至少 6 位' }]}><Input.Password placeholder="至少 6 位" /></Form.Item></>}<div className="form-grid-two"><Form.Item name="tierId" label="服务层级"><Select allowClear placeholder="选择服务层级" options={tiers.filter((item) => item.isEnabled).map((item) => ({ value: item.id, label: item.name }))} /></Form.Item><Form.Item name="commissionRate" label="默认提成比例（%）" rules={[{ required: true, message: '请输入提成比例' }]}><InputNumber min={0} max={100} precision={2} style={{ width: '100%' }} /></Form.Item></div>{editing && <div className="form-grid-two"><Form.Item label="在线状态"><span>由员工工作台连接自动判断</span></Form.Item><Form.Item name="accepting" label="管理接单权限"><Select options={Object.entries(staffAcceptingMeta).map(([value, label]) => ({ value, label }))} /></Form.Item></div>}<Form.Item name="note" label="备注"><Input.TextArea rows={3} /></Form.Item></Form></Modal>
      <Modal title={'实名资料审核 · ' + (reviewing?.name ?? '')} open={Boolean(reviewing)} onCancel={() => setReviewing(null)} onOk={() => reviewForm.submit()} okText="保存审核结果" cancelText="返回"><Form form={reviewForm} layout="vertical" onFinish={reviewIdentity}><Form.Item name="status" label="审核结果" rules={[{ required: true }]}><Select options={[{ value: 'APPROVED', label: '通过' }, { value: 'REJECTED', label: '驳回' }]} /></Form.Item><Form.Item label="实名信息"><span>{reviewing?.realName || '未录入'} · {reviewing?.idNumberMasked || '证件号未录入'}</span></Form.Item><Form.Item name="note" label="审核备注"><Input.TextArea rows={3} /></Form.Item></Form></Modal>
      <Modal title={'重置 ' + (resetting?.name ?? '') + ' 的登录密码'} open={Boolean(resetting)} onCancel={() => setResetting(null)} onOk={() => void resetPassword()} okText="确认重置" cancelText="返回"><Form form={passwordForm} layout="vertical"><Form.Item name="password" label="新密码" rules={[{ required: true, min: 6, message: '密码至少 6 位' }]}><Input.Password placeholder="请输入新密码" /></Form.Item></Form></Modal>
      <Modal title={'登记 ' + (settling?.name ?? '') + ' 的线下结算'} open={Boolean(settling)} onCancel={() => setSettling(null)} onOk={() => settlementForm.submit()} okText="保存结算记录" cancelText="返回"><Form form={settlementForm} layout="vertical" onFinish={settle} initialValues={{ settlementMethod: '线下现金', settlementDate: dayjs() }}><Form.Item label="当前待结算">{formatMoney(settling?.pendingSettlementCents ?? 0)}</Form.Item><Form.Item name="amount" label="结算金额（元）" rules={[{ required: true, message: '请输入结算金额' }]}><InputNumber min={0.01} precision={2} max={(settling?.pendingSettlementCents ?? 0) / 100} style={{ width: '100%' }} /></Form.Item><Form.Item name="settlementMethod" label="结算方式" rules={[{ required: true }]}><Select options={[{ value: '线下现金', label: '线下现金' }, { value: '银行转账', label: '银行转账' }, { value: '其他线下方式', label: '其他线下方式' }]} /></Form.Item><Form.Item name="settlementDate" label="结算日期" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item><Form.Item name="note" label="备注"><Input.TextArea rows={2} /></Form.Item></Form></Modal>
      <Modal title={'记录 ' + (recordingIncident?.name ?? '') + ' 的员工事件'} open={Boolean(recordingIncident)} onCancel={() => setRecordingIncident(null)} onOk={() => incidentForm.submit()} okText="保存记录" cancelText="返回"><Form form={incidentForm} layout="vertical" onFinish={recordIncident}><Form.Item name="type" label="事件类型" rules={[{ required: true, message: '请选择事件类型' }]}><Select options={[{ value: 'BAD_REVIEW', label: '差评记录' }, { value: 'ROLLOVER', label: '翻车记录' }, { value: 'COMPLAINT', label: '投诉记录' }]} /></Form.Item><Form.Item name="note" label="事件说明" rules={[{ required: true, message: '请填写事件说明' }]}><Input.TextArea rows={4} /></Form.Item></Form></Modal>
    </div>
  )
}

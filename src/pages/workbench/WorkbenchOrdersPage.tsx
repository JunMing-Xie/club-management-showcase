import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  EyeOutlined,
  FileImageOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import {
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Image,
  Input,
  Modal,
  Segmented,
  Spin,
  Tag,
  Upload,
  type UploadFile,
} from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, getErrorMessage } from '../../api'
import { useAuth } from '../../auth-context'
import { RequestError } from '../../components/RequestState'
import { formatDateTime, formatMoney } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import {
  getOrderDisplayStatus,
  type Order,
  type OrderStaffAssignmentStatus,
  type OrderStatus,
} from '../../types'

type OrderTab = 'AVAILABLE' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'
type ExitForm = { reason?: string }
type CompletionForm = { note: string }

const activeAssignmentStatuses: OrderStaffAssignmentStatus[] = ['CLAIMED', 'ACTIVE', 'EXIT_REQUESTED', 'COMPLETED']
type StaffOrderProof = NonNullable<Order['assignments'][number]['completionProofs']>[number]

const StaffOrderProofImage = ({ proof }: { proof: StaffOrderProof }) => {
  const [source, setSource] = useState<string>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let mounted = true
    let objectUrl = ''
    setFailed(false)
    void api.get<Blob>(proof.fileUrl.replace(/^\/api/, ''), { responseType: 'blob' }).then((response) => {
      objectUrl = URL.createObjectURL(response.data)
      if (mounted) setSource(objectUrl)
    }).catch(() => {
      if (mounted) setFailed(true)
    })
    return () => {
      mounted = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [proof.fileUrl])

  if (source) return <Image width="100%" height="100%" src={source} alt="完单凭证" className="workbench-order-proof-image" preview />
  return <div className="workbench-order-proof-loading">{failed ? '凭证加载失败' : <Spin size="small" />}</div>
}

const uniqueOrders = (groups: Order[][]) => {
  const items = new Map<string, Order>()
  for (const group of groups) for (const order of group) items.set(order.id, order)
  return [...items.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export const WorkbenchOrdersPage = () => {
  const { message } = App.useApp()
  const { user } = useAuth()
  const staffId = user?.staffProfile?.id
  const [orders, setOrders] = useState<Order[]>([])
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<OrderTab>(() => searchParams.get('orderId') ? 'COMPLETED' : searchParams.get('tab') === 'AVAILABLE' ? 'AVAILABLE' : 'PENDING')
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const requestedOrderId = searchParams.get('orderId')
  const [openedOrderId, setOpenedOrderId] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Order | null>(null)
  const [actionOrder, setActionOrder] = useState<Order | null>(null)
  const [exitOpen, setExitOpen] = useState(false)
  const [completionOpen, setCompletionOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [proofFiles, setProofFiles] = useState<UploadFile[]>([])
  const [exitForm] = Form.useForm<ExitForm>()
  const [completionForm] = Form.useForm<CompletionForm>()

  const load = useCallback(async () => {
    setHasError(false)
    setLoading(true)
    try {
      if (tab === 'AVAILABLE') {
        const response = await api.get<{ items: Order[] }>('/workbench/available-orders')
        setOrders(response.data.items)
      } else {
        const statuses: OrderStatus[] = tab === 'PENDING'
          ? ['PENDING_ASSIGNMENT', 'PENDING']
          : tab === 'IN_PROGRESS'
            ? ['IN_PROGRESS', 'PENDING_COMPLETION_REVIEW']
            : ['COMPLETED', 'AFTER_SALE']
        const responses = await Promise.all(statuses.map((status) => api.get<{ items: Order[] }>('/orders', { params: { status } })))
        setOrders(uniqueOrders(responses.map((response) => response.data.items)))
      }
    } catch (error) {
      setHasError(true)
      message.error(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [message, tab])

  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)
  useEffect(() => {
    if (!requestedOrderId || openedOrderId === requestedOrderId) return
    let active = true
    void api.get<{ item: Order }>(`/orders/${requestedOrderId}`).then(({ data }) => {
      if (active) { setViewing(data.item); setOpenedOrderId(requestedOrderId) }
    }).catch((error) => { if (active) message.error(getErrorMessage(error)) })
    return () => { active = false }
  }, [requestedOrderId, openedOrderId, message])

  const assignmentFor = useCallback((order: Order) => {
    if (tab === 'AVAILABLE') return order.assignments.find((assignment) => assignment.assignmentStatus === 'OPEN')
    return order.assignments.find((assignment) => assignment.staffId === staffId && activeAssignmentStatuses.includes(assignment.assignmentStatus))
  }, [staffId, tab])

  const amountFor = useCallback((order: Order) => {
    const assignment = assignmentFor(order)
    if (!assignment) return 0
    return order.status === 'COMPLETED' || order.status === 'AFTER_SALE'
      ? assignment.currentNetEarningCents ?? assignment.actualEarningCents ?? 0
      : assignment.expectedEarningCents
  }, [assignmentFor])

  const amountLabelFor = (order: Order) => order.status === 'COMPLETED' || order.status === 'AFTER_SALE' ? '实际应得' : '预计应得'

  useEffect(() => {
    if (!viewing?.id || tab === 'AVAILABLE') return
    let active = true
    void api.get<{ item: Order }>(`/orders/${viewing.id}`).then(({ data }) => {
      if (active) setViewing(data.item)
    }).catch(() => { /* Keep the last complete detail if a background refresh fails. */ })
    return () => { active = false }
  }, [orders, viewing?.id, tab])

  const runOrderAction = async (order: Order, action: 'claim' | 'start') => {
    setSubmitting(true)
    try {
      const response = await api.post<{ item: Order }>('/orders/' + order.id + '/' + action)
      message.success(action === 'claim' ? '接单成功，已进入我的订单' : response.data.item.isTeamFull ? '订单已开始处理' : '已提交开始处理')
      await load()
      if (action === 'claim') setTab('PENDING')
    } catch (error) {
      message.error(getErrorMessage(error))
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  const openDetails = async (order: Order) => {
    if (tab === 'AVAILABLE') {
      setViewing(order)
      return
    }
    try {
      const { data } = await api.get<{ item: Order }>(`/orders/${order.id}`)
      setViewing(data.item)
    } catch (error) {
      message.error(getErrorMessage(error))
    }
  }

  const openExit = (order: Order) => {
    exitForm.resetFields()
    setActionOrder(order)
    setExitOpen(true)
  }

  const submitExit = async () => {
    if (!actionOrder) return
    const values = await exitForm.validateFields()
    setSubmitting(true)
    try {
      const { data } = await api.post<{ exitReviewRequired: boolean }>(`/orders/${actionOrder.id}/exit`, values)
      message.success(data.exitReviewRequired ? '退出申请已提交，请等待管理员处理' : '已退出该订单')
      setExitOpen(false)
      setActionOrder(null)
      await load()
    } catch (error) {
      message.error(getErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  const openCompletion = (order: Order) => {
    completionForm.resetFields()
    setProofFiles([])
    setActionOrder(order)
    setCompletionOpen(true)
  }

  const submitCompletion = async () => {
    if (!actionOrder) return
    const values = await completionForm.validateFields()
    if (proofFiles.length === 0) {
      message.error('请至少上传一张完单凭证')
      return
    }
    const formData = new FormData()
    formData.append('note', values.note.trim())
    for (const file of proofFiles) {
      if (file.originFileObj) formData.append('proofs', file.originFileObj)
    }
    setSubmitting(true)
    try {
      const { data } = await api.post<{ item: Order }>(`/orders/${actionOrder.id}/completion-submissions`, formData)
      const waitingForOthers = data.item.status === 'IN_PROGRESS'
      message.success(waitingForOthers ? '凭证已提交，等待其他协作员工提交' : '全部员工已提交，等待管理员审核')
      setCompletionOpen(false)
      setActionOrder(null)
      setProofFiles([])
      await load()
    } catch (error) {
      message.error(getErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  const emptyText = tab === 'AVAILABLE'
    ? '暂无符合当前档位的可接订单'
    : tab === 'PENDING'
      ? '暂无待处理订单'
      : tab === 'IN_PROGRESS'
        ? '暂无进行中或待审核订单'
        : '还没有已完成订单'

  const viewingAssignment = viewing ? assignmentFor(viewing) : undefined
  const viewingStatus = viewing ? getOrderDisplayStatus(viewing) : null
  const viewingIsFinalized = Boolean(viewing && ['COMPLETED', 'AFTER_SALE'].includes(viewing.status))
  const viewingAmount = viewing ? amountFor(viewing) : 0
  const viewingProofs = viewing?.assignments.flatMap((assignment) => assignment.staffId === staffId
    ? (assignment.completionProofs ?? []).map((proof) => ({ proof, assignment }))
    : []) ?? []
  const viewingActiveAssignments = viewing?.assignments.filter((assignment) => assignment.staff && activeAssignmentStatuses.includes(assignment.assignmentStatus)) ?? []
  const viewingAdjustments = viewing?.adjustments ?? []
  const viewingAfterSaleMessages = viewing?.afterSaleCase?.messages ?? []
  const completionReviewLabel = viewing?.completionReviewReason || (viewing?.completionReviewStatus === 'SUBMITTED'
    ? '等待管理员审核'
    : viewing?.completionReviewStatus === 'APPROVED'
      ? '审核通过'
      : viewing?.completionReviewStatus === 'REJECTED'
        ? '已退回，请重新提交'
        : '尚未提交')

  return (
    <div className="workbench-stack">
      <section className="mobile-page-heading">
        <div><div className="eyebrow">我的订单 · 工单队列</div><h1>我的订单</h1></div>
        <Button type="text" icon={<ReloadOutlined />} onClick={() => void load()} aria-label="刷新订单" />
      </section>
      <Segmented
        block
        value={tab}
        onChange={(value) => setTab(value as OrderTab)}
        options={[
          { label: '可接订单', value: 'AVAILABLE' },
          { label: '待处理', value: 'PENDING' },
          { label: '进行中', value: 'IN_PROGRESS' },
          { label: '已完成', value: 'COMPLETED' },
        ]}
        className="order-tabs"
      />
      {loading
        ? <div className="page-loading"><span>正在加载订单…</span></div>
        : hasError
          ? <RequestError onRetry={() => void load()} />
          : orders.length === 0
            ? <Card variant="borderless" className="empty-card"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} /></Card>
            : <div className="mobile-order-list">
                {orders.map((order) => {
                  const assignment = assignmentFor(order)
                  const hasSubmitted = assignment?.completionReviewStatus === 'SUBMITTED'
                  const wasRejected = assignment?.completionReviewStatus === 'REJECTED'
                  const exitPending = assignment?.assignmentStatus === 'EXIT_REQUESTED'
                  const canStart = (order.status === 'PENDING' || order.status === 'PENDING_ASSIGNMENT') && order.isTeamFull
                  const displayStatus = getOrderDisplayStatus(order)
                  return (
                    <Card key={order.id} className={'mobile-order-card ' + order.status.toLowerCase()} variant="borderless">
                      <div className="mobile-order-top">
                        <span className="mono-text">{order.orderNo}</span>
                        <Tag color={displayStatus.color}>{displayStatus.tagLabel}</Tag>
                      </div>
                      <h3>{order.serviceItem}</h3>
                      <div className="mobile-order-customer">{order.customer.customerCode ? `客户ID ${order.customer.customerCode} · 组队码 ${order.customer.teamCode}` : '客户业务信息接单后可见'}</div>
                      <div className="mobile-team-progress"><TeamOutlined /> 协作人数 {order.activeStaffCount}/{order.requiredStaffCount}{order.isTeamFull ? ' · 已到齐' : ` · 还差 ${order.missingStaffCount} 人`}</div>
                      <div className="mobile-order-data">
                        <div><span>工单价格</span><strong>{formatMoney(order.currentNetAmountCents ?? order.amountCents)}</strong></div>
                        <div><span>{amountLabelFor(order)}</span><strong>{formatMoney(amountFor(order))}</strong></div>
                      </div>
                      {wasRejected && <div className="order-review-notice error">审核退回：{assignment?.completionReviewReason || order.completionReviewReason || '请补充凭证后重新提交'}</div>}
                      {hasSubmitted && <div className="order-review-notice"><CheckCircleOutlined /> 已提交凭证，当前 {order.completionSubmittedCount}/{order.completionRequiredCount || order.requiredStaffCount} 人完成提交</div>}
                      {exitPending && <div className="order-review-notice">退出申请已提交，管理员处理前仍保留当前订单权限。</div>}
                      <div className="mobile-order-foot">
                        <span><ClockCircleOutlined /> {formatDateTime(order.completedAt ?? order.createdAt)}</span>
                        {order.note && <span className="order-note">备注：{order.note}</span>}
                      </div>
                      <div className="mobile-order-actions">
                        <Button type="link" icon={<EyeOutlined />} onClick={() => void openDetails(order)}>查看详情</Button>
                        {tab === 'AVAILABLE' && <Button type="primary" icon={<ThunderboltOutlined />} loading={submitting} onClick={() => void runOrderAction(order, 'claim')}>接单</Button>}
                        {tab === 'PENDING' && <Button icon={<LogoutOutlined />} disabled={exitPending} onClick={() => openExit(order)}>退出订单</Button>}
                        {tab === 'PENDING' && <Button type="primary" icon={<PlayCircleOutlined />} disabled={!canStart} loading={submitting} title={canStart ? '开始处理订单' : '协作人员到齐后可开始'} onClick={() => void runOrderAction(order, 'start')}>{canStart ? '开始处理' : '等待人员到齐'}</Button>}
                        {tab === 'IN_PROGRESS' && order.status === 'IN_PROGRESS' && <Button icon={<LogoutOutlined />} disabled={exitPending || hasSubmitted} onClick={() => openExit(order)}>{exitPending ? '退出审核中' : '申请退出'}</Button>}
                        {tab === 'IN_PROGRESS' && order.status === 'IN_PROGRESS' && <Button type="primary" icon={<UploadOutlined />} disabled={hasSubmitted || exitPending} onClick={() => openCompletion(order)}>{hasSubmitted ? '凭证已提交' : wasRejected ? '重新提交完单' : '提交完单凭证'}</Button>}
                        {tab === 'IN_PROGRESS' && order.status === 'PENDING_COMPLETION_REVIEW' && <Button type="primary" icon={<CheckCircleOutlined />} disabled>等待后台审核</Button>}
                      </div>
                    </Card>
                  )
                })}
              </div>}

      <Drawer className="workbench-order-detail-drawer" rootClassName="workbench-order-detail-drawer-root" getContainer={false} title="订单详情" open={Boolean(viewing)} onClose={() => setViewing(null)} placement="bottom" size="min(82vh, 680px)">
        {viewing && viewingStatus && (
          <div className="workbench-order-detail-shell">
            <header className="workbench-order-detail-header">
              <div>
                <div className="workbench-order-detail-kicker"><span className="mono-text">{viewing.orderNo}</span><span>·</span><span>员工订单</span></div>
                <h2>{viewing.serviceItem}</h2>
                <p>{viewing.servicePackage?.category ? `${viewing.servicePackage.category} · ` : ''}创建于 {formatDateTime(viewing.createdAt)}</p>
              </div>
              <Tag color={viewingStatus.color}>{viewingStatus.tagLabel}</Tag>
            </header>

            <div className="workbench-order-detail-summary" aria-label="订单摘要">
              <div className="workbench-order-detail-summary-item">
                <span>工单价格</span>
                <strong>{formatMoney(viewing.currentNetAmountCents ?? viewing.amountCents)}</strong>
                <small>{viewing.adjustments?.length ? '已含完单后调整' : '当前订单金额'}</small>
              </div>
              <div className={`workbench-order-detail-summary-item ${viewingIsFinalized ? 'actual' : ''}`}>
                <span>{amountLabelFor(viewing)}</span>
                <strong>{formatMoney(viewingAmount)}</strong>
                <small>{viewingIsFinalized ? '当前结算口径' : '审核通过后确认'}</small>
              </div>
              <div className="workbench-order-detail-summary-item">
                <span>协作进度</span>
                <strong>{viewing.activeStaffCount}/{viewing.requiredStaffCount} 人</strong>
                <small>{viewing.isTeamFull ? '人员已到齐' : `还差 ${viewing.missingStaffCount} 人`}</small>
              </div>
            </div>

            <div className="workbench-order-detail-grid">
              <section className="workbench-order-detail-column workbench-order-detail-left" aria-label="订单核心信息">
                <div className="workbench-order-detail-section">
                  <div className="workbench-order-detail-section-heading">
                    <div><span className="workbench-order-detail-section-icon"><DollarOutlined /></span><div><strong>核心信息</strong><small>金额、状态与订单口径</small></div></div>
                  </div>
                  <div className="workbench-order-detail-fields">
                    <div className="workbench-order-detail-field"><span>订单号</span><strong className="mono-text">{viewing.orderNo}</strong></div>
                    <div className="workbench-order-detail-field"><span>服务套餐</span><strong>{viewing.serviceItem}</strong></div>
                    <div className="workbench-order-detail-field"><span>客户 ID</span><strong>{viewing.customer.customerCode ?? '接单后可见'}</strong></div>
                    <div className="workbench-order-detail-field"><span>客户组队码</span><strong>{viewing.customer.teamCode ?? '接单后可见'}</strong></div>
                    <div className="workbench-order-detail-field"><span>工单价格</span><strong>{formatMoney(viewing.currentNetAmountCents ?? viewing.amountCents)}</strong></div>
                    <div className="workbench-order-detail-field workbench-order-detail-field-emphasis"><span>{amountLabelFor(viewing)}</span><strong>{formatMoney(viewingAmount)}</strong></div>
                    {viewingIsFinalized && <>
                      <div className="workbench-order-detail-field"><span>原始实际应得</span><strong>{formatMoney(viewingAssignment?.actualEarningCents ?? 0)}</strong></div>
                      <div className="workbench-order-detail-field"><span>累计收益调整</span><strong>{formatMoney(viewingAmount - (viewingAssignment?.actualEarningCents ?? 0))}</strong></div>
                    </>}
                    <div className="workbench-order-detail-field"><span>当前状态</span><Tag color={viewingStatus.color}>{viewingStatus.tagLabel}</Tag></div>
                    <div className="workbench-order-detail-field"><span>协作进度</span><strong><TeamOutlined /> {viewing.activeStaffCount}/{viewing.requiredStaffCount} 人</strong></div>
                    <div className="workbench-order-detail-field"><span>完单提交</span><strong>{viewing.completionSubmittedCount}/{viewing.completionRequiredCount || viewing.requiredStaffCount} 人</strong></div>
                    <div className="workbench-order-detail-field"><span>审核结果</span><strong>{completionReviewLabel}</strong></div>
                    <div className="workbench-order-detail-field"><span>创建时间</span><strong>{formatDateTime(viewing.createdAt)}</strong></div>
                    <div className="workbench-order-detail-field"><span>完成时间</span><strong>{viewing.completedAt ? formatDateTime(viewing.completedAt) : '—'}</strong></div>
                  </div>
                  {viewing.note && <div className="workbench-order-detail-note"><span>备注</span><p>{viewing.note}</p></div>}
                </div>
              </section>

              <section className="workbench-order-detail-column workbench-order-detail-right" aria-label="凭证与历史记录">
                <div className="workbench-order-detail-section">
                  <div className="workbench-order-detail-section-heading">
                    <div><span className="workbench-order-detail-section-icon"><FileImageOutlined /></span><div><strong>完单凭证</strong><small>服务完成后的提交材料</small></div></div>
                    <span className="workbench-order-detail-section-count">{viewingProofs.length ? `${viewingProofs.length} 张` : '暂无'}</span>
                  </div>
                  {viewingProofs.length ? <div className="workbench-order-proof-grid">{viewingProofs.map(({ proof, assignment }) => <div className="workbench-order-proof-item" key={proof.id}><div className="workbench-order-proof-frame"><StaffOrderProofImage proof={proof} /></div><div className="workbench-order-proof-meta"><strong>{assignment.staff?.name ?? '本人'} · {formatDateTime(proof.submittedAt)}</strong>{proof.note && <p>{proof.note}</p>}</div></div>)}</div> : <div className="workbench-order-detail-empty">暂无完单凭证</div>}
                </div>

                <div className="workbench-order-detail-section">
                  <div className="workbench-order-detail-section-heading">
                    <div><span className="workbench-order-detail-section-icon"><HistoryOutlined /></span><div><strong>收益调整记录</strong><small>完单后的金额变化明细</small></div></div>
                    <span className="workbench-order-detail-section-count">{viewingAdjustments.length ? `${viewingAdjustments.length} 条` : '暂无'}</span>
                  </div>
                  {viewingAdjustments.length ? <div className="workbench-order-adjustment-list">{viewingAdjustments.map((item) => <div className="workbench-order-adjustment-item" key={item.id}><div className="workbench-order-adjustment-head"><strong>{item.reason}</strong><small>{formatDateTime(item.createdAt)}</small></div><div className="workbench-order-adjustment-amount">{formatMoney(item.orderAmountBeforeCents)} <span>→</span> {formatMoney(item.orderAmountAfterCents)}</div>{item.staffAdjustments.length ? <div className="workbench-order-adjustment-note">本人实际应得：{item.staffAdjustments.map((staffItem) => `${formatMoney(staffItem.earningBeforeCents)} → ${formatMoney(staffItem.earningAfterCents)}`).join('；')}</div> : <div className="workbench-order-adjustment-note">本次调整未记录当前员工收益变化</div>}{item.afterSale?.caseNo && <div className="workbench-order-adjustment-note">关联售后：{item.afterSale.caseNo}</div>}{item.handlingNote && <p>{item.handlingNote}</p>}</div>)}</div> : <div className="workbench-order-detail-empty">暂无收益调整记录</div>}
                </div>

                <div className="workbench-order-detail-section">
                  <div className="workbench-order-detail-section-heading">
                    <div><span className="workbench-order-detail-section-icon"><MessageOutlined /></span><div><strong>售后相关</strong><small>售后处理与跟进说明</small></div></div>
                    {viewing.afterSaleCase && <Tag color="warning">{viewing.status === 'AFTER_SALE' ? '售后中' : '已关联'}</Tag>}
                  </div>
                  {viewing.afterSaleCase ? <div className="workbench-order-after-sale"><div className="workbench-order-after-sale-summary">该订单已关联售后记录{viewingAfterSaleMessages.length ? `，共 ${viewingAfterSaleMessages.length} 条跟进` : ''}。</div>{viewingAfterSaleMessages.length ? <div className="workbench-order-after-sale-messages">{viewingAfterSaleMessages.map((item) => <div className="workbench-order-after-sale-message" key={item.id}><div><strong>{item.author.staffProfile?.name ? `${item.author.staffProfile.name} · ` : ''}{item.author.username}</strong><Tag>{item.author.role === 'STAFF' ? '员工' : '管理员'}</Tag></div><p>{item.content}</p><small>{formatDateTime(item.createdAt)}</small></div>)}</div> : <div className="workbench-order-detail-empty">暂无售后跟进记录</div>}</div> : <div className="workbench-order-detail-empty">暂无关联售后</div>}
                </div>

                <div className="workbench-order-detail-section">
                  <div className="workbench-order-detail-section-heading">
                    <div><span className="workbench-order-detail-section-icon"><TeamOutlined /></span><div><strong>协作与提交记录</strong><small>参与成员的当前提交状态</small></div></div>
                  </div>
                  {tab !== 'AVAILABLE' && viewingActiveAssignments.length ? <div className="workbench-order-assignment-list">{viewingActiveAssignments.map((assignment) => <div className="workbench-order-assignment-row" key={assignment.id ?? `${assignment.slotIndex}-${assignment.staffId}`}><span>{assignment.slotIndex} 号位 · {assignment.staff?.name}</span><Tag color={assignment.completionReviewStatus === 'APPROVED' ? 'success' : assignment.completionReviewStatus === 'SUBMITTED' ? 'blue' : assignment.completionReviewStatus === 'REJECTED' ? 'error' : 'default'}>{assignment.completionReviewStatus === 'APPROVED' ? '审核通过' : assignment.completionReviewStatus === 'SUBMITTED' ? '已提交' : assignment.completionReviewStatus === 'REJECTED' ? '已退回' : '未提交'}</Tag></div>)}</div> : <div className="workbench-order-detail-empty">暂无协作提交记录</div>}
                </div>
              </section>
            </div>
          </div>
        )}
      </Drawer>

      <Modal title={actionOrder?.startedAt ? '申请退出协作订单' : '退出协作订单'} open={exitOpen} onCancel={() => { setExitOpen(false); setActionOrder(null) }} onOk={() => void submitExit()} confirmLoading={submitting} okText={actionOrder?.startedAt ? '提交退出申请' : '确认退出'} cancelText="取消" destroyOnHidden>
        <Form form={exitForm} layout="vertical">
          <div className="workbench-form-tip">{actionOrder?.startedAt ? '订单已经开始，退出需由管理员审核；审核前你仍是当前协作成员。' : '服务尚未开始，确认后会立即释放当前名额。'}</div>
          <Form.Item name="reason" label="退出原因" rules={actionOrder?.startedAt ? [{ required: true, message: '请填写退出原因' }] : []}>
            <Input.TextArea rows={3} maxLength={500} showCount placeholder={actionOrder?.startedAt ? '请说明申请退出的原因' : '可选填退出原因'} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="提交完单凭证" open={completionOpen} onCancel={() => { setCompletionOpen(false); setActionOrder(null); setProofFiles([]) }} onOk={() => void submitCompletion()} confirmLoading={submitting} okText="提交后台审核" cancelText="取消" destroyOnHidden>
        <Form form={completionForm} layout="vertical">
          <div className="workbench-form-tip">每位协作员工都需提交自己的服务凭证。全部提交后，由管理员统一审核并完成订单结算。</div>
          <Form.Item label="完单凭证" required>
            <Upload accept="image/jpeg,image/png,image/webp" listType="picture-card" fileList={proofFiles} beforeUpload={() => false} onChange={({ fileList }) => setProofFiles(fileList.slice(0, 6))} onRemove={(file) => { setProofFiles((current) => current.filter((item) => item.uid !== file.uid)); return true }} maxCount={6}>
              {proofFiles.length < 6 && <div><UploadOutlined /><div className="upload-label">上传图片</div></div>}
            </Upload>
            <div className="field-help">支持 JPG、PNG、WebP，单张不超过 5MB，最多 6 张。</div>
          </Form.Item>
          <Form.Item name="note" label="服务说明" rules={[{ required: true, whitespace: true, message: '请填写服务说明' }]}>
            <Input.TextArea rows={4} maxLength={2000} showCount placeholder="说明本次服务完成情况，便于管理员审核" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

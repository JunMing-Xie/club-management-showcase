import { canAdjustOrderNet, unsettledAdjustmentMessage } from '../../order-adjustment'
import { AfterSaleMessages } from '../../components/AfterSaleMessages'
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  FilterOutlined,
  InfoCircleOutlined,
  LockOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  TeamOutlined,
  UnlockOutlined,
} from '@ant-design/icons'
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth-context'
import { DispatchStatistics } from '../../components/DispatchStatistics'
import { DeleteOrderButton } from '../../components/DeleteOrderButton'
import { canViewAdminSection, hasUserPermission } from '../../types'
import { api, getErrorMessage } from '../../api'
import { RequestError } from '../../components/RequestState'
import { formatDateTime, formatMoney, yuanToCents } from '../../helpers'
import { useRealtimeRefresh } from '../../realtime'
import {
  getAdminStaffAmountLabel,
  getOrderDisplayStatus,
  orderStatusMeta,
  staffStatusMeta,
  type Customer,
  type Order,
  type OrderStatus,
  type StaffOption,
  type StaffTier,
} from '../../types'

type CollaborationSlotForm = { slotIndex: number; commissionRatePercent: number }
type OrderFormValues = {
  customerMode: 'EXISTING' | 'NEW'
  customerId?: string
  newCustomerCode?: string
  newCustomerTeamCode?: string
  newCustomerNote?: string
  servicePackageId: string
  amountYuan: number
  preassignedStaffIds?: string[]
  requiredTierId?: string
  requiredStaffCount: number
  slots: CollaborationSlotForm[]
  customerCouponId?: string
  rechargeYuan?: number
  rechargeNote?: string
  note?: string
}
type FilterValues = { search?: string; status?: OrderStatus; staffId?: string; range?: [Dayjs, Dayjs] | null }
type PackageOption = { id: string; name: string; category: string | null; description: string | null; basePriceCents: number; isEnabled: boolean }
type CustomerCouponOption = { id: string; status: string; usedAt?: string | null; coupon: { name: string; amountCents: number; minSpendCents: number; startAt: string; endAt: string; isEnabled: boolean } }
type OrderAdjustmentForm = { netAmount: number; reason: string; handlingNote?: string; staffNetEarnings: Array<{ assignmentId: string; amount: number }> }
const UNRESTRICTED_TIER = 'UNRESTRICTED'

const currentSlots = (order: Order) => order.assignments
  .filter((assignment) => assignment.assignmentStatus !== 'EXITED')
  .sort((a, b) => a.slotIndex - b.slotIndex)

const participatingSlots = (order: Order) => currentSlots(order).filter((assignment) => assignment.staff && assignment.assignmentStatus !== 'OPEN')

const statusTag = (order: Order) => {
  const status = getOrderDisplayStatus(order)
  return <Tag color={status.color}>{status.tagLabel}</Tag>
}

const ProofImage = ({ proof }: { proof: NonNullable<Order['assignments'][number]['completionProofs']>[number] }) => {
  const [source, setSource] = useState<string>()
  useEffect(() => {
    let mounted = true
    let objectUrl = ''
    void api.get<Blob>(proof.fileUrl.replace(/^\/api/, ''), { responseType: 'blob' }).then((response) => {
      objectUrl = URL.createObjectURL(response.data)
      if (mounted) setSource(objectUrl)
    }).catch(() => undefined)
    return () => {
      mounted = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [proof.fileUrl])
  return source
    ? <Image width={104} height={76} src={source} alt="完单凭证" className="completion-proof-image" />
    : <div className="completion-proof-loading"><Spin size="small" /></div>
}

export const OrdersPage = () => {
  const { message, modal } = App.useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const { user } = useAuth()
  const canCreate = hasUserPermission(user, 'orders.create')
  const canEdit = hasUserPermission(user, 'orders.edit')
  const canReview = hasUserPermission(user, 'orders.review')
  const canAssign = hasUserPermission(user, 'orders.assign')
  const canLock = hasUserPermission(user, 'orders.lock')
  const canCancel = hasUserPermission(user, 'orders.cancel')
  const canCreateCustomer = hasUserPermission(user, 'customers.manage')
  const canRecharge = hasUserPermission(user, 'customers.recharge')
  const canReadCustomers = canViewAdminSection(user, 'customers')
  const canReadStaff = canViewAdminSection(user, 'staff')
  const requestedOrderId = searchParams.get('orderId')
  const reminderKind = searchParams.get('reminderKind')
  const [orders, setOrders] = useState<Order[]>([])
  const [customers, setCustomers] = useState<Pick<Customer, 'id' | 'customerCode' | 'teamCode'>[]>([])
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([])
  const [packages, setPackages] = useState<PackageOption[]>([])
  const [tiers, setTiers] = useState<StaffTier[]>([])
  const [customerCoupons, setCustomerCoupons] = useState<CustomerCouponOption[]>([])
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [filters, setFilters] = useState<FilterValues>(() => {
    const rawStatus = searchParams.get('status')
    const status = rawStatus && Object.prototype.hasOwnProperty.call(orderStatusMeta, rawStatus) ? rawStatus as OrderStatus : undefined
    const range: [Dayjs, Dayjs] | undefined = searchParams.get('scope') === 'today' ? [dayjs().startOf('day'), dayjs().endOf('day')] : undefined
    return { status, range }
  })
  const [mobileSearch, setMobileSearch] = useState(filters.search ?? '')
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [form] = Form.useForm<OrderFormValues>()
  const [assignForm] = Form.useForm<{ staffId: string; slotIndex?: number }>()
  const [ratesForm] = Form.useForm<{ slots: CollaborationSlotForm[] }>()
  const [adjustmentForm] = Form.useForm<OrderAdjustmentForm>()
  const [mobileFilterForm] = Form.useForm<FilterValues>()
  const [editing, setEditing] = useState<Order | null>(null)
  const [viewing, setViewing] = useState<Order | null>(null)
  const [assigning, setAssigning] = useState<Order | null>(null)
  const [editingRates, setEditingRates] = useState<Order | null>(null)
  const [rejecting, setRejecting] = useState<Order | null>(null)
  const [adjustingOrder, setAdjustingOrder] = useState<Order | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const customerMode = Form.useWatch('customerMode', form) ?? 'EXISTING'
  const selectedPackageId = Form.useWatch('servicePackageId', form)
  const requiredStaffCount = Form.useWatch('requiredStaffCount', form) ?? 1
  const watchedSlots = (Form.useWatch('slots', form) ?? []) as CollaborationSlotForm[]
  const selectedPackage = packages.find((item) => item.id === selectedPackageId)

  const load = useCallback(async () => {
    setHasError(false)
    try {
      const [orderResponse, customerResponse, staffResponse, packageResponse, tierResponse] = await Promise.allSettled([
        api.get<{ items: Order[] }>('/orders', { params: reminderKind ? { status: reminderKind === 'completion' ? 'PENDING_COMPLETION_REVIEW' : undefined } : { search: filters.search, status: filters.status, staffId: filters.staffId, from: filters.range?.[0]?.startOf('day').toISOString(), to: filters.range?.[1]?.endOf('day').toISOString() } }),
        canReadCustomers ? api.get<{ items: Customer[] }>('/customers') : Promise.resolve({ data: { items: [] } }),
        canReadStaff ? api.get<{ items: StaffOption[] }>('/staff/options') : canAssign ? api.get<{ items: StaffOption[] }>('/order-options/staff') : Promise.resolve({ data: { items: [] } }),
        api.get<{ items: PackageOption[] }>('/packages'),
        canReadStaff ? api.get<{ items: StaffTier[] }>('/staff-tiers') : canCreate ? api.get<{ items: StaffTier[] }>('/order-options/tiers') : Promise.resolve({ data: { items: [] } }),
      ])
      if (orderResponse.status === 'rejected') throw orderResponse.reason
      const nextOrders = orderResponse.value.data.items.filter((order) => reminderKind !== 'exit' || order.assignments.some((assignment) => assignment.assignmentStatus === 'EXIT_REQUESTED' && assignment.exitReviewStatus === 'PENDING'))
      setOrders(nextOrders)
      setViewing((current) => current ? nextOrders.find((item) => item.id === current.id) ?? (reminderKind ? null : current) : null)
      setCustomers(customerResponse.status === 'fulfilled' ? customerResponse.value.data.items : [])
      setStaffOptions(staffResponse.status === 'fulfilled' ? staffResponse.value.data.items : [])
      setPackages(packageResponse.status === 'fulfilled' ? packageResponse.value.data.items : [])
      setTiers(tierResponse.status === 'fulfilled' ? tierResponse.value.data.items : [])
    } catch (error) {
      setHasError(true)
      message.error(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [filters, message, canReadCustomers, canReadStaff, canAssign, canCreate, reminderKind])

  useEffect(() => {
    if (!requestedOrderId) return
    let active = true
    void api.get<{ item: Order }>(`/orders/${encodeURIComponent(requestedOrderId)}`).then(({ data }) => {
      if (active) setViewing(data.item)
    }).catch((error: unknown) => { if (active) message.error(getErrorMessage(error)) })
    return () => { active = false }
  }, [requestedOrderId, location.key, message])

  useEffect(() => { void load() }, [load])
  useRealtimeRefresh(load)

  const searchCustomers = async (search: string) => {
    if (canReadCustomers || !canCreate) return
    if (!search.trim()) { setCustomers([]); return }
    try { const { data } = await api.get<{ items: Pick<Customer, 'id' | 'customerCode' | 'teamCode'>[] }>('/order-options/customers', { params: { search: search.trim() } }); setCustomers(data.items) } catch (error) { message.error(getErrorMessage(error)) }
  }
  const loadCustomerCoupons = async (customerId: string, currentCouponId?: string) => {
    if (!canReadCustomers) { setCustomerCoupons([]); return }
    try {
      const { data } = await api.get<{ items: CustomerCouponOption[] }>(`/customers/${customerId}/coupons`)
      setCustomerCoupons(data.items.filter((item) => item.status === 'ISSUED' || item.id === currentCouponId))
    } catch (error) {
      setCustomerCoupons([])
      message.error(getErrorMessage(error))
    }
  }

  const packagePrice = useCallback((packageId?: string, tierId?: string) => {
    const servicePackage = packages.find((item) => item.id === packageId)
    if (!servicePackage) return undefined
    const tier = tiers.find((item) => item.id === tierId)
    return Math.round(servicePackage.basePriceCents * (tier?.priceMultiplierBps ?? 10000) / 10000)
  }, [packages, tiers])

  const updateRecommendedPrice = (packageId?: string, tierId?: string, couponId?: string) => {
    const recommended = packagePrice(packageId, tierId)
    if (recommended === undefined) return
    const coupon = customerCoupons.find((item) => item.id === couponId)
    form.setFieldValue('amountYuan', Math.max(recommended - (coupon?.coupon.amountCents ?? 0), 0) / 100)
  }

  const syncSlots = (count: number) => {
    const existing = form.getFieldValue('slots') ?? []
    form.setFieldValue('slots', Array.from({ length: count }, (_, index) => ({
      slotIndex: index + 1,
      commissionRatePercent: existing[index]?.commissionRatePercent ?? 30,
    })))
  }

  const openMobileFilters = () => {
    mobileFilterForm.setFieldsValue({ status: filters.status, staffId: filters.staffId, range: filters.range })
    setMobileFiltersOpen(true)
  }

  const applyMobileFilters = (values: FilterValues) => {
    setFilters((current) => ({ ...current, status: values.status, staffId: values.staffId, range: values.range ?? undefined }))
    setMobileFiltersOpen(false)
  }

  const resetMobileFilters = () => {
    mobileFilterForm.resetFields()
    setFilters((current) => ({ ...current, status: undefined, staffId: undefined, range: undefined }))
    setMobileFiltersOpen(false)
  }

  const openCreate = () => {
    setEditing(null)
    setCustomerCoupons([])
    form.resetFields()
    form.setFieldsValue({ customerMode: 'EXISTING', requiredTierId: UNRESTRICTED_TIER, requiredStaffCount: 1, slots: [{ slotIndex: 1, commissionRatePercent: 30 }], rechargeYuan: 0 })
    setModalOpen(true)
  }

  const openEdit = (order: Order) => {
    setEditing(order)
    setCustomerCoupons([])
    if (order.customer.id) void loadCustomerCoupons(order.customer.id, order.customerCoupon?.id)
    form.setFieldsValue({
      customerMode: 'EXISTING',
      customerId: order.customer.id,
      servicePackageId: order.servicePackage?.id,
      amountYuan: order.amountCents / 100,
      requiredTierId: order.requiredTier?.id ?? UNRESTRICTED_TIER,
      requiredStaffCount: order.requiredStaffCount,
      slots: currentSlots(order).map((slot) => ({ slotIndex: slot.slotIndex, commissionRatePercent: slot.commissionRateBps / 100 })),
      customerCouponId: order.customerCoupon?.id,
      note: order.note ?? '',
    })
    setModalOpen(true)
  }

  const saveOrder = async (values: OrderFormValues) => {
    setSaving(true)
    try {
      const amountCents = yuanToCents(values.amountYuan) ?? 0
      const coupon = customerCoupons.find((item) => item.id === values.customerCouponId)
      const discountAmountCents = coupon?.coupon.amountCents ?? 0
      const body = {
        ...(values.customerMode === 'NEW'
          ? { newCustomer: { customerCode: values.newCustomerCode, teamCode: values.newCustomerTeamCode, note: values.newCustomerNote ?? '' } }
          : { customerId: values.customerId }),
        servicePackageId: values.servicePackageId,
        amountCents,
        originalAmountCents: amountCents + discountAmountCents,
        discountAmountCents,
        preassignedStaffIds: !editing ? values.preassignedStaffIds ?? [] : undefined,
        requiredTierId: values.requiredTierId === UNRESTRICTED_TIER ? null : values.requiredTierId || null,
        requiredStaffCount: values.requiredStaffCount,
        collaborationSlots: values.slots.map((slot, index) => ({ slotIndex: index + 1, commissionRateBps: Math.round(Number(slot.commissionRatePercent) * 100) })),
        customerCouponId: values.customerCouponId || null,
        rechargeAmountCents: !editing ? yuanToCents(values.rechargeYuan, false) ?? 0 : undefined,
        rechargeNote: !editing ? values.rechargeNote ?? '' : undefined,
        note: values.note ?? '',
      }
      if (editing) await api.patch(`/orders/${editing.id}`, body)
      else await api.post('/orders', body)
      message.success(editing ? '订单已更新' : '订单已创建')
      setModalOpen(false)
      await load()
    } catch (error) {
      message.error(getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const assignOrder = async () => {
    try {
      const values = await assignForm.validateFields()
      await api.post(`/orders/${assigning?.id}/assign`, values)
      message.success('协作名额已分配')
      setAssigning(null)
      await load()
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return
      message.error(getErrorMessage(error))
    }
  }

  const openAssign = (order: Order) => {
    setAssigning(order)
    const open = currentSlots(order).find((slot) => slot.assignmentStatus === 'OPEN')
    assignForm.resetFields()
    assignForm.setFieldValue('slotIndex', open?.slotIndex ?? 1)
  }

  const saveRates = async () => {
    try {
      const values = await ratesForm.validateFields()
      await api.patch(`/orders/${editingRates?.id}/assignment-rates`, { slots: values.slots.map((slot, index) => ({ slotIndex: index + 1, commissionRateBps: Math.round(Number(slot.commissionRatePercent) * 100) })) })
      message.success('协作提成已更新')
      setEditingRates(null)
      await load()
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return
      message.error(getErrorMessage(error))
    }
  }

  const adjustmentPending = useRef(false)
  const [adjustmentSaving, setAdjustmentSaving] = useState(false)

  const openAdjustment = (order: Order) => {
    if (!canAdjustOrderNet(order)) { message.warning({ key: 'order-adjustment', content: unsettledAdjustmentMessage }); return }
    const completedAssignments = order.assignments.filter((item) => item.assignmentStatus === 'COMPLETED' && item.id)
    setAdjustingOrder(order)
    adjustmentForm.setFieldsValue({
      netAmount: (order.currentNetAmountCents ?? order.amountCents) / 100,
      reason: '',
      handlingNote: '',
      staffNetEarnings: completedAssignments.map((item) => ({ assignmentId: item.id!, amount: (item.currentNetEarningCents ?? item.actualEarningCents ?? 0) / 100 })),
    })
  }

  const saveAdjustment = async (values: OrderAdjustmentForm) => {
    if (!adjustingOrder || adjustmentPending.current) return
    if (!canAdjustOrderNet(adjustingOrder)) { message.warning({ key: 'order-adjustment', content: unsettledAdjustmentMessage }); return }
    adjustmentPending.current = true
    setAdjustmentSaving(true)
    try {
      const { data } = await api.post<{ item: Order }>(`/orders/${adjustingOrder.id}/adjustments`, { ...values, requestId: crypto.randomUUID() })
      message.success('订单净额与员工应得调整已登记')
      setAdjustingOrder(null)
      setViewing(data.item)
      await load()
    } catch (error) { message.error({ key: 'order-adjustment', content: getErrorMessage(error) }) }
    finally { adjustmentPending.current = false; setAdjustmentSaving(false) }
  }

  const reviewCompletion = async (order: Order, approved: boolean, reason?: string) => {
    try {
      await api.post(`/orders/${order.id}/completion-review`, { approved, reason: reason ?? '' })
      message.success(approved ? '完单审核已通过，资金与收益已结算' : '完单申请已退回')
      setRejecting(null)
      setRejectReason('')
      await load()
    } catch (error) {
      message.error(getErrorMessage(error))
    }
  }

  const reviewExit = async (order: Order, assignmentId: string, approved: boolean) => {
    try {
      await api.post(`/orders/${order.id}/assignments/${assignmentId}/exit-review`, { approved })
      message.success(approved ? '已同意退出，协作名额已释放' : '已拒绝退出申请')
      await load()
    } catch (error) {
      message.error(getErrorMessage(error))
    }
  }

  const cancelOrder = async (order: Order) => {
    try {
      await api.post(`/orders/${order.id}/cancel`)
      message.success('订单已取消')
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  const confirmMobileCancel = (order: Order) => {
    modal.confirm({
      title: '取消订单',
      content: `确定取消订单 ${order.orderNo} 吗？`,
      okText: '确认取消',
      cancelText: '返回',
      okButtonProps: { danger: true },
      onOk: () => cancelOrder(order),
    })
  }

  const toggleLock = async (order: Order) => {
    try {
      await api.post(`/orders/${order.id}/${order.isLocked ? 'unlock' : 'lock'}`)
      message.success(order.isLocked ? '订单已解锁' : '订单已锁定')
      await load()
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  const exportOrders = async () => {
    try {
      const response = await api.get('/orders/export', { responseType: 'blob', params: { search: filters.search, status: filters.status, staffId: filters.staffId, from: filters.range?.[0]?.startOf('day').toISOString(), to: filters.range?.[1]?.endOf('day').toISOString() } })
      const url = URL.createObjectURL(response.data as Blob)
      const link = document.createElement('a')
      link.href = url
      link.download = '俱乐部运营订单列表.xlsx'
      link.click()
      URL.revokeObjectURL(url)
      message.success('订单表格已导出')
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  const columns = [
    { title: '订单号', dataIndex: 'orderNo', fixed: 'left' as const, width: 132, render: (value: string, order: Order) => <Button type="link" className="order-link" onClick={() => setViewing(order)}>{value}</Button> },
    { title: '客户', dataIndex: ['customer', 'customerCode'], width: 118, render: (value: string, order: Order) => <div><strong>{value}</strong><div className="table-secondary">组队码 {order.customer.teamCode}</div></div> },
    { title: '服务套餐', dataIndex: 'serviceItem', width: 128, ellipsis: true },
    { title: '订单金额', dataIndex: 'amountCents', width: 92, render: (value: number, order: Order) => <strong>{formatMoney(order.currentNetAmountCents ?? value)}</strong> },
    { title: <span>员工金额 <Tooltip title="待处理、进行中与待审核仅为预计；审核通过后计入实际应得"><InfoCircleOutlined /></Tooltip></span>, dataIndex: 'staffAmountCents', width: 112, render: (value: number, order: Order) => <div className="staff-amount-cell"><strong>{formatMoney(order.status === 'COMPLETED' || order.status === 'AFTER_SALE' ? order.currentStaffEarningTotalCents ?? value : value)}</strong><span className={`amount-label ${order.status === 'COMPLETED' || order.status === 'AFTER_SALE' ? 'actual' : ''}`}>{getAdminStaffAmountLabel(order.status)}</span></div> },
    { title: '参与员工', key: 'staff', width: 146, render: (_: unknown, order: Order) => { const participants = participatingSlots(order); return <div className="order-participants"><span>{participants.map((slot) => slot.staff?.name).join('、') || '等待接单'}</span><small>{order.activeStaffCount}/{order.requiredStaffCount} 人</small></div> } },
    { title: '状态', dataIndex: 'status', width: 118, render: (_: OrderStatus, order: Order) => statusTag(order) },
    { title: '创建时间', dataIndex: 'createdAt', width: 112, render: (value: string) => formatDateTime(value) },
    { title: '操作', key: 'action', fixed: 'right' as const, width: 190, align: 'center' as const, render: (_: unknown, order: Order) => {
      const final = ['COMPLETED', 'CANCELLED', 'AFTER_SALE'].includes(order.status)
      return <Space className="order-action-buttons" size={2} wrap={false}>
        <Tooltip title="查看详情"><Button type="text" aria-label={`查看订单${order.orderNo}详情`} icon={<EyeOutlined />} onClick={() => setViewing(order)} /></Tooltip>
        <Tooltip title={final ? '当前订单不可编辑' : '编辑订单'}><Button style={canEdit ? undefined : { display: 'none' }} type="text" aria-label={`编辑订单${order.orderNo}`} icon={<EditOutlined />} disabled={final || order.status === 'PENDING_COMPLETION_REVIEW'} onClick={() => openEdit(order)} /></Tooltip>
        <Tooltip title={final ? '当前订单不可分配' : '分配协作员工'}><Button style={canAssign ? undefined : { display: 'none' }} type="text" aria-label={`分配订单${order.orderNo}`} icon={<SendOutlined />} disabled={final || order.status === 'PENDING_COMPLETION_REVIEW'} onClick={() => openAssign(order)} /></Tooltip>
        {canReview && order.status === 'PENDING_COMPLETION_REVIEW' && <Tooltip title="审核完单"><Button type="text" className="review-action" icon={<CheckCircleOutlined />} onClick={() => setViewing(order)} /></Tooltip>}
        <Tooltip title={order.isLocked ? '解锁订单' : '锁定订单'}><Button style={canLock ? undefined : { display: 'none' }} type="text" icon={order.isLocked ? <UnlockOutlined /> : <LockOutlined />} disabled={!order.isLocked && final} onClick={() => void toggleLock(order)} /></Tooltip>
        <Tooltip title={final ? '当前订单不可取消' : '取消订单'}><Popconfirm title="确定取消这笔订单吗？" onConfirm={() => cancelOrder(order)} disabled={final}><Button style={canCancel ? undefined : { display: 'none' }} type="text" danger disabled={final}>取消</Button></Popconfirm></Tooltip>
      </Space>
    } },
  ]

  if (hasError) return <RequestError onRetry={() => void load()} />

  const viewingSlots = viewing ? currentSlots(viewing) : []
  const totalRate = watchedSlots.reduce((sum: number, slot: CollaborationSlotForm) => sum + Number(slot?.commissionRatePercent ?? 0), 0)
  const mobileFilterCount = [filters.status, filters.staffId, filters.range?.length ? 'range' : undefined].filter(Boolean).length

  return (
    <div className="content-stack admin-orders-page">
      {hasUserPermission(user, 'dispatch.self') && <DispatchStatistics personal />}
      {reminderKind && <Alert type="info" showIcon title={reminderKind === 'exit' ? '当前仅显示待处理退出申请的订单' : '当前仅显示待完单审核的订单'} action={<Button size="small" onClick={() => setSearchParams({})}>查看全部订单</Button>} />}
      <section className="page-intro compact"><div><div className="eyebrow">订单现场 · 实时队列</div><h2>订单管理</h2><p>创建、协作派单、完单审核并跟进每一笔电竞服务订单。</p></div><Button style={canCreate ? undefined : { display: 'none' }} type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增订单</Button></section>
      <Card className="filter-card orders-desktop-filter" variant="borderless"><Form layout="inline" onFinish={(values: FilterValues) => setFilters(values)} initialValues={filters}><Form.Item name="search"><Input allowClear prefix={<FilterOutlined />} placeholder="搜索订单号或客户" /></Form.Item><Form.Item name="status"><Select allowClear placeholder="全部状态" style={{ width: 148 }} options={Object.entries(orderStatusMeta).map(([value, item]) => ({ value, label: item.label }))} /></Form.Item><Form.Item name="staffId"><Select allowClear placeholder="全部员工" style={{ width: 140 }} options={staffOptions.map((item) => ({ value: item.id, label: item.name }))} /></Form.Item><Form.Item name="range"><DatePicker.RangePicker /></Form.Item><Button htmlType="submit">查询</Button></Form></Card>
      <div className="orders-mobile-toolbar"><Input.Search allowClear value={mobileSearch} placeholder="搜索订单号或客户" onChange={(event) => { const value = event.target.value; setMobileSearch(value); if (!value) setFilters((current) => ({ ...current, search: undefined })) }} onSearch={(value) => setFilters((current) => ({ ...current, search: value.trim() || undefined }))} /><Button icon={<FilterOutlined />} onClick={openMobileFilters}>筛选{mobileFilterCount ? ` ${mobileFilterCount}` : ''}</Button></div>
      <Card className="table-card" variant="borderless">
        <div className="table-heading"><div><strong>订单列表</strong><span className="card-subtitle">共 {orders.length} 笔 · 协作人数实时更新</span></div><Space><Button type="text" icon={<DownloadOutlined />} onClick={() => void exportOrders()}>导出</Button><Button type="text" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button></Space></div>
        <div className="orders-desktop-table"><Table<Order> className="orders-table" rowKey="id" loading={loading} dataSource={orders} columns={columns} scroll={{ x: 1124 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 笔` }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的订单" /> }} /></div>
        <div className="admin-mobile-order-list">
          {loading
            ? <div className="page-loading"><Spin size="small" /></div>
            : orders.length === 0
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的订单" />
              : orders.map((order) => {
                  const final = ['COMPLETED', 'CANCELLED', 'AFTER_SALE'].includes(order.status)
                  const participants = participatingSlots(order)
                  const canManage = !final && order.status !== 'PENDING_COMPLETION_REVIEW'
                  const moreItems = [
                    ...(canLock && (order.isLocked || !final) ? [{ key: 'lock', label: order.isLocked ? '解锁订单' : '锁定订单' }] : []),
                    ...(canCancel && !final ? [{ key: 'cancel', label: '取消订单', danger: true }] : []),
                  ]
                  return <Card key={order.id} size="small" className={`admin-mobile-order-card ${order.status.toLowerCase()}`}>
                    <div className="admin-mobile-order-top"><Button type="link" className="order-link" onClick={() => setViewing(order)}>{order.orderNo}</Button>{statusTag(order)}</div>
                    <h3>{order.serviceItem}</h3>
                    <div className="admin-mobile-order-customer"><strong>{order.customer.customerCode}</strong><span>组队码 {order.customer.teamCode}</span></div>
                    <div className="admin-mobile-order-data">
                      <div><span>订单金额</span><strong>{formatMoney(order.currentNetAmountCents ?? order.amountCents)}</strong></div>
                      <div><span>{getAdminStaffAmountLabel(order.status)}</span><strong>{formatMoney(order.status === 'COMPLETED' || order.status === 'AFTER_SALE' ? order.currentStaffEarningTotalCents ?? order.staffAmountCents : order.staffAmountCents)}</strong></div>
                      <div><span>协作人数</span><strong>{order.activeStaffCount} / {order.requiredStaffCount}</strong></div>
                      <div><span>当前员工</span><strong>{participants.map((slot) => slot.staff?.name).join('、') || '等待接单'}</strong></div>
                    </div>
                    <div className="admin-mobile-order-time"><ClockCircleOutlined /> 创建于 {formatDateTime(order.createdAt)}</div>
                    <div className="admin-mobile-order-actions">
                      <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setViewing(order)}>查看详情</Button>
                      {canManage && canEdit && <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(order)}>编辑</Button>}
                      {canManage && canAssign && <Button type="primary" size="small" icon={<SendOutlined />} onClick={() => openAssign(order)}>派单 / 协作</Button>}
                      {order.status === 'PENDING_COMPLETION_REVIEW' && <Button type="primary" size="small" icon={<CheckCircleOutlined />} onClick={() => setViewing(order)}>完单审核</Button>}
                      {moreItems.length > 0 && <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: moreItems, onClick: ({ key }) => { if (key === 'lock') void toggleLock(order); if (key === 'cancel') confirmMobileCancel(order) } }}><Button type="text" size="small" icon={<MoreOutlined />} aria-label={`订单${order.orderNo}更多操作`} /></Dropdown>}
                    </div>
                  </Card>
                })}
        </div>
      </Card>

      <Drawer rootClassName="admin-orders-filter-drawer" title="筛选订单" placement="bottom" size={430} open={mobileFiltersOpen} onClose={() => setMobileFiltersOpen(false)} footer={<div className="admin-mobile-filter-actions"><Button onClick={resetMobileFilters}>重置</Button><Button type="primary" onClick={() => mobileFilterForm.submit()}>应用筛选</Button></div>} destroyOnHidden>
        <Form form={mobileFilterForm} layout="vertical" onFinish={applyMobileFilters}>
          <Form.Item name="status" label="订单状态"><Select allowClear placeholder="全部状态" options={Object.entries(orderStatusMeta).map(([value, item]) => ({ value, label: item.label }))} /></Form.Item>
          <Form.Item name="staffId" label="参与员工"><Select allowClear placeholder="全部员工" options={staffOptions.map((item) => ({ value: item.id, label: item.name }))} /></Form.Item>
          <Form.Item name="range" label="创建日期"><DatePicker.RangePicker style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Drawer>

      <Modal className="order-editor-modal" width={680} title={editing ? '编辑订单' : '新增订单'} open={modalOpen} forceRender onCancel={() => setModalOpen(false)} onOk={() => form.submit()} confirmLoading={saving} okText="保存订单" cancelText="返回" destroyOnHidden>
        <Form<OrderFormValues> form={form} layout="vertical" onFinish={saveOrder} preserve={false} onValuesChange={(changed, values) => {
          if (changed.requiredStaffCount !== undefined) syncSlots(values.requiredStaffCount)
          if (changed.servicePackageId !== undefined || changed.requiredTierId !== undefined || changed.customerCouponId !== undefined) updateRecommendedPrice(values.servicePackageId, values.requiredTierId, values.customerCouponId)
        }}>
          {!editing && <Form.Item name="customerMode" label="客户来源"><Radio.Group optionType="button" buttonStyle="solid" options={[{ value: 'EXISTING', label: '选择已有客户' }, { value: 'NEW', disabled: !canCreateCustomer, label: '直接录入新客户' }]} /></Form.Item>}
          {customerMode === 'NEW' && !editing ? <>
            <div className="form-grid-two"><Form.Item name="newCustomerCode" label="客户ID" validateTrigger="onBlur" rules={[{ required: true, message: '请输入客户ID' }, { validator: async (_, value?: string) => { const duplicate = customers.find((customer) => customer.customerCode.trim() === value?.trim()); if (duplicate) throw new Error(`该客户ID已存在：${duplicate.customerCode}，请改为选择已有客户`) } }]}><Input maxLength={128} /></Form.Item><Form.Item name="newCustomerTeamCode" label="客户组队码" rules={[{ required: true, message: '请输入客户组队码' }]}><Input maxLength={128} /></Form.Item></div>
            <Form.Item name="newCustomerNote" label="客户备注"><Input.TextArea rows={2} maxLength={2000} /></Form.Item>
          </> : <Form.Item name="customerId" label="客户" rules={[{ required: true, message: '请选择客户' }]}><Select showSearch optionFilterProp="label" placeholder="输入客户ID或组队码搜索" filterOption={canReadCustomers} onSearch={(value) => void searchCustomers(value)} onChange={(value) => { form.setFieldValue('customerCouponId', undefined); if (value) void loadCustomerCoupons(value) }} options={customers.map((customer) => ({ value: customer.id, label: `${customer.customerCode} · 组队码 ${customer.teamCode}` }))} /></Form.Item>}
          <Form.Item name="servicePackageId" label="服务套餐" rules={[{ required: true, message: '请选择服务套餐' }]}><Select showSearch optionFilterProp="label" placeholder="选择后台已启用套餐" options={packages.filter((item) => item.isEnabled).map((item) => ({ value: item.id, label: `${item.name}${item.category ? ` · ${item.category}` : ''}` }))} /></Form.Item>
          {selectedPackage?.description && <Alert type="info" showIcon title={selectedPackage.description} />}
          <div className="form-grid-two"><Form.Item name="requiredTierId" label="服务档位" rules={[{ required: true, message: '请选择服务档位' }]}><Select options={[{ value: UNRESTRICTED_TIER, label: '不限层级' }, ...tiers.filter((item) => item.isEnabled).map((item) => ({ value: item.id, label: `${item.name} · ${item.priceMultiplierBps / 100}%` }))]} /></Form.Item><Form.Item name="amountYuan" label="订单金额（元）" rules={[{ required: true, message: '请输入订单金额' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></div>
          {canReadCustomers && customerMode === 'EXISTING' && <Form.Item name="customerCouponId" label="使用优惠券"><Select allowClear disabled={!customerCoupons.length} placeholder={customerCoupons.length ? '可选客户优惠券' : '该客户暂无可用优惠券'} options={customerCoupons.map((item) => ({ value: item.id, label: `${item.coupon.name} · 减 ${formatMoney(item.coupon.amountCents)}` }))} /></Form.Item>}
          <Form.Item name="requiredStaffCount" label="需要协作人数" rules={[{ required: true }]} extra={editing && editing.activeStaffCount > 0 ? '已有员工参与时不能直接修改人数，可调整各名额提成。' : '人数达到要求后订单才进入待处理。'}><InputNumber min={1} max={20} precision={0} disabled={Boolean(editing?.activeStaffCount)} style={{ width: '100%' }} /></Form.Item>
          <div className="collaboration-slot-editor"><div className="slot-editor-heading"><strong>本单协作提成</strong><span>合计不得超过 100%</span></div><Form.List name="slots">{(fields) => fields.map((field, index) => {
            const { key, ...fieldProps } = field
            return <div className="collaboration-slot-row" key={key}><span>名额 {index + 1}</span><Form.Item {...fieldProps} name={[field.name, 'slotIndex']} hidden><InputNumber /></Form.Item><Form.Item {...fieldProps} name={[field.name, 'commissionRatePercent']} rules={[{ required: true, message: '请输入提成比例' }]} noStyle><InputNumber min={0} max={100} precision={2} suffix="%" /></Form.Item></div>
          })}</Form.List><div className={`slot-rate-total ${totalRate > 100 ? 'error' : ''}`}>当前合计：{totalRate.toFixed(2)}%</div></div>
          {canAssign && !editing && <Form.Item name="preassignedStaffIds" label="预先分配员工（可选）" dependencies={['requiredStaffCount']} rules={[({ getFieldValue }) => ({ validator: async (_, ids: string[] = []) => { if (ids.length > getFieldValue('requiredStaffCount')) throw new Error('已选人数超过需要协作人数，请移除多余员工后保存') } })]} extra="可提前安排部分或全部员工，未分配的剩余名额会继续进入接单池。按选择顺序对应名额 1、名额 2 等及其提成。"><Select mode="multiple" maxCount={requiredStaffCount} allowClear showSearch optionFilterProp="label" placeholder="可留空，按名额顺序选择员工" options={staffOptions.map((staff) => ({ value: staff.id, label: staff.name }))} /></Form.Item>}
          {canRecharge && !editing && <div className="form-grid-two"><Form.Item name="rechargeYuan" label="本次充值（元）" extra="默认 0；与订单在同一事务保存"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item><Form.Item name="rechargeNote" label="充值备注"><Input maxLength={2000} placeholder="可选" /></Form.Item></div>}
          <Form.Item name="note" label="订单备注"><Input.TextArea rows={3} maxLength={2000} placeholder="填写服务要求或内部备注" /></Form.Item>
        </Form>
      </Modal>

      <Modal title="分配协作名额" open={Boolean(assigning)} forceRender onCancel={() => setAssigning(null)} onOk={() => void assignOrder()} okText="确认分配" cancelText="返回"><p className="modal-hint">为 <strong>{assigning?.orderNo}</strong> 选择名额和员工。服务开始前可替换占用名额；开始后只能补充空缺名额。</p><Form form={assignForm} layout="vertical"><Form.Item name="slotIndex" label="协作名额" rules={[{ required: true, message: '请选择名额' }]}><Select options={(assigning ? currentSlots(assigning) : []).map((slot) => ({ value: slot.slotIndex, label: `名额 ${slot.slotIndex} · ${slot.commissionRateBps / 100}% · ${slot.staff?.name ?? '空缺'}`, disabled: Boolean(assigning?.startedAt && slot.staff) }))} /></Form.Item><Form.Item name="staffId" label="员工" rules={[{ required: true, message: '请选择员工' }]}><Select placeholder="选择员工" options={staffOptions.map((staff) => ({ value: staff.id, label: <span className="staff-option"><span>{staff.name}</span><Tag color={staffStatusMeta[staff.status].color}>{staffStatusMeta[staff.status].label}</Tag><small>{staff.currentInProgressCount} 个进行中</small></span> }))} /></Form.Item></Form></Modal>

      <Modal zIndex={1100} title="调整协作提成" open={Boolean(editingRates)} forceRender onCancel={() => setEditingRates(null)} onOk={() => void saveRates()} okText="保存提成" cancelText="返回"><Alert type="info" showIcon title={editingRates?.startedAt ? '订单已开始，本次调整会写入操作日志。' : '订单开始前可直接调整；比例合计不得超过 100%。'} /><Form form={ratesForm} layout="vertical"><Form.List name="slots">{(fields) => fields.map((field, index) => {
        const { key, ...fieldProps } = field
        return <div className="collaboration-slot-row modal-slot-row" key={key}><span>名额 {index + 1}</span><Form.Item {...fieldProps} name={[field.name, 'slotIndex']} hidden><InputNumber /></Form.Item><Form.Item {...fieldProps} name={[field.name, 'commissionRatePercent']} rules={[{ required: true }]} noStyle><InputNumber min={0} max={100} precision={2} suffix="%" /></Form.Item></div>
      })}</Form.List></Form></Modal>

      <Modal afterOpenChange={(open) => { if (open && searchParams.has('reminder')) document.getElementById(searchParams.get('reminder') === 'exit' ? `reminder-assignment-${searchParams.get('assignmentId')}` : 'reminder-completion-review')?.scrollIntoView({ block: 'center' }) }} className="admin-order-detail-modal" width={760} title="订单详情" open={Boolean(viewing)} footer={null} onCancel={() => setViewing(null)}>
        {viewing && <div className="order-detail-content">
          {user?.role === 'SUPER_ADMIN' && <div><DeleteOrderButton orderId={viewing.id} orderNo={viewing.orderNo} onDeleted={() => { setViewing(null); setSearchParams(previous => { const next = new URLSearchParams(previous); next.delete('orderId'); return next }, { replace: true }); void load() }} /></div>}
          {viewing.completionReviewReason && <Alert type="warning" showIcon title="完单审核已退回" description={viewing.completionReviewReason} />}
          <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small" items={[{ key: 'orderNo', label: '订单号', children: viewing.orderNo }, { key: 'status', label: '当前状态', children: statusTag(viewing) }, { key: 'customerCode', label: '客户ID', children: viewing.customer.customerCode }, { key: 'teamCode', label: '客户组队码', children: viewing.customer.teamCode }, { key: 'service', label: '服务套餐', children: <span>{viewing.serviceItem}{viewing.servicePackage?.category ? ` · ${viewing.servicePackage.category}` : ''}</span> }, { key: 'amount', label: viewing.adjustments?.length ? '当前净订单金额' : '订单金额', children: formatMoney(viewing.currentNetAmountCents ?? viewing.amountCents) }, { key: 'staffAmount', label: getAdminStaffAmountLabel(viewing.status), children: formatMoney(viewing.status === 'COMPLETED' || viewing.status === 'AFTER_SALE' ? viewing.currentStaffEarningTotalCents ?? viewing.staffAmountCents : viewing.staffAmountCents) }, { key: 'tier', label: '服务档位', children: viewing.requiredTier?.name ?? '不限层级' }, { key: 'team', label: '协作进度', children: `${viewing.activeStaffCount}/${viewing.requiredStaffCount} 人` }, { key: 'proof', label: '完单提交', children: `${viewing.completionSubmittedCount}/${viewing.completionRequiredCount || viewing.requiredStaffCount} 人` }, { key: 'createdAt', label: '创建时间', children: formatDateTime(viewing.createdAt) }, { key: 'completedAt', label: '完成时间', children: formatDateTime(viewing.completedAt) }, { key: 'note', label: '备注', span: { xs: 1, sm: 2 }, children: viewing.note || '—' }]} />
          {canEdit && ['COMPLETED', 'AFTER_SALE'].includes(viewing.status) && <div className="detail-section-heading"><div><EditOutlined /><strong>完单后净额调整</strong></div><Tooltip title={canAdjustOrderNet(viewing) ? undefined : unsettledAdjustmentMessage}><Button type="primary" disabled={!canAdjustOrderNet(viewing)} onClick={() => openAdjustment(viewing)}>登记调整</Button></Tooltip></div>}
          {['COMPLETED', 'AFTER_SALE'].includes(viewing.status) && !canAdjustOrderNet(viewing) && <Alert type="info" showIcon title={unsettledAdjustmentMessage} />}
          {viewing.adjustments?.length ? <div className="drawer-record-list">{viewing.adjustments.map((item) => <div className="drawer-record-item" key={item.id}><div className="drawer-record-title">{item.reason} · {formatMoney(item.orderAmountBeforeCents)} → {formatMoney(item.orderAmountAfterCents)}</div><div className="drawer-record-description">{formatDateTime(item.createdAt)} · 操作人 {item.operator?.username || '系统'}{item.afterSale?.caseNo ? ` · 售后 ${item.afterSale.caseNo}` : ''}</div><div className="drawer-record-description">{item.staffAdjustments.map((staffItem) => `${staffItem.staff.name} ${formatMoney(staffItem.earningBeforeCents)} → ${formatMoney(staffItem.earningAfterCents)}`).join('；')}</div></div>)}</div> : null}
          <div className="detail-section-heading"><div><TeamOutlined /><strong>协作员工与完单凭证</strong></div><Button style={canEdit ? undefined : { display: 'none' }} type="link" onClick={() => { setEditingRates(viewing); ratesForm.setFieldsValue({ slots: viewingSlots.map((slot) => ({ slotIndex: slot.slotIndex, commissionRatePercent: slot.commissionRateBps / 100 })) }) }}>调整提成</Button></div>
          {viewing.afterSaleCase && <AfterSaleMessages messages={viewing.afterSaleCase.messages} />}
          <div className="assignment-detail-list">{viewingSlots.map((slot) => <Card id={`reminder-assignment-${slot.id}`} key={slot.id ?? slot.slotIndex} size="small" className="assignment-detail-card"><div className="assignment-detail-head"><div><strong>名额 {slot.slotIndex} · {slot.staff?.name ?? '等待接单'}</strong><span>{slot.commissionRateBps / 100}% · 预计 {formatMoney(slot.expectedEarningCents)}{slot.assignmentStatus === 'COMPLETED' ? ` · 原始实际 ${formatMoney(slot.actualEarningCents ?? 0)} · 调整 ${formatMoney((slot.currentNetEarningCents ?? slot.actualEarningCents ?? 0) - (slot.actualEarningCents ?? 0))} · 当前实际 ${formatMoney(slot.currentNetEarningCents ?? slot.actualEarningCents ?? 0)}` : ''}</span></div><Tag color={slot.completionReviewStatus === 'APPROVED' ? 'success' : slot.completionReviewStatus === 'SUBMITTED' ? 'blue' : slot.completionReviewStatus === 'REJECTED' ? 'error' : 'default'}>{slot.completionReviewStatus === 'APPROVED' ? '审核通过' : slot.completionReviewStatus === 'SUBMITTED' ? '已提交凭证' : slot.completionReviewStatus === 'REJECTED' ? '已退回' : slot.staff ? '待提交' : '名额空缺'}</Tag></div>{canAssign && slot.exitReviewStatus === 'PENDING' && <Alert type="warning" showIcon title={`${slot.staff?.name ?? '员工'}申请退出`} description={<Space orientation="vertical" size={6}><span>{slot.exitReason}</span><Space><Button size="small" type="primary" onClick={() => void reviewExit(viewing, slot.id!, true)}>同意退出</Button><Button size="small" onClick={() => void reviewExit(viewing, slot.id!, false)}>拒绝</Button></Space></Space>} />}{slot.completionReviewReason && <div className="assignment-review-reason">退回原因：{slot.completionReviewReason}</div>}{slot.completionProofs?.length ? <div className="completion-proof-block"><p>{slot.completionProofs.at(-1)?.note || '未填写完单说明'}</p><div className="completion-proof-gallery">{slot.completionProofs.map((proof) => <ProofImage key={proof.id} proof={proof} />)}</div><small>提交时间：{formatDateTime(slot.completionSubmittedAt)}</small></div> : slot.staff && <div className="drawer-empty">尚未提交完单凭证</div>}</Card>)}</div>
          {canReview && viewing.status === 'PENDING_COMPLETION_REVIEW' && <div id="reminder-completion-review" className="completion-review-actions"><Alert type="info" showIcon title="所有参与员工均已提交，等待后台审核" description="审核通过后才会扣除客户余额、确认员工实际应得并计入财务。" /><Space><Button danger icon={<CloseCircleOutlined />} onClick={() => setRejecting(viewing)}>审核退回</Button><Popconfirm title="确认审核通过并正式结算？" description="将扣除客户余额并确认所有参与员工的实际应得。" onConfirm={() => void reviewCompletion(viewing, true)}><Button type="primary" icon={<CheckCircleOutlined />}>审核通过</Button></Popconfirm></Space></div>}
        </div>}
      </Modal>

      <Modal title="退回完单申请" open={Boolean(rejecting)} onCancel={() => { setRejecting(null); setRejectReason('') }} onOk={() => rejecting && void reviewCompletion(rejecting, false, rejectReason)} okText="确认退回" okButtonProps={{ danger: true, disabled: !rejectReason.trim() }} cancelText="返回"><Form layout="vertical"><Form.Item label="退回原因" required><Input.TextArea rows={4} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} maxLength={2000} placeholder="请说明需重新提交的原因" /></Form.Item></Form></Modal>
      <Modal width={620} title="登记完单后净额调整" confirmLoading={adjustmentSaving} open={Boolean(adjustingOrder)} onCancel={() => setAdjustingOrder(null)} onOk={() => adjustmentForm.submit()} okText="确认登记" cancelText="返回" destroyOnHidden><Alert type="warning" showIcon title="本操作保留原完单记录，仅以差额更新客户账户、员工应得与财务统计。" /><Form<OrderAdjustmentForm> form={adjustmentForm} layout="vertical" onFinish={saveAdjustment} preserve={false}><Form.Item name="netAmount" label="调整后订单净额（元）" rules={[{ required: true, message: '请输入调整后订单净额' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item><Form.List name="staffNetEarnings">{(fields) => fields.map((field, index) => { const assignment = adjustingOrder?.assignments.filter((item) => item.assignmentStatus === 'COMPLETED')[index]; return <div className="form-grid-two" key={field.key}><Form.Item {...field} name={[field.name, 'assignmentId']} hidden><Input /></Form.Item><Form.Item label={`${assignment?.staff?.name ?? `员工${index + 1}`} 调整后实际应得（元）`} name={[field.name, 'amount']} rules={[{ required: true, message: '请输入调整后应得' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></div> })}</Form.List><Form.Item name="reason" label="调整原因" rules={[{ required: true, message: '请输入调整原因' }]}><Input maxLength={255} /></Form.Item><Form.Item name="handlingNote" label="处理说明"><Input.TextArea rows={3} maxLength={4000} /></Form.Item></Form></Modal>
    </div>
  )
}

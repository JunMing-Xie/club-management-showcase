import { useState } from 'react'
import { Alert, App, Button, Input, Modal, Space } from 'antd'
import { api, getErrorMessage } from '../api'

export function DeleteOrderButton({ orderId, orderNo, onDeleted }: { orderId: string; orderNo: string; onDeleted: () => void }) {
  const { message } = App.useApp()
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const remove = async () => {
    if (confirmation !== orderNo || pending) return
    setPending(true)
    try {
      const response = await api.delete<{ cleanupPending: boolean }>(`/orders/${orderId}`, { data: { orderNo: confirmation } })
      message.success('订单已删除，关联账务已回退')
      if (response.data.cleanupPending) message.warning('部分附件清理待维护人员处理，账务回退已完成')
      setOpen(false); setConfirmation(''); onDeleted()
    } catch (error) { message.error(getErrorMessage(error)) } finally { setPending(false) }
  }
  return <>
    <Button danger onClick={() => { setConfirmation(''); setOpen(true) }}>删除订单</Button>
    <Modal title="确认删除订单" open={open} width={480} zIndex={1200} confirmLoading={pending} closable={!pending} mask={{ closable: false }} keyboard={!pending} onCancel={() => { if (!pending) setOpen(false) }} onOk={() => void remove()} okText="确认删除并回退账务" cancelText="取消" okButtonProps={{ danger: true, disabled: confirmation !== orderNo }} cancelButtonProps={{ disabled: pending }}>
      <Space orientation="vertical" style={{ width: '100%' }}>
        <Alert type="error" showIcon title="删除后将同步回退该订单产生的客户扣款、员工收益及相关财务记录，此操作不可撤销。" />
        <p>订单号：<strong>{orderNo}</strong></p>
        <label htmlFor="delete-order-confirmation">请输入完整订单号确认</label>
        <Input id="delete-order-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={pending} autoComplete="off" />
      </Space>
    </Modal>
  </>
}

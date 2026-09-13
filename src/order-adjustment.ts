import type { Order } from './types'

export const unsettledAdjustmentMessage = '该订单尚未完成最终审核和结算，暂不能进行售后金额调整。'

export const canAdjustOrderNet = (order: Pick<Order, 'status' | 'hasOriginalSettlement' | 'completedAt' | 'completionReviewStatus'>) =>
  ['COMPLETED', 'AFTER_SALE'].includes(order.status) && Boolean(order.completedAt) && order.completionReviewStatus === 'APPROVED' && order.hasOriginalSettlement === true

export const unsettledAfterSaleMessage = '该订单尚未完成最终审核，请先通过完单审核流程处理；正式结算后发生的问题再进入售后。'
export const canCreateAfterSale = (order: Order) => canAdjustOrderNet(order) && !order.afterSaleCase

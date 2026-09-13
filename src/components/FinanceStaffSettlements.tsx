import { Card, Collapse, Empty, Table, Tag } from 'antd'
import { formatDateTime, formatMoney } from '../helpers'

export type StaffSettlementRow = {
  staffId: string; name: string; username: string; orderCount: number; participationAmountCents: number
  openingNetCents: number; openingPendingCents: number; openingOffsetCents: number
  normalEarningCents: number; adjustmentCents: number; periodNetEarningCents: number; periodSettledCents: number
  cumulativeEarningCents: number; cumulativeSettledCents: number
  closingNetCents: number; pendingCents: number; offsetCents: number; lastSettlementAt: string | null
}
export type StaffSettlementReport = {
  range: { startDate: string; endDate: string; timeZone: string }
  summary: { participationAmountCents: number; netEarningCents: number; settledCents: number; pendingCents: number; offsetCents: number }
  items: StaffSettlementRow[]
}
const Remaining = ({ item }: { item: StaffSettlementRow }) => item.offsetCents > 0
  ? <Tag color="warning">待冲抵 {formatMoney(item.offsetCents)}</Tag>
  : item.pendingCents === 0 ? <Tag color="success">已结清</Tag> : <strong>{formatMoney(item.pendingCents)}</strong>

const Rolling = ({ item }: { item: StaffSettlementRow }) => (
  <div className="finance-staff-rolling" aria-label={`${item.name}结算滚动明细`}>
    <div className="finance-staff-amount-grid">
      {[
        ['期初待结算', item.openingPendingCents], ['期初待冲抵', item.openingOffsetCents],
        ['本期正常收益', item.normalEarningCents], ['本期收益调整', item.adjustmentCents],
        ['本期实际结算', item.periodSettledCents], ['期末待结算', item.pendingCents],
        ['期末待冲抵', item.offsetCents], ['截至期末累计净应得', item.cumulativeEarningCents],
        ['截至期末累计已结算', item.cumulativeSettledCents],
      ].map(([label, amount]) => <div key={label}><span>{label}</span><strong>{formatMoney(Number(amount))}</strong></div>)}
    </div>
    <p>期初待结算 − 期初待冲抵 + 本期正常收益 + 本期收益调整 − 本期实际结算 = 期末净余额。负余额列为待冲抵。</p>
    <p>本期参与 {item.orderCount} 单 · 参与订单金额 {formatMoney(item.participationAmountCents)} · 截至期末最近结算：{item.lastSettlementAt ? formatDateTime(item.lastSettlementAt) : '暂无'}</p>
  </div>
)

export const FinanceStaffSettlements = ({ report }: { report: StaffSettlementReport }) => (
  <Card className="table-card finance-staff-panel" variant="borderless">
    <div className="table-heading"><div><strong>员工结算明细</strong><span className="card-subtitle">按员工核对工资，展开查看期初、本期和期末余额</span></div></div>
    <div className="finance-staff-desktop">
      <Table<StaffSettlementRow> rowKey="staffId" dataSource={report.items} pagination={{ pageSize: 8 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无员工" /> }}
        expandable={{ expandedRowRender: item => <Rolling item={item} />, columnTitle: '明细' }}
        columns={[
          { title: '员工 / 本期参与', render: (_: unknown, item) => <div><strong>{item.name} · {item.username}</strong><div className="table-secondary">{item.orderCount} 单 · {formatMoney(item.participationAmountCents)}</div></div> },
          { title: '本期净应结算', dataIndex: 'periodNetEarningCents', render: formatMoney },
          { title: '本期已结算', dataIndex: 'periodSettledCents', render: formatMoney },
          { title: '期末待结算 / 待冲抵', render: (_: unknown, item) => <Remaining item={item} /> },
        ]} />
    </div>
    <div className="finance-staff-mobile">
      <Collapse items={report.items.map(item => ({ key: item.staffId, label: <div className="finance-staff-mobile-label"><strong>{item.name} · {item.username}</strong><span>{item.orderCount} 单 · 参与 {formatMoney(item.participationAmountCents)}</span><span>净应得 {formatMoney(item.periodNetEarningCents)} · 已结算 {formatMoney(item.periodSettledCents)}</span><Remaining item={item} /></div>, children: <Rolling item={item} /> }))} />
    </div>
  </Card>
)

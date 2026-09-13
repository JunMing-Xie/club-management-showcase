import { Empty, Tag } from 'antd'
import { formatDateTime } from '../helpers'

export type AfterSaleMessage = {
  id: string
  content: string
  createdAt: string
  author: { username: string; role: string; staffProfile?: { name: string } | null }
}

export const AfterSaleMessages = ({ messages }: { messages: AfterSaleMessage[] }) => (
  <section className="workbench-aftersale-messages" aria-label="跟进记录">
    <h3>跟进记录 · {messages.length} 条</h3>
    {messages.length ? messages.map((item) => <div className="workbench-aftersale-message" key={item.id}>
      <div><strong>{item.author.staffProfile?.name ? `${item.author.staffProfile.name} · ` : ''}{item.author.username}</strong> <Tag>{item.author.role === 'STAFF' ? '员工' : '管理员'}</Tag></div>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.content}</p>
      <small>{formatDateTime(item.createdAt)}</small>
    </div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无跟进记录" />}
  </section>
)

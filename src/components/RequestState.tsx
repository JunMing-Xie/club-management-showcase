import { ReloadOutlined } from '@ant-design/icons'
import { Button, Result } from 'antd'

type RequestErrorProps = {
  onRetry: () => void
}

export const RequestError = ({ onRetry }: RequestErrorProps) => (
  <div className="request-error" role="alert" aria-live="polite">
    <Result
      status="error"
      title="页面加载失败"
      subTitle="数据暂时无法加载，请检查网络连接后重试。"
      extra={<Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>重新加载</Button>}
    />
  </div>
)

import { LockOutlined, RightOutlined, UserOutlined } from '@ant-design/icons'
import { App, Button, Form, Input } from 'antd'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getErrorMessage } from '../api'
import { useAuth } from '../auth-context'
import { brandConfig } from '../brand'
import { IcpFooter } from '../components/IcpFooter'

type LoginValues = { username: string; password: string }

export const LoginPage = ({ role }: { role: 'ADMIN' | 'STAFF' }) => {
  const { login } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)
  const isAdmin = role === 'ADMIN'

  useEffect(() => {
    document.title = `${brandConfig.systemTitle} - ${isAdmin ? brandConfig.adminLabel : brandConfig.workbenchLabel}`
  }, [isAdmin])

  const submit = async (values: LoginValues) => {
    setSubmitting(true)
    try {
      await login(values.username, values.password, role)
      message.success('登录成功')
      navigate(isAdmin ? '/admin/dashboard' : '/workbench', { replace: true })
    } catch (error) {
      message.error(getErrorMessage(error, '账号或密码错误'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={`login-page ${isAdmin ? 'admin-login' : 'staff-login'}`}>
      <div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" />
      <div className="login-panel">
        <div className="login-aside">
          <div className="brand-lockup light"><img className="brand-logo login-logo" src={brandConfig.logoUrl} alt="俱乐部运营 Logo" /><div><div className="brand-name">{brandConfig.name}</div><div className="brand-caption">{isAdmin ? brandConfig.adminLabel : brandConfig.workbenchLabel}</div></div></div>
          <div className="login-aside-copy"><div className="eyebrow">{isAdmin ? brandConfig.adminLabel : brandConfig.workbenchLabel}</div><h1>{isAdmin ? '把每一单，交给清晰的流程。' : <>今天的工单，<br />从这里开始。</>}</h1><p>{isAdmin ? '订单、员工、客户与经营数字，集中在一张实时工作台。' : '接收分配、更新进度，完成每一项服务。'}</p></div>
          <div className="login-aside-foot"><span className="live-dot" />实时数据联动</div>
        </div>
        <div className="login-form-wrap">
          <div className="login-form-heading"><div className="eyebrow">安全登录</div><h2>{isAdmin ? '管理员登录' : '员工登录'}</h2><p>使用已开通的账号进入{isAdmin ? brandConfig.adminLabel : brandConfig.workbenchLabel}</p></div>
          <Form<LoginValues> layout="vertical" size="large" onFinish={submit} requiredMark={false}>
            <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}><Input prefix={<UserOutlined />} placeholder="请输入登录账号" autoComplete="username" /></Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}><Input.Password prefix={<LockOutlined />} placeholder="请输入登录密码" autoComplete="current-password" /></Form.Item>
            <Button type="primary" htmlType="submit" block loading={submitting} icon={<RightOutlined />} iconPlacement="end">进入{isAdmin ? '管理后台' : '工作台'}</Button>
          </Form>
          <button type="button" className="login-switch" onClick={() => navigate(isAdmin ? '/workbench/login' : '/admin/login')}>{isAdmin ? `我是员工，进入${brandConfig.workbenchLabel}` : `我是管理员，进入${brandConfig.adminLabel}`}</button>
        </div>
      </div>
      <IcpFooter />
    </div>
  )
}

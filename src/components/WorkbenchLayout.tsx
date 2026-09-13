import { BarChartOutlined, HomeOutlined, LogoutOutlined, UnorderedListOutlined, WarningOutlined } from '@ant-design/icons'
import { Alert, App, Button, Select, Tag } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import { useAuth } from '../auth-context'
import { useRealtimeRefresh } from '../realtime'
import { staffSelfAcceptingMeta, staffStatusMeta, type StaffAccepting, type StaffStatus } from '../types'
import { brandConfig } from '../brand'
import { IcpFooter } from './IcpFooter'
import { WorkbenchAccountSecurity } from './WorkbenchAccountSecurity'

export const WorkbenchLayout = () => {
  const { user, logout } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [status, setStatus] = useState<StaffStatus>(user?.staffProfile?.status ?? 'IDLE')
  const [accepting, setAccepting] = useState<StaffAccepting>(user?.staffProfile?.accepting ?? 'ACCEPTING')
  const [selfAccepting, setSelfAccepting] = useState<StaffAccepting>(user?.staffProfile?.selfAccepting ?? 'ACCEPTING')
  const meta = staffStatusMeta[status]

  useEffect(() => {
    document.title = `${brandConfig.systemTitle} - ${brandConfig.workbenchLabel}`
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const { data } = await api.get<{ profile: { status: StaffStatus; accepting: StaffAccepting; selfAccepting: StaffAccepting } }>('/workbench/summary')
      setStatus(data.profile.status)
      setAccepting(data.profile.accepting)
      setSelfAccepting(data.profile.selfAccepting)
    } catch {
      // 页面主体会展示请求错误；顶部状态保留最近一次成功值，避免遮挡主要操作。
    }
  }, [])

  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useRealtimeRefresh(refreshStatus)

  const updateStatus = async (nextStatus: StaffStatus) => {
    try {
      await api.patch('/staff/me/status', { status: nextStatus })
      setStatus(nextStatus)
      message.success(`状态已更新为${staffStatusMeta[nextStatus].label}`)
    } catch (error) {
      message.error(getErrorMessage(error))
    }
  }

  const updateAccepting = async (next: StaffAccepting) => {
    try {
      await api.patch('/staff/me/accepting', { accepting: next })
      setSelfAccepting(next)
      message.success(next === 'ACCEPTING' ? '已设为可接单' : '已设为暂时不接单')
    } catch (error) {
      message.error(getErrorMessage(error))
    }
  }
  const signOut = () => {
    void api.patch('/staff/me/presence', { presence: 'OFFLINE' }).finally(logout)
  }

  const navItems = [
    { path: '/workbench', label: brandConfig.workbenchLabel, icon: <HomeOutlined /> },
    { path: '/workbench/orders', label: '我的订单', icon: <UnorderedListOutlined /> },
    { path: '/workbench/after-sales', label: '我的售后', icon: <WarningOutlined /> },
    { path: '/workbench/stats', label: '我的统计', icon: <BarChartOutlined /> },
  ]

  return (
    <div className="workbench-page">
      <header className="workbench-header">
        <div className="workbench-brand"><img className="brand-logo small" src={brandConfig.logoUrl} alt="俱乐部运营 Logo" /><div><div className="brand-name">{brandConfig.compactName}</div><div className="brand-caption">{brandConfig.workbenchLabel}</div></div></div>
        <div className="workbench-header-actions">
          <WorkbenchAccountSecurity />
          <Select aria-label="员工接单状态" size="small" value={selfAccepting} disabled={accepting === 'PAUSED'} onChange={updateAccepting} popupMatchSelectWidth={false} options={Object.entries(staffSelfAcceptingMeta).map(([value, label]) => ({ value, label }))} />
          <Select size="small" value={status} onChange={updateStatus} popupMatchSelectWidth={false} options={Object.entries(staffStatusMeta).map(([value, item]) => ({ value, label: item.label }))} suffixIcon={<span className={`status-pip ${status.toLowerCase()}`} />} />
          <Button type="text" icon={<LogoutOutlined />} onClick={signOut} aria-label="退出登录" />
        </div>
      </header>
      <main className="workbench-main">{accepting === 'PAUSED' && <Alert type="warning" showIcon title="管理员已暂停您的接单权限，如需恢复请联系管理员。" style={{ marginBottom: 16 }} />}<Outlet /></main>
      <IcpFooter />
      <nav className="workbench-nav" aria-label="员工工作台导航">
        {navItems.map((item) => <button key={item.path} type="button" className={location.pathname === item.path ? 'active' : ''} onClick={() => navigate(item.path)}>{item.icon}<span>{item.label}</span></button>)}
      </nav>
      <div className="workbench-status-line"><Tag color={meta.color} variant="filled"><span className="status-pip" />当前状态：{meta.label}</Tag><span>{user?.staffProfile?.name ?? user?.username}</span></div>
    </div>
  )
}

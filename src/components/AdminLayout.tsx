import { AppstoreOutlined, BarChartOutlined, CloudUploadOutlined, IdcardOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, UnorderedListOutlined, WalletOutlined, WarningOutlined, SettingOutlined } from '@ant-design/icons'
import { Avatar, Button, Layout, Menu, Space, Tag, Typography, Result } from 'antd'
import { useEffect } from 'react'
import { useLocation, useNavigate, Outlet, Navigate } from 'react-router-dom'
import { useAuth } from '../auth-context'
import { brandConfig } from '../brand'
import { adminLandingPath, canViewAdminSection, roleMeta } from '../types'
import { AdminReminderBell, AdminRemindersProvider } from './AdminReminders'
import { IcpFooter } from './IcpFooter'

const { Header, Sider, Content } = Layout

const menuItems = [
  { key: 'dashboard', icon: <AppstoreOutlined />, label: '经营概览' },
  { key: 'orders', icon: <UnorderedListOutlined />, label: '订单管理' },
  { key: 'staff', icon: <TeamOutlined />, label: '员工管理' },
  { key: 'customers', icon: <IdcardOutlined />, label: '客户管理' },
  { key: 'stats', icon: <BarChartOutlined />, label: '经营统计' },
  { key: 'finance', icon: <WalletOutlined />, label: '财务中心' },
  { key: 'after-sales', icon: <WarningOutlined />, label: '售后管理' },
  { key: 'config', icon: <SettingOutlined />, label: '业务配置' },
  { key: 'permissions', icon: <SafetyCertificateOutlined />, label: '账号权限' },
  { key: 'imports', icon: <CloudUploadOutlined />, label: '批量导入' },
]

const AdminLayoutContent = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const currentKey = location.pathname.split('/')[2] || 'dashboard'
  const visibleMenuItems = menuItems.filter((item) => canViewAdminSection(user, item.key))

  useEffect(() => {
    document.title = `${brandConfig.systemTitle} - ${brandConfig.adminLabel}`
  }, [])

  if (currentKey === 'dashboard' && !canViewAdminSection(user, 'dashboard') && visibleMenuItems.length) return <Navigate to={adminLandingPath(user)} replace />

  return (
    <Layout className="admin-shell">
      <Sider breakpoint="lg" collapsedWidth="0" width={236} className="admin-sider">
        <div className="brand-lockup">
          <img className="brand-logo" src={brandConfig.logoUrl} alt="俱乐部运营 Logo" />
          <div>
            <div className="brand-name">{brandConfig.name}</div>
            <div className="brand-caption">{brandConfig.subtitle}</div>
          </div>
        </div>
        <div className="sider-kicker">运营中枢</div>
        <Menu theme="light" mode="inline" selectedKeys={[currentKey]} items={visibleMenuItems} onClick={({ key }) => navigate(`/admin/${key}`)} />
        <div className="sider-footer">
          <div className="sider-footer-label">实时连接</div>
          <div className="sider-live"><span className="live-dot" />数据同步正常</div>
        </div>
      </Sider>
      <Layout>
        <Header className="admin-header">
          <div>
            <Typography.Text className="header-context">{brandConfig.name} / {brandConfig.adminLabel}</Typography.Text>
          </div>
          <Space size={16}>
            <AdminReminderBell />
            <Tag color="blue" variant="filled">{user?.adminRole?.name ?? (user?.role && user.role !== 'ADMIN' ? roleMeta[user.role] : '管理后台')}</Tag>
            <div className="user-chip"><Avatar size={32} className="avatar-brand">管</Avatar><span>{user?.username}</span></div>
            <Button type="text" icon={<LogoutOutlined />} onClick={logout} aria-label="退出登录">退出</Button>
          </Space>
        </Header>
        <Content className="admin-content">{canViewAdminSection(user, currentKey) ? <Outlet /> : <Result status="403" title="暂无此页面权限" subTitle="当前角色无法访问此页面，请联系超级管理员调整权限。" />}</Content>
        <IcpFooter />
      </Layout>
    </Layout>
  )
}

export const AdminLayout = () => <AdminRemindersProvider><AdminLayoutContent /></AdminRemindersProvider>

import { App as AntApp, ConfigProvider, Spin } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { adminLandingPath } from './types'
import { useAuth } from './auth-context'
import { AdminLayout } from './components/AdminLayout'
import { WorkbenchLayout } from './components/WorkbenchLayout'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/admin/DashboardPage'
import { OrdersPage } from './pages/admin/OrdersPage'
import { StaffPage } from './pages/admin/StaffPage'
import { CustomersPage } from './pages/admin/CustomersPage'
import { ImportPage } from './pages/admin/ImportPage'
import { StatsPage } from './pages/admin/StatsPage'
import { FinancePage } from './pages/admin/FinancePage'
import { AfterSalesPage } from './pages/admin/AfterSalesPage'
import { BusinessConfigPage } from './pages/admin/BusinessConfigPage'
import { AdminUsersPage } from './pages/admin/AdminUsersPage'
import { WorkbenchHomePage } from './pages/workbench/WorkbenchHomePage'
import { WorkbenchOrdersPage } from './pages/workbench/WorkbenchOrdersPage'
import { WorkbenchStatsPage } from './pages/workbench/WorkbenchStatsPage'
import { WorkbenchAfterSalesPage } from './pages/workbench/WorkbenchAfterSalesPage'
const Protected = ({ role }: { role: 'ADMIN' | 'STAFF' }) => {
  const { user, loading } = useAuth()
  if (loading) return <div className="page-loading"><Spin size="large" /></div>
  if (!user) return <Navigate to={role === 'ADMIN' ? '/admin/login' : '/workbench/login'} replace />
  if ((role === 'STAFF' && user.role !== 'STAFF') || (role === 'ADMIN' && user.role === 'STAFF')) return <Navigate to={user.role === 'STAFF' ? '/workbench' : '/admin/dashboard'} replace />
  return <Outlet />
}

const RootRedirect = () => {
  const { user, loading } = useAuth()
  if (loading) return <div className="page-loading"><Spin size="large" /></div>
  return <Navigate to={user && user.role !== 'STAFF' ? adminLandingPath(user) : user ? '/workbench' : '/admin/login'} replace />
}

const adminTheme = {
  token: {
    colorPrimary: '#1456f0',
    colorInfo: '#1456f0',
    colorLink: '#1456f0',
    colorLinkHover: '#1456f0',
    colorBgLayout: '#f6f7f9',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorFillAlter: '#f7f8fa',
    colorBorder: '#ebeef2',
    colorBorderSecondary: '#ebeef2',
    colorText: 'rgba(0, 0, 0, .88)',
    colorTextSecondary: 'rgba(0, 0, 0, .65)',
  },
  components: {
    Layout: { siderBg: '#eef2ff', headerBg: '#ffffff', bodyBg: '#f6f7f9' },
    Table: { headerBg: '#f7f8fa', rowHoverBg: '#f7f8fa' },
    Card: { colorBgContainer: '#ffffff' },
  },
}

function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: { colorPrimary: '#1456f0', colorInfo: '#1456f0', colorLink: '#1456f0', colorLinkHover: '#185af1', colorSuccess: '#3d8b6d', colorError: '#cf3f47', borderRadius: 10, fontFamily: 'Inter, PingFang SC, Microsoft YaHei, sans-serif' },
        components: { Layout: { siderBg: '#eef2ff', headerBg: '#ffffff', bodyBg: '#f5f7fa' }, Table: { headerBg: '#f5f6fa' }, Card: { colorBgContainer: '#ffffff' } },
      }}
    >
      <AntApp>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/admin/login" element={<ConfigProvider theme={adminTheme}><LoginPage role="ADMIN" /></ConfigProvider>} />
          <Route element={<Protected role="ADMIN" />}>
            <Route path="/admin" element={<ConfigProvider theme={adminTheme}><AdminLayout /></ConfigProvider>}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="orders" element={<OrdersPage />} />
              <Route path="staff" element={<StaffPage />} />
              <Route path="customers" element={<CustomersPage />} />
              <Route path="stats" element={<StatsPage />} />
              <Route path="finance" element={<FinancePage />} />
              <Route path="after-sales" element={<AfterSalesPage />} />
              <Route path="config" element={<BusinessConfigPage />} />
              <Route path="permissions" element={<AdminUsersPage />} />
              <Route path="imports" element={<ImportPage />} />
            </Route>
          </Route>
          <Route path="/workbench/login" element={<LoginPage role="STAFF" />} />
          <Route element={<Protected role="STAFF" />}>
            <Route path="/workbench" element={<WorkbenchLayout />}>
              <Route index element={<WorkbenchHomePage />} />
              <Route path="orders" element={<WorkbenchOrdersPage />} />
              <Route path="after-sales" element={<WorkbenchAfterSalesPage />} />
              <Route path="stats" element={<WorkbenchStatsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </AntApp>
    </ConfigProvider>
  )
}

export default App

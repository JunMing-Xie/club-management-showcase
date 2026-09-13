import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import { AuthProvider } from './auth'
import { brandConfig } from './brand'
import './index.css'
import App from './App'

dayjs.locale('zh-cn')
document.title = `${brandConfig.name} · ${brandConfig.systemTitle}`

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)

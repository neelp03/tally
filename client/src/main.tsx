import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import AppHome from './pages/AppHome'
import Auth from './pages/Auth'
import Boards from './pages/Boards'
import Inbox from './pages/Inbox'
import Landing from './pages/Landing'
import Overview from './pages/Overview'
import PlatformAdmin from './pages/PlatformAdmin'
import PublicBoard, { NotFoundPage } from './pages/PublicBoard'
import PublicPost from './pages/PublicPost'
import ApiKeys from './pages/settings/ApiKeys'
import AuditLog from './pages/settings/AuditLog'
import Billing from './pages/settings/Billing'
import Members from './pages/settings/Members'
import Security from './pages/settings/Security'
import Settings from './pages/settings/Settings'
import { SessionProvider } from './session'
import './styles.css'
import './app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/signin" element={<Auth mode="signin" />} />
          <Route path="/signup" element={<Auth mode="signup" />} />
          <Route path="/app" element={<AppHome />} />
          <Route path="/app/new" element={<AppHome forceNew />} />
          <Route path="/app/:orgSlug" element={<AppShell />}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<Overview />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="boards" element={<Boards />} />
            <Route path="settings" element={<Settings />}>
              <Route index element={<Navigate to="members" replace />} />
              <Route path="members" element={<Members />} />
              <Route path="billing" element={<Billing />} />
              <Route path="api-keys" element={<ApiKeys />} />
              <Route path="audit-log" element={<AuditLog />} />
              <Route path="security" element={<Security />} />
            </Route>
          </Route>
          <Route path="/admin" element={<PlatformAdmin />} />
          <Route path="/b/:orgSlug" element={<PublicBoard />} />
          <Route path="/b/:orgSlug/p/:number" element={<PublicPost />} />
          <Route path="/b/:orgSlug/:boardSlug" element={<PublicBoard />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)

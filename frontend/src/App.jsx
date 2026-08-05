import React from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate, Link as RouterLink } from 'react-router-dom'
import { Button } from '@mui/material'

import { ProtectedRoute } from './components/ProtectedRoute'
import { AppShell } from './components/AppShell'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Findings } from './pages/Findings'
import { FindingDetail } from './pages/FindingDetail'
import { Upload } from './pages/Upload'
import { Profile } from './pages/Profile'
import Cases from './pages/Cases'
import CaseDetail from './pages/CaseDetail'
import Notifications from './pages/Notifications'
import NotificationDetail from './pages/NotificationDetail'
import Analytics from './pages/Analytics'
import Organizations from './pages/Organizations'
import Settings from './pages/Settings'
import AttackNavigator from './pages/AttackNavigator'
import { PAGE_CAPABILITIES } from './utils/permissions'
import { PageHeader } from './components/ui'

function NotFound() {
  return (
    <>
      <PageHeader
        eyebrow="Navigation"
        title="Page not found"
        description="That address does not correspond to a screen in this application."
      />
      <Button component={RouterLink} to="/dashboard" variant="outlined">
        Back to operations overview
      </Button>
    </>
  )
}

// One entry per route, so the capability a screen requires is declared in
// exactly one place and matches what the sidebar filters on.
const APP_ROUTES = [
  { path: '/dashboard', element: <Dashboard />, capability: PAGE_CAPABILITIES.dashboard },
  { path: '/findings', element: <Findings />, capability: PAGE_CAPABILITIES.findings },
  { path: '/findings/:id', element: <FindingDetail />, capability: PAGE_CAPABILITIES.findingDetail },
  { path: '/upload', element: <Upload />, capability: PAGE_CAPABILITIES.upload },
  { path: '/cases', element: <Cases />, capability: PAGE_CAPABILITIES.cases },
  { path: '/cases/:id', element: <CaseDetail />, capability: PAGE_CAPABILITIES.caseDetail },
  { path: '/analytics', element: <Analytics />, capability: PAGE_CAPABILITIES.analytics },
  { path: '/attack', element: <AttackNavigator />, capability: PAGE_CAPABILITIES.attack },
  // Registered after the list so "/notifications" is never matched as an id.
  { path: '/notifications', element: <Notifications />, capability: PAGE_CAPABILITIES.notifications },
  {
    path: '/notifications/:id',
    element: <NotificationDetail />,
    capability: PAGE_CAPABILITIES.notificationDetail,
  },
  { path: '/organizations', element: <Organizations />, capability: PAGE_CAPABILITIES.organizations },
  { path: '/settings', element: <Settings />, capability: PAGE_CAPABILITIES.settings },
  // The one deliberate authenticated-only route: a personal page with no
  // backend capability of its own to mirror.
  { path: '/profile', element: <Profile />, authOnly: true },
]

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route
          path="/*"
          element={
            <ProtectedRoute requireAuthOnly>
              <AppShell>
                <Routes>
                  {APP_ROUTES.map((route) => (
                    <Route
                      key={route.path}
                      path={route.path}
                      element={
                        <ProtectedRoute
                          requiredCapability={route.capability}
                          requireAuthOnly={route.authOnly}
                        >
                          {route.element}
                        </ProtectedRoute>
                      }
                    />
                  ))}
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </AppShell>
            </ProtectedRoute>
          }
        />
      </Routes>
    </Router>
  )
}

export default App

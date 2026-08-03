import React from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { Box } from '@mui/material'
import { useAuth } from './hooks/useAuth'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Navbar } from './components/Navbar'
import { Sidebar, DRAWER_WIDTH } from './components/Sidebar'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Threats } from './pages/Threats'
import { Upload } from './pages/Upload'
import { Profile } from './pages/Profile'
import Cases from './pages/Cases'
import CaseDetail from './pages/CaseDetail'
import Notifications from "./pages/Notifications";
import NotificationDetail from './pages/NotificationDetail'
import Analytics from "./pages/Analytics";
import Organizations from "./pages/Organizations";
import Settings from "./pages/Settings";
import { PAGE_CAPABILITIES } from './utils/permissions'
import './App.css'

function App() {
  const { isAuthenticated, loading } = useAuth()

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div>Loading...</div>
      </Box>
    )
  }

  return (
    <Router>
      <Routes>
        {/* Login Route */}
        <Route path="/login" element={<Login />} />

        {/* Protected Routes */}
        <Route
          path="/*"
          element={
            <ProtectedRoute requireAuthOnly>
              <Box sx={{ display: 'flex' }}>
                <Navbar />
                <Sidebar />
                <Box
                  sx={{
                    marginLeft: `${DRAWER_WIDTH}px`,
                    marginTop: '72px',
                    flex: 1,
                    minHeight: 'calc(100vh - 72px)',
                    backgroundColor: '#080c14',
                  }} className="app-content"
                >
               <Routes>
  <Route
    path="/dashboard"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.dashboard}>
        <Dashboard />
      </ProtectedRoute>
    }
  />

  <Route
    path="/threats"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.threats}>
        <Threats />
      </ProtectedRoute>
    }
  />

  <Route
    path="/upload"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.upload}>
        <Upload />
      </ProtectedRoute>
    }
  />

  <Route
    path="/cases"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.cases}>
        <Cases />
      </ProtectedRoute>
    }
  />

  <Route
    path="/cases/:id"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.caseDetail}>
        <CaseDetail />
      </ProtectedRoute>
    }
  />

  <Route
    path="/analytics"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.analytics}>
        <Analytics />
      </ProtectedRoute>
    }
  />

  <Route
    path="/notifications"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.notifications}>
        <Notifications />
      </ProtectedRoute>
    }
  />

  {/* Registered after the list so "/notifications" is never matched as an id. */}
  <Route
    path="/notifications/:id"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.notificationDetail}>
        <NotificationDetail />
      </ProtectedRoute>
    }
  />

  <Route
    path="/organizations"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.organizations}>
        <Organizations />
      </ProtectedRoute>
    }
  />

  <Route
    path="/settings"
    element={
      <ProtectedRoute requiredCapability={PAGE_CAPABILITIES.settings}>
        <Settings />
      </ProtectedRoute>
    }
  />

  <Route
    path="/profile"
    element={
      <ProtectedRoute requireAuthOnly>
        <Profile />
      </ProtectedRoute>
    }
  />

  <Route
    path="/"
    element={<Navigate to="/dashboard" replace />}
  />
</Routes>
                </Box>
              </Box>
            </ProtectedRoute>
          }
        />
      </Routes>
    </Router>
  )
}

export default App

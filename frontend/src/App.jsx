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
import Notifications from "./pages/Notifications";
import Analytics from "./pages/Analytics";
import Organizations from "./pages/Organizations";
import Settings from "./pages/Settings";
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
            <ProtectedRoute>
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
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/threats" element={<Threats />} />
                    <Route path="/upload" element={<Upload />} />
                    <Route path="/cases" element={<Cases />} />
                    <Route path="/analytics" element={<Analytics />} />
                    <Route path="/notifications" element={<Notifications />} />
                    <Route path="/organizations" element={<Organizations />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/profile" element={<Profile />} />
                    <Route path="/" element={<Navigate to="/dashboard" replace />} />
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

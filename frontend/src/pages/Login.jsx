import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Container, Box, TextField, Button, Typography, Card, Alert } from '@mui/material'
import { useAuth } from '../hooks/useAuth'
import { authService } from '../services/api'
import toast from 'react-hot-toast'
import { FiShield } from 'react-icons/fi'

export const Login = () => {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      if (!email || !password) {
        setError('Please fill in all fields')
        setLoading(false)
        return
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setError('Please enter a valid email address')
        setLoading(false)
        return
      }

      const response = await authService.login(email, password)
      const { token, user, success } = response.data

      if (success) {
        login(token, user)
        toast.success('Login successful!')
        navigate('/dashboard')
      } else {
        setError('Login failed. Please try again.')
      }
    } catch (err) {
      const errorMessage = err.response?.data?.message || 'Login failed. Please try again.'
      setError(errorMessage)
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0d1117 0%, #161b22 100%)',
      }}
    >
      <Container maxWidth="sm">
        <Card
          sx={{
            p: 4,
            backgroundColor: '#161b22',
            boxShadow: '0 8px 32px rgba(88, 166, 255, 0.1)',
            border: '1px solid rgba(88, 166, 255, 0.2)',
          }}
        >
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
              <FiShield size={40} color="#58a6ff" />
            </Box>
            <Typography variant="h3" sx={{ color: '#58a6ff', mb: 1 }}>
              ThreatNeXus
            </Typography>
            <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)' }}>
              Cybersecurity Threat Intelligence Platform
            </Typography>
          </Box>

          <form onSubmit={handleLogin}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            <TextField
              fullWidth
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              margin="normal"
              disabled={loading}
              sx={{
                '& .MuiOutlinedInput-root': {
                  borderRadius: 2,
                },
              }}
            />

            <TextField
              fullWidth
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              margin="normal"
              disabled={loading}
              sx={{
                '& .MuiOutlinedInput-root': {
                  borderRadius: 2,
                },
              }}
            />

            <Button
              fullWidth
              variant="contained"
              size="large"
              sx={{
                mt: 3,
                backgroundColor: '#58a6ff',
                color: '#0d1117',
                fontWeight: 600,
                '&:hover': {
                  backgroundColor: '#1f6feb',
                },
              }}
              onClick={handleLogin}
              disabled={loading}
            >
              {loading ? 'Logging in...' : 'Login'}
            </Button>

            <Typography
              variant="caption"
              sx={{ display: 'block', mt: 2, textAlign: 'center', color: 'rgba(255, 255, 255, 0.6)' }}
            >
              Demo: ali@example.com / password123
            </Typography>
          </form>
        </Card>
      </Container>
    </Box>
  )
}

import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Container, Box, TextField, Button, Typography, Card, Alert, Chip } from '@mui/material'
import { useAuth } from '../hooks/useAuth'
import { authService } from '../services/api'
import toast from 'react-hot-toast'
import { FiShield, FiArrowRight, FiActivity } from 'react-icons/fi'

export const Login = () => {
  const navigate = useNavigate(); const { login } = useAuth()
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState('')
  const submit = async (event) => { event.preventDefault(); setError(''); if (!email || !password) return setError('Enter your email and password'); setLoading(true); try { const response = await authService.login(email, password); if (response.data.success) { login(response.data.token, response.data.user, response.data.capabilities); toast.success('Welcome back'); navigate('/dashboard') } else setError('Login failed. Please try again.') } catch (err) { setError(err.response?.data?.message || 'Login failed. Please try again.') } finally { setLoading(false) } }
  return <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2, background: 'radial-gradient(circle at 15% 15%,rgba(110,231,199,.12),transparent 26rem),radial-gradient(circle at 85% 85%,rgba(118,136,255,.13),transparent 32rem),#080c14' }}>
    <Container maxWidth="sm">
      <Box sx={{ textAlign: 'center', mb: 3 }}><Box sx={{ mx: 'auto', mb: 2, width: 50, height: 50, display: 'grid', placeItems: 'center', borderRadius: 3, bgcolor: '#6ee7c7', color: '#071018' }}><FiShield size={28} /></Box><Typography sx={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.06em' }}>ThreatNeXus</Typography><Typography className="mono" sx={{ color: '#7c8b9f', fontSize: 10, letterSpacing: '.1em', mt: .6 }}>INTELLIGENCE OPERATIONS PLATFORM</Typography></Box>
      <Card className="surface" sx={{ p: { xs: 2.5, sm: 4 } }}>
        <Chip icon={<FiActivity size={13} />} label="Secure analyst access" size="small" sx={{ mb: 2.5, bgcolor: 'rgba(110,231,199,.09)', color: '#6ee7c7', '& .MuiChip-icon': { color: '#6ee7c7' }, fontWeight: 700, fontSize: 10 }} />
        <Typography sx={{ fontSize: 22, fontWeight: 800 }}>Sign in to your workspace</Typography><Typography sx={{ fontSize: 13, color: '#8290a5', mt: .7, mb: 2.5 }}>Use your authorized intelligence platform credentials.</Typography>
        <form onSubmit={submit}>{error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}<TextField label="Work email" type="email" fullWidth value={email} onChange={(event) => setEmail(event.target.value)} disabled={loading} sx={{ mb: 2 }} /><TextField label="Password" type="password" fullWidth value={password} onChange={(event) => setPassword(event.target.value)} disabled={loading} /><Button type="submit" fullWidth variant="contained" endIcon={<FiArrowRight />} disabled={loading} sx={{ mt: 3, py: 1.25, bgcolor: '#6ee7c7', color: '#081018', '&:hover': { bgcolor: '#98f1d9' } }}>{loading ? 'Authenticating...' : 'Continue securely'}</Button></form>
        <Typography className="mono" sx={{ display: 'block', mt: 2.5, textAlign: 'center', fontSize: 10, color: '#69788c' }}>DEMO // ali@example.com / password123</Typography>
      </Card>
    </Container>
  </Box>
}

import React from 'react'
import { Box, Card, Typography, Grid, Avatar, Button } from '@mui/material'
import { useAuth } from '../hooks/useAuth'
import { useNavigate } from 'react-router-dom'
import { FiArrowLeft } from 'react-icons/fi'

export const Profile = () => {
  const { user } = useAuth()
  const navigate = useNavigate()

  if (!user) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography>User not found</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ p: 3 }}>
      <Button
        startIcon={<FiArrowLeft />}
        onClick={() => navigate('/dashboard')}
        sx={{ mb: 3 }}
      >
        Back to Dashboard
      </Button>

      <Typography variant="h3" sx={{ mb: 3, color: '#58a6ff' }}>
        User Profile
      </Typography>

      <Grid container spacing={3}>
        {/* Profile Card */}
        <Grid item xs={12} md={4}>
          <Card sx={{ backgroundColor: '#161b22', p: 3, textAlign: 'center' }}>
            <Avatar
              sx={{
                width: 120,
                height: 120,
                backgroundColor: '#58a6ff',
                fontSize: '2rem',
                margin: '0 auto',
                mb: 2,
              }}
            >
              {user.name.charAt(0).toUpperCase()}
            </Avatar>
            <Typography variant="h5" sx={{ mb: 1, color: '#58a6ff' }}>
              {user.name}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: 'rgba(255, 255, 255, 0.6)',
                backgroundColor: 'rgba(88, 166, 255, 0.1)',
                display: 'inline-block',
                px: 2,
                py: 0.5,
                borderRadius: 1,
              }}
            >
              {user.role}
            </Typography>
          </Card>
        </Grid>

        {/* Details Card */}
        <Grid item xs={12} md={8}>
          <Card sx={{ backgroundColor: '#161b22', p: 3 }}>
            <Typography variant="h6" sx={{ color: '#58a6ff', mb: 2 }}>
              Account Information
            </Typography>

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
                gap: 2,
              }}
            >
              <Box sx={{ pb: 2, borderBottom: '1px solid rgba(88, 166, 255, 0.1)' }}>
                <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)', mb: 0.5 }}>
                  Full Name
                </Typography>
                <Typography variant="body1" sx={{ color: '#58a6ff' }}>
                  {user.name}
                </Typography>
              </Box>

              <Box sx={{ pb: 2, borderBottom: '1px solid rgba(88, 166, 255, 0.1)' }}>
                <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)', mb: 0.5 }}>
                  Email Address
                </Typography>
                <Typography variant="body1" sx={{ color: '#58a6ff' }}>
                  {user.email}
                </Typography>
              </Box>

              <Box sx={{ pb: 2, borderBottom: '1px solid rgba(88, 166, 255, 0.1)' }}>
                <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)', mb: 0.5 }}>
                  User ID
                </Typography>
                <Typography variant="body1" sx={{ color: '#58a6ff' }}>
                  {user.id}
                </Typography>
              </Box>

              <Box sx={{ pb: 2, borderBottom: '1px solid rgba(88, 166, 255, 0.1)' }}>
                <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)', mb: 0.5 }}>
                  Role
                </Typography>
                <Typography variant="body1" sx={{ color: '#58a6ff' }}>
                  {user.role}
                </Typography>
              </Box>
            </Box>
          </Card>
        </Grid>

        {/* Additional Info */}
        <Grid item xs={12}>
          <Card sx={{ backgroundColor: '#161b22', p: 3 }}>
            <Typography variant="h6" sx={{ color: '#58a6ff', mb: 2 }}>
              About ThreatNeXus
            </Typography>
            <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.8)', lineHeight: 1.6 }}>
              ThreatNeXus is a comprehensive Cybersecurity Threat Intelligence Platform designed to
              help security teams detect, analyze, and respond to threats in real-time. With advanced
              threat detection capabilities and intuitive dashboards, ThreatNeXus provides actionable
              intelligence to protect your organization&apos;s critical assets.
            </Typography>
          </Card>
        </Grid>
      </Grid>
    </Box>
  )
}

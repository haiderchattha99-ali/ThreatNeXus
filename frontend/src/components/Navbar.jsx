import React from 'react'
import { AppBar, Toolbar, Box, Button, Avatar, Menu, MenuItem } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { FiLogOut, FiUser } from 'react-icons/fi'
import toast from 'react-hot-toast'

export const Navbar = () => {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const [anchorEl, setAnchorEl] = React.useState(null)

  const handleMenuOpen = (event) => {
    setAnchorEl(event.currentTarget)
  }

  const handleMenuClose = () => {
    setAnchorEl(null)
  }

  const handleLogout = () => {
    logout()
    handleMenuClose()
    toast.success('Logged out successfully')
    navigate('/login')
  }

  const handleProfile = () => {
    handleMenuClose()
    navigate('/profile')
  }

  return (
    <AppBar position="fixed" sx={{ zIndex: 1201 }}>
      <Toolbar>
        <Box flex={1}>
          <Box sx={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#58a6ff' }}>
            ThreatNeXus
          </Box>
        </Box>

        {user && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box sx={{ textAlign: 'right', mr: 2 }}>
              <Box sx={{ fontSize: '0.9rem' }}>{user.name}</Box>
              <Box sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.7)' }}>
                {user.role}
              </Box>
            </Box>
            <Button
              onClick={handleMenuOpen}
              sx={{
                borderRadius: '50%',
                minWidth: 'auto',
                p: 0,
                '&:hover': {
                  backgroundColor: 'rgba(88, 166, 255, 0.1)',
                },
              }}
            >
              <Avatar
                sx={{
                  width: 40,
                  height: 40,
                  backgroundColor: '#58a6ff',
                  cursor: 'pointer',
                }}
              >
                {user.name.charAt(0).toUpperCase()}
              </Avatar>
            </Button>
          </Box>
        )}

        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={handleMenuClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          <MenuItem onClick={handleProfile} sx={{ gap: 1 }}>
            <FiUser /> Profile
          </MenuItem>
          <MenuItem onClick={handleLogout} sx={{ gap: 1 }}>
            <FiLogOut /> Logout
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  )
}

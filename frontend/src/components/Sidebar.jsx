import React from 'react'
import { Drawer, Box, List, ListItem, ListItemButton, ListItemIcon, ListItemText } from '@mui/material'
import { useLocation, useNavigate } from 'react-router-dom'
import { FiBarChart2, FiAlertTriangle, FiUpload, FiUser } from 'react-icons/fi'

const DRAWER_WIDTH = 280

const menuItems = [
  {
    label: 'Dashboard',
    path: '/dashboard',
    icon: FiBarChart2,
  },
  {
    label: 'Threats',
    path: '/threats',
    icon: FiAlertTriangle,
  },
  {
    label: 'Upload CSV',
    path: '/upload',
    icon: FiUpload,
  },
]

export const Sidebar = () => {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: DRAWER_WIDTH,
          boxSizing: 'border-box',
          backgroundColor: '#0d1117',
          borderRight: '1px solid rgba(88, 166, 255, 0.1)',
          mt: 8,
        },
      }}
    >
      <Box sx={{ p: 2 }}>
        <List>
          {menuItems.map((item) => {
            const Icon = item.icon
            const isActive = location.pathname === item.path
            return (
              <ListItem key={item.path} disablePadding sx={{ mb: 1 }}>
                <ListItemButton
                  onClick={() => navigate(item.path)}
                  sx={{
                    borderRadius: 1,
                    backgroundColor: isActive ? 'rgba(88, 166, 255, 0.15)' : 'transparent',
                    color: isActive ? '#58a6ff' : 'rgba(255, 255, 255, 0.7)',
                    '&:hover': {
                      backgroundColor: 'rgba(88, 166, 255, 0.1)',
                      color: '#58a6ff',
                    },
                    transition: 'all 0.3s ease',
                  }}
                >
                  <ListItemIcon
                    sx={{
                      color: isActive ? '#58a6ff' : 'rgba(255, 255, 255, 0.7)',
                      minWidth: 40,
                    }}
                  >
                    <Icon size={20} />
                  </ListItemIcon>
                  <ListItemText primary={item.label} />
                </ListItemButton>
              </ListItem>
            )
          })}
        </List>
      </Box>
    </Drawer>
  )
}

export { DRAWER_WIDTH }

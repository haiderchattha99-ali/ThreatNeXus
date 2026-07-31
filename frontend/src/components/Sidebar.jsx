import React from 'react'
import {
  Drawer,
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Chip,
} from '@mui/material'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  FiGrid,
  FiShield,
  FiUploadCloud,
  FiFileText,
  FiBell,
  FiUsers,
  FiSettings,
  FiBarChart2,
  FiActivity,
} from 'react-icons/fi'

import { useAuth } from '../hooks/useAuth'
import { hasCapability, PAGE_CAPABILITIES } from '../utils/permissions'

export const DRAWER_WIDTH = 252

const menuItems = [
  {
    label: 'Command center',
    path: '/dashboard',
    icon: FiGrid,
    permission: 'dashboard',
  },
  {
    label: 'Threat findings',
    path: '/threats',
    icon: FiShield,
    permission: 'threats',
  },
  {
    label: 'Intelligence upload',
    path: '/upload',
    icon: FiUploadCloud,
    permission: 'upload',
  },
  {
    label: 'Cases',
    path: '/cases',
    icon: FiFileText,
    permission: 'cases',
  },
  {
    label: 'Notifications',
    path: '/notifications',
    icon: FiBell,
    permission: 'notifications',
  },
  {
    label: 'Organizations',
    path: '/organizations',
    icon: FiUsers,
    permission: 'organizations',
  },
  {
    label: 'Analytics',
    path: '/analytics',
    icon: FiBarChart2,
    permission: 'analytics',
  },
  {
    label: 'Settings',
    path: '/settings',
    icon: FiSettings,
    permission: 'settings',
  },
]

export const Sidebar = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { capabilities } = useAuth()

  // Same decision source as route protection (App.jsx's ProtectedRoute):
  // PAGE_CAPABILITIES + the capabilities array from the validated session.
  // A page never appears in the sidebar unless the matching route would also
  // render for this user.
  const visibleMenu = menuItems.filter((item) =>
    hasCapability(capabilities, PAGE_CAPABILITIES[item.permission])
  )

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: DRAWER_WIDTH,
          mt: '72px',
          height: 'calc(100% - 72px)',
          border: 0,
          borderRight: '1px solid #202d40',
          bgcolor: '#0b101a',
          color: '#b5c0d1',
          px: 1.4,
          py: 2.5,
        },
      }}
    >
      <Typography className="eyebrow" sx={{ px: 1.5, mb: 1.5 }}>
        Workspace
      </Typography>

      <List disablePadding>
        {visibleMenu.map((item) => {
          const active = location.pathname === item.path
          const Icon = item.icon

          return (
            <ListItemButton
              key={item.path}
              onClick={() => navigate(item.path)}
              sx={{
                minHeight: 45,
                mb: 0.45,
                px: 1.5,
                borderRadius: 2.5,
                color: active ? '#effff9' : '#9aa8ba',
                bgcolor: active
                  ? 'rgba(110,231,199,.12)'
                  : 'transparent',
                '&:hover': {
                  bgcolor: active
                    ? 'rgba(110,231,199,.15)'
                    : '#151d2a',
                },
              }}
            >
              <ListItemIcon
                sx={{
                  minWidth: 35,
                  color: active ? '#6ee7c7' : '#708098',
                }}
              >
                <Icon size={18} />
              </ListItemIcon>

              <ListItemText
                primary={item.label}
                primaryTypographyProps={{
                  fontSize: 13,
                  fontWeight: active ? 700 : 600,
                }}
              />
            </ListItemButton>
          )
        })}
      </List>

      <Box
        sx={{
          mt: 'auto',
          m: 1,
          p: 1.7,
          border: '1px solid #253348',
          borderRadius: 3,
          bgcolor: '#101723',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mb: 1,
          }}
        >
          <FiActivity color="#6ee7c7" />
          <Typography
            sx={{
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            SYSTEM STATUS
          </Typography>
        </Box>

        <Chip
          size="small"
          label="All systems operational"
          sx={{
            height: 24,
            bgcolor: 'rgba(110,231,199,.1)',
            color: '#78e7c9',
            fontSize: 10,
            fontWeight: 700,
          }}
        />

        <Typography
          className="mono"
          sx={{
            mt: 1.2,
            fontSize: 9,
            color: '#64748b',
          }}
        >
          THREATNEXUS // V1.0.0
        </Typography>
      </Box>
    </Drawer>
  )
}
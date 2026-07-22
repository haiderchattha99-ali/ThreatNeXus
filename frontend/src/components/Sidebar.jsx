import React from 'react'
import { Drawer, Box, List, ListItemButton, ListItemIcon, ListItemText, Typography, Chip } from '@mui/material'
import { useLocation, useNavigate } from 'react-router-dom'
import { FiGrid, FiShield, FiUploadCloud, FiFileText, FiBell, FiUsers, FiSettings, FiBarChart2, FiActivity } from 'react-icons/fi'

export const DRAWER_WIDTH = 252

const menuItems = [
  ['Command center', '/dashboard', FiGrid],
  ['Threat findings', '/threats', FiShield],
  ['Intelligence upload', '/upload', FiUploadCloud],
  ['Cases', '/cases', FiFileText],
  ['Notifications', '/notifications', FiBell],
  ['Organizations', '/organizations', FiUsers],
  ['Analytics', '/analytics', FiBarChart2],
  ['Settings', '/settings', FiSettings],
]

export const Sidebar = () => {
  const location = useLocation()
  const navigate = useNavigate()
  return <Drawer variant="permanent" sx={{ width: DRAWER_WIDTH, flexShrink: 0, '& .MuiDrawer-paper': { width: DRAWER_WIDTH, mt: '72px', height: 'calc(100% - 72px)', border: 0, borderRight: '1px solid #202d40', bgcolor: '#0b101a', color: '#b5c0d1', px: 1.4, py: 2.5 } }}>
    <Typography className="eyebrow" sx={{ px: 1.5, mb: 1.5 }}>Workspace</Typography>
    <List disablePadding>
      {menuItems.map(([label, path, Icon]) => {
        const active = location.pathname === path
        return <ListItemButton key={path} onClick={() => navigate(path)} sx={{ minHeight: 45, mb: .45, px: 1.5, borderRadius: 2.5, color: active ? '#effff9' : '#9aa8ba', bgcolor: active ? 'rgba(110,231,199,.12)' : 'transparent', '&:hover': { bgcolor: active ? 'rgba(110,231,199,.15)' : '#151d2a' } }}>
          <ListItemIcon sx={{ minWidth: 35, color: active ? '#6ee7c7' : '#708098' }}><Icon size={18} /></ListItemIcon>
          <ListItemText primary={label} primaryTypographyProps={{ fontSize: 13, fontWeight: active ? 700 : 600 }} />
        </ListItemButton>
      })}
    </List>
    <Box sx={{ mt: 'auto', m: 1, p: 1.7, border: '1px solid #253348', borderRadius: 3, bgcolor: '#101723' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}><FiActivity color="#6ee7c7" /><Typography sx={{ fontSize: 12, fontWeight: 800 }}>SYSTEM STATUS</Typography></Box>
      <Chip size="small" label="All systems operational" sx={{ height: 24, bgcolor: 'rgba(110,231,199,.1)', color: '#78e7c9', fontSize: 10, fontWeight: 700 }} />
      <Typography className="mono" sx={{ mt: 1.2, fontSize: 9, color: '#64748b' }}>THREATNEXUS // V1.0.0</Typography>
    </Box>
  </Drawer>
}

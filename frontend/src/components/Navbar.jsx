import React from 'react'
import { AppBar, Toolbar, Box, Avatar, Menu, MenuItem, Typography, IconButton, Divider, Chip } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { FiLogOut, FiUser, FiShield, FiSettings, FiSearch, FiBell } from 'react-icons/fi'
import toast from 'react-hot-toast'

export const Navbar = () => {
  const navigate = useNavigate(); const { user, logout } = useAuth(); const [anchorEl, setAnchorEl] = React.useState(null)
  const close = () => setAnchorEl(null)
  const handleLogout = () => { logout(); close(); toast.success('Signed out securely'); navigate('/login') }
  return <AppBar position="fixed" elevation={0} sx={{ height: 72, justifyContent: 'center', zIndex: 1201, bgcolor: 'rgba(8,12,20,.92)', backdropFilter: 'blur(16px)', borderBottom: '1px solid #202d40' }}>
    <Toolbar sx={{ minHeight: '72px !important', px: { xs: 2, md: 3.5 }, justifyContent: 'space-between' }}>
      <Box display="flex" alignItems="center" gap={1.4}><Box sx={{ width: 36, height: 36, display: 'grid', placeItems: 'center', bgcolor: '#6ee7c7', color: '#081017', borderRadius: 2 }}><FiShield size={20}/></Box><Box><Typography sx={{ color: '#f4f7fb', fontWeight: 800, letterSpacing: '-.05em', lineHeight: 1 }}>ThreatNeXus</Typography><Typography className="mono" sx={{ color: '#718096', fontSize: 9, letterSpacing: '.06em', mt: .45 }}>INTELLIGENCE OPERATIONS</Typography></Box></Box>
      {user && <Box display="flex" alignItems="center" gap={{ xs: 1, md: 2 }}>
        <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', color: '#607089', bgcolor: '#111925', border: '1px solid #243145', borderRadius: 2, px: 1.25, py: .8, minWidth: 210, gap: .8 }}><FiSearch size={15}/><Typography sx={{ fontSize: 12 }}>Search intelligence</Typography></Box>
        <IconButton sx={{ color: '#a9b5c5' }}><FiBell size={19}/></IconButton><Chip label="Live" size="small" sx={{ display: { xs: 'none', sm: 'inline-flex' }, bgcolor: 'rgba(110,231,199,.1)', color: '#72e5c7', fontWeight: 800, fontSize: 10 }} />
        <IconButton onClick={(e) => setAnchorEl(e.currentTarget)} sx={{ p: 0 }}><Avatar sx={{ width: 34, height: 34, bgcolor: '#7688ff', fontSize: 13, fontWeight: 800 }}>{user.name?.charAt(0)?.toUpperCase()}</Avatar></IconButton>
        <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={close} PaperProps={{ sx: { mt: 1, minWidth: 210, bgcolor: '#111925', color: '#e8edf7', border: '1px solid #27364a', borderRadius: 2 } }}><Box sx={{ px: 2, py: 1.5 }}><Typography fontWeight={800}>{user.name}</Typography><Typography className="mono" sx={{ fontSize: 10, color: '#79889c' }}>{user.role}</Typography></Box><Divider sx={{ borderColor: '#263448' }}/><MenuItem onClick={() => { close(); navigate('/profile') }} sx={{ gap: 1.3, fontSize: 13 }}><FiUser/>Profile</MenuItem><MenuItem sx={{ gap: 1.3, fontSize: 13 }}><FiSettings/>Settings</MenuItem><Divider sx={{ borderColor: '#263448' }}/><MenuItem onClick={handleLogout} sx={{ gap: 1.3, color: '#ff8795', fontSize: 13 }}><FiLogOut/>Sign out</MenuItem></Menu>
      </Box>}
    </Toolbar>
  </AppBar>
}

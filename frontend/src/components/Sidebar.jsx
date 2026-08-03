import React from 'react'
import { Drawer, Box, List, ListItemButton, ListItemIcon, ListItemText } from '@mui/material'
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
} from 'react-icons/fi'

import { useAuth } from '../hooks/useAuth'
import { hasCapability, PAGE_CAPABILITIES } from '../utils/permissions'
import { color, radius, type, layout } from '../theme/tokens'
import { PkcertAttribution } from './ui/Brand'

export const DRAWER_WIDTH = layout.sidebarWidth

// Grouped so the navigation communicates the workflow's shape rather than being
// a flat list of eight equal things. The order follows the operational spine:
// evidence in -> findings -> cases -> constituent notification -> oversight.
export const NAV_GROUPS = [
  {
    heading: 'Operations',
    items: [
      { label: 'Operations overview', path: '/dashboard', icon: FiGrid, permission: 'dashboard' },
      { label: 'Findings', path: '/findings', icon: FiShield, permission: 'findings' },
      { label: 'Report ingestion', path: '/upload', icon: FiUploadCloud, permission: 'upload' },
    ],
  },
  {
    heading: 'Response',
    items: [
      { label: 'Cases', path: '/cases', icon: FiFileText, permission: 'cases' },
      { label: 'Notifications', path: '/notifications', icon: FiBell, permission: 'notifications' },
    ],
  },
  {
    heading: 'Administration',
    items: [
      { label: 'Analytics', path: '/analytics', icon: FiBarChart2, permission: 'analytics' },
      { label: 'Organizations', path: '/organizations', icon: FiUsers, permission: 'organizations' },
      { label: 'Settings', path: '/settings', icon: FiSettings, permission: 'settings' },
    ],
  },
]

// Flat view, kept for anything that needs the whole list (tests, breadcrumbs).
export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items)

function isActive(pathname, path) {
  if (path === '/dashboard') return pathname === '/' || pathname.startsWith('/dashboard')
  return pathname === path || pathname.startsWith(`${path}/`)
}

/**
 * The navigation list itself. Rendered inside a permanent drawer on desktop and
 * a temporary drawer on small screens, so there is exactly one definition of
 * what the navigation is and who may see each entry.
 *
 * Visibility uses the SAME decision source as route protection
 * (PAGE_CAPABILITIES + the server-derived capability array). A link is never
 * shown for a route that would render 403 — and the backend refuses the
 * underlying request regardless of what is rendered here.
 */
export function SidebarNav({ onNavigate }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { capabilities } = useAuth()

  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      hasCapability(capabilities, PAGE_CAPABILITIES[item.permission])
    ),
  })).filter((group) => group.items.length > 0)

  return (
    <Box
      component="nav"
      aria-label="Primary"
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', px: 1.5, py: 2 }}
    >
      {groups.map((group) => (
        <Box key={group.heading} sx={{ mb: 2 }}>
          <Box
            id={`nav-group-${group.heading}`}
            sx={{ ...type.label, color: color.textFaint, px: 1.5, mb: 0.75 }}
          >
            {group.heading}
          </Box>
          <List disablePadding aria-labelledby={`nav-group-${group.heading}`}>
            {group.items.map((item) => {
              const active = isActive(location.pathname, item.path)
              const Icon = item.icon
              return (
                <ListItemButton
                  key={item.path}
                  onClick={() => {
                    navigate(item.path)
                    if (onNavigate) onNavigate()
                  }}
                  // aria-current is what tells a screen-reader user which page
                  // they are on. The accent bar beside it is the visual echo,
                  // not the signal.
                  aria-current={active ? 'page' : undefined}
                  sx={{
                    position: 'relative',
                    minHeight: 40,
                    mb: 0.25,
                    px: 1.5,
                    borderRadius: `${radius.sm}px`,
                    color: active ? color.text : color.textMuted,
                    backgroundColor: active ? color.accentQuiet : 'transparent',
                    '&:hover': {
                      backgroundColor: active ? color.accentQuiet : color.surfaceRaised,
                      color: color.text,
                    },
                    '&::before': active
                      ? {
                          content: '""',
                          position: 'absolute',
                          left: 0,
                          top: 8,
                          bottom: 8,
                          width: 2,
                          borderRadius: 2,
                          backgroundColor: color.accent,
                        }
                      : undefined,
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 32, color: active ? color.accent : color.textFaint }}>
                    <Icon size={16} aria-hidden="true" />
                  </ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    primaryTypographyProps={{ fontSize: 13.5, fontWeight: active ? 600 : 500 }}
                  />
                </ListItemButton>
              )
            })}
          </List>
        </Box>
      ))}

      <Box sx={{ mt: 'auto', pt: 2, borderTop: `1px solid ${color.border}`, px: 0.5 }}>
        <PkcertAttribution variant="compact" />
      </Box>
    </Box>
  )
}

/**
 * Permanent desktop drawer. AppShell renders this at md and up; below that it
 * renders SidebarNav inside a temporary drawer instead.
 */
export const Sidebar = () => (
  <Drawer
    variant="permanent"
    sx={{
      width: DRAWER_WIDTH,
      flexShrink: 0,
      '& .MuiDrawer-paper': {
        width: DRAWER_WIDTH,
        mt: `${layout.topBarHeight}px`,
        height: `calc(100% - ${layout.topBarHeight}px)`,
        backgroundColor: color.canvasAlt,
        borderRight: `1px solid ${color.border}`,
      },
    }}
  >
    <SidebarNav />
  </Drawer>
)

export default Sidebar

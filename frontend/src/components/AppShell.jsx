// AppShell — the frame every authenticated screen renders inside.
//
// What it owns, so no page has to:
//   - a skip-to-content link (first tab stop on every page)
//   - the <header>/<nav>/<main> landmark structure
//   - a permanent sidebar on desktop, a temporary drawer on small screens
//   - the identity/role display and a safe sign-out
//   - the session-expired path
//
// Frontend authorization here is UX only. Every link is filtered by the
// server-derived capability array, and every backend route re-checks its own
// capability regardless of what this shell chose to render.

import React from 'react'
import { Link as RouterLink, useNavigate } from 'react-router-dom'
import {
  AppBar,
  Box,
  Drawer,
  IconButton,
  Menu,
  MenuItem,
  Toolbar,
  Divider,
  useMediaQuery,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { FiMenu, FiLogOut, FiUser, FiChevronDown } from 'react-icons/fi'

import { useAuth } from '../hooks/useAuth'
import { SidebarNav, DRAWER_WIDTH } from './Sidebar'
import { BrandMark } from './ui/Brand'
import { color, layout, radius, type, font } from '../theme/tokens'

const SKIP_TARGET_ID = 'tnx-main-content'

function SkipLink() {
  return (
    <Box
      component="a"
      href={`#${SKIP_TARGET_ID}`}
      sx={{
        position: 'absolute',
        left: 8,
        top: 8,
        zIndex: (t) => t.zIndex.tooltip + 1,
        // Off-screen until focused — a keyboard user's first Tab reveals it.
        transform: 'translateY(-200%)',
        transition: 'transform 120ms ease',
        px: 2,
        py: 1,
        borderRadius: `${radius.sm}px`,
        backgroundColor: color.accent,
        color: color.textInverse,
        fontSize: 13,
        fontWeight: 600,
        textDecoration: 'none',
        '&:focus': { transform: 'translateY(0)' },
      }}
    >
      Skip to main content
    </Box>
  )
}

function RoleChip({ role }) {
  if (!role) return null
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: 0.85,
        py: '2px',
        borderRadius: `${radius.sm}px`,
        border: `1px solid ${color.borderStrong}`,
        color: color.textMuted,
        fontFamily: font.mono,
        fontSize: 10.5,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}
    >
      {role}
    </Box>
  )
}

export function AppShell({ children }) {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const navigate = useNavigate()
  const { user, capabilities, logout } = useAuth()

  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [menuAnchor, setMenuAnchor] = React.useState(null)

  // Closing the drawer when the viewport grows avoids the state where a user
  // rotates a tablet and is left with an invisible-but-open overlay trapping
  // focus.
  React.useEffect(() => {
    if (isDesktop) setMobileOpen(false)
  }, [isDesktop])

  const handleSignOut = () => {
    setMenuAnchor(null)
    logout()
    navigate('/login', { replace: true })
  }

  const displayName = user?.name || user?.email || 'Signed in'

  return (
    <Box sx={{ minHeight: '100vh', backgroundColor: color.canvas }}>
      <SkipLink />

      <AppBar
        component="header"
        position="fixed"
        sx={{ zIndex: (t) => t.zIndex.drawer + 1, height: layout.topBarHeight }}
      >
        <Toolbar sx={{ minHeight: `${layout.topBarHeight}px !important`, gap: 1.5, px: { xs: 1.5, md: 2.5 } }}>
          {!isDesktop && (
            <IconButton
              edge="start"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileOpen}
              aria-controls="tnx-mobile-nav"
            >
              <FiMenu size={19} />
            </IconButton>
          )}

          <Box
            component={RouterLink}
            to="/dashboard"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              textDecoration: 'none',
              borderRadius: `${radius.sm}px`,
              '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: 2 },
            }}
            aria-label="ThreatNeXus — go to operations overview"
          >
            <BrandMark size={24} showWordmark />
          </Box>

          <Box
            sx={{
              display: { xs: 'none', lg: 'block' },
              ...type.caption,
              color: color.textFaint,
              borderLeft: `1px solid ${color.border}`,
              pl: 1.5,
              ml: 0.5,
            }}
          >
            Defensive research prototype
          </Box>

          <Box sx={{ flex: 1 }} />

          <Box
            component="button"
            type="button"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            aria-controls={menuAnchor ? 'tnx-account-menu' : undefined}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              px: 1,
              py: 0.6,
              background: 'transparent',
              border: `1px solid ${color.border}`,
              borderRadius: `${radius.sm}px`,
              color: color.text,
              cursor: 'pointer',
              font: 'inherit',
              '&:hover': { borderColor: color.borderStrong, backgroundColor: color.surfaceRaised },
              '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: 2 },
            }}
          >
            <Box sx={{ display: { xs: 'none', sm: 'block' }, fontSize: 13, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </Box>
            <RoleChip role={user?.role} />
            <FiChevronDown size={14} aria-hidden="true" />
          </Box>

          <Menu
            id="tnx-account-menu"
            anchorEl={menuAnchor}
            open={Boolean(menuAnchor)}
            onClose={() => setMenuAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            <Box sx={{ px: 2, py: 1.25, minWidth: 250 }}>
              <Box sx={{ ...type.bodyStrong, color: color.text }}>{displayName}</Box>
              {user?.email && user?.name && (
                <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.25 }}>{user.email}</Box>
              )}
              <Box sx={{ ...type.caption, color: color.textFaint, mt: 0.75 }}>
                {capabilities?.length || 0} capabilit{capabilities?.length === 1 ? 'y' : 'ies'} granted by the server
              </Box>
            </Box>
            <Divider />
            <MenuItem
              onClick={() => {
                setMenuAnchor(null)
                navigate('/profile')
              }}
            >
              <FiUser size={14} aria-hidden="true" style={{ marginRight: 10 }} />
              Profile and capabilities
            </MenuItem>
            <MenuItem onClick={handleSignOut}>
              <FiLogOut size={14} aria-hidden="true" style={{ marginRight: 10 }} />
              Sign out
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      {/* Navigation. Permanent on desktop; a focus-trapping temporary drawer
          below md, which MUI closes on Escape and restores focus from. */}
      {isDesktop ? (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              top: layout.topBarHeight,
              height: `calc(100% - ${layout.topBarHeight}px)`,
              backgroundColor: color.canvasAlt,
            },
          }}
        >
          <SidebarNav />
        </Drawer>
      ) : (
        <Drawer
          id="tnx-mobile-nav"
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH, backgroundColor: color.canvasAlt } }}
        >
          <Box sx={{ px: 2, py: 1.75, borderBottom: `1px solid ${color.border}` }}>
            <BrandMark size={22} showWordmark />
          </Box>
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </Drawer>
      )}

      <Box
        component="main"
        id={SKIP_TARGET_ID}
        // tabIndex -1 makes the skip link's target focusable, so activating the
        // link genuinely moves the caret rather than only scrolling.
        tabIndex={-1}
        sx={{
          ml: { xs: 0, md: `${DRAWER_WIDTH}px` },
          pt: `${layout.topBarHeight}px`,
          minHeight: '100vh',
          outline: 'none',
        }}
      >
        <Box
          sx={{
            maxWidth: layout.contentMaxWidth,
            mx: 'auto',
            px: { xs: 2, sm: 3, lg: 4 },
            py: { xs: 3, md: 4 },
            pb: { xs: 6, md: 8 },
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  )
}

export default AppShell

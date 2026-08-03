// The single MUI theme for ThreatNeXus, built from tokens.js.
//
// Everything a page previously did with a one-off `sx` literal is expressed
// here once: surfaces, hairlines, focus rings, table density, dialog chrome,
// input states. A page that still needs `sx` should be reaching for a token,
// not a hex code.
//
// Two rules this file exists to enforce:
//   1. Focus is ALWAYS visible. MUI's default focus treatment disappears
//      against a near-black canvas, so every interactive component gets an
//      explicit 2px ring offset from the canvas (shadow.focus).
//   2. Motion respects the user. Component transitions are short and are
//      switched off wholesale under prefers-reduced-motion by the global
//      CssBaseline override at the bottom.

import { createTheme } from '@mui/material/styles'
import { color, font, type, radius, shadow, layout, breakpoint, motion } from './tokens'

const focusRing = {
  outline: 'none',
  boxShadow: shadow.focus,
}

export const theme = createTheme({
  breakpoints: {
    values: {
      xs: breakpoint.xs,
      sm: breakpoint.sm,
      md: breakpoint.md,
      lg: breakpoint.lg,
      xl: breakpoint.xl,
    },
  },

  shape: { borderRadius: radius.md },

  palette: {
    mode: 'dark',
    primary: { main: color.accent, dark: color.accentQuiet, contrastText: color.textInverse },
    secondary: { main: color.link, contrastText: color.textInverse },
    background: { default: color.canvas, paper: color.surface },
    divider: color.border,
    text: { primary: color.text, secondary: color.textMuted, disabled: color.textFaint },
    error: { main: color.danger },
    warning: { main: color.warning },
    info: { main: color.info },
    success: { main: color.success },
  },

  typography: {
    fontFamily: font.ui,
    // Base is 14px: analyst density without shrinking body copy below the
    // comfortable reading floor.
    fontSize: 14,
    htmlFontSize: 16,
    h1: type.displayLg,
    h2: type.display,
    h3: type.sectionTitle,
    h4: { ...type.bodyStrong, fontSize: '0.9375rem' },
    h5: type.bodyStrong,
    h6: type.bodyStrong,
    body1: type.body,
    body2: type.small,
    caption: type.caption,
    overline: type.label,
    button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
  },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':root': {
          colorScheme: 'dark',
        },
        body: {
          backgroundColor: color.canvas,
          color: color.text,
          fontFamily: font.ui,
          // Stops iOS/Android from inflating text in landscape, which would
          // silently break the density this layout is tuned for.
          textSizeAdjust: '100%',
          WebkitFontSmoothing: 'antialiased',
        },
        // A single global honouring of the user's OS setting. Individual
        // components still check useReducedMotion() when they need to take a
        // genuinely different code path (e.g. skip a GSAP timeline rather than
        // run it at zero duration), but nothing decorative survives this.
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.001ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.001ms !important',
            scrollBehavior: 'auto !important',
          },
        },
        '::selection': { background: color.accent, color: color.textInverse },
        '::-webkit-scrollbar': { width: 10, height: 10 },
        '::-webkit-scrollbar-track': { background: color.canvas },
        '::-webkit-scrollbar-thumb': {
          background: color.border,
          borderRadius: radius.pill,
          border: `2px solid ${color.canvas}`,
        },
        '::-webkit-scrollbar-thumb:hover': { background: color.borderStrong },
      },
    },

    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: color.surface,
        },
        outlined: { border: `1px solid ${color.border}` },
      },
    },

    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundColor: color.surface,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          boxShadow: shadow.panel,
        },
      },
    },

    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: radius.sm,
          fontWeight: 600,
          transition: `background-color ${motion.fast}ms ${motion.ease}, border-color ${motion.fast}ms ${motion.ease}`,
          '&:focus-visible': focusRing,
        },
        sizeSmall: { padding: '4px 12px', fontSize: '0.8125rem' },
        sizeMedium: { padding: '7px 16px' },
        containedPrimary: {
          backgroundColor: color.accent,
          color: color.textInverse,
          '&:hover': { backgroundColor: color.accentHover },
        },
        outlined: {
          borderColor: color.borderStrong,
          color: color.text,
          '&:hover': { borderColor: color.accent, backgroundColor: 'rgba(49, 199, 180, 0.08)' },
        },
        text: { color: color.link, '&:hover': { backgroundColor: 'rgba(90, 182, 217, 0.1)' } },
      },
    },

    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: radius.sm,
          color: color.textMuted,
          '&:hover': { color: color.text, backgroundColor: color.surfaceRaised },
          '&:focus-visible': focusRing,
        },
      },
    },

    MuiLink: {
      defaultProps: { underline: 'hover' },
      styleOverrides: {
        root: {
          color: color.link,
          '&:hover': { color: color.linkHover },
          '&:focus-visible': { ...focusRing, borderRadius: 2 },
        },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: radius.sm,
          fontWeight: 600,
          fontSize: '0.75rem',
          height: 24,
          '&:focus-visible': focusRing,
        },
        outlined: { borderColor: color.borderStrong, color: color.textMuted },
      },
    },

    // Tables carry the evidence. They are the densest thing in the product and
    // the least tolerant of decoration.
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: `1px solid ${color.border}`,
          padding: '13px 16px',
          fontSize: '0.8125rem',
        },
        head: {
          ...type.label,
          color: color.textFaint,
          backgroundColor: color.surfaceSunken,
          borderBottom: `1px solid ${color.borderStrong}`,
          padding: '10px 16px',
          whiteSpace: 'nowrap',
        },
      },
    },

    MuiTableRow: {
      styleOverrides: {
        root: {
          '&:last-child td': { borderBottom: 'none' },
          '&:hover': { backgroundColor: 'rgba(90, 182, 217, 0.04)' },
        },
      },
    },

    MuiTableContainer: {
      styleOverrides: {
        // Dense evidence scrolls horizontally inside its own container rather
        // than being hidden or truncated on narrow screens. Critical evidence
        // is never dropped to make a phone layout fit.
        root: { overflowX: 'auto' },
      },
    },

    MuiTablePagination: {
      styleOverrides: {
        root: { borderTop: `1px solid ${color.border}`, color: color.textMuted },
      },
    },

    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: color.surfaceSunken,
          borderRadius: radius.sm,
          fontSize: '0.875rem',
          '& .MuiOutlinedInput-notchedOutline': { borderColor: color.border },
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: color.borderStrong },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: color.borderFocus,
            borderWidth: 2,
          },
          '&.Mui-error .MuiOutlinedInput-notchedOutline': { borderColor: color.danger },
        },
        input: { padding: '11px 13px' },
      },
    },

    MuiInputLabel: {
      styleOverrides: {
        root: { color: color.textMuted, '&.Mui-focused': { color: color.borderFocus } },
      },
    },

    MuiFormHelperText: {
      styleOverrides: {
        root: { marginLeft: 2, fontSize: '0.75rem', '&.Mui-error': { color: color.danger } },
      },
    },

    MuiSelect: {
      styleOverrides: { icon: { color: color.textMuted } },
    },

    MuiMenu: {
      styleOverrides: {
        paper: {
          backgroundColor: color.surfaceRaised,
          border: `1px solid ${color.border}`,
          boxShadow: shadow.overlay,
          borderRadius: radius.md,
        },
      },
    },

    MuiMenuItem: {
      styleOverrides: {
        root: {
          fontSize: '0.8125rem',
          '&:focus-visible': { ...focusRing, boxShadow: `inset 0 0 0 2px ${color.borderFocus}` },
        },
      },
    },

    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: color.surface,
          border: `1px solid ${color.borderStrong}`,
          borderRadius: radius.lg,
          boxShadow: shadow.overlay,
          backgroundImage: 'none',
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: { root: { ...type.sectionTitle, padding: '20px 24px 8px' } },
    },
    MuiDialogContent: { styleOverrides: { root: { padding: '8px 24px 16px' } } },
    MuiDialogActions: {
      styleOverrides: { root: { padding: '12px 24px 20px', gap: 8 } },
    },

    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: color.canvasAlt,
          borderRight: `1px solid ${color.border}`,
          backgroundImage: 'none',
        },
      },
    },

    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'transparent' },
      styleOverrides: {
        root: {
          backgroundColor: color.canvasAlt,
          borderBottom: `1px solid ${color.border}`,
          backgroundImage: 'none',
        },
      },
    },

    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 42, borderBottom: `1px solid ${color.border}` },
        indicator: { backgroundColor: color.accent, height: 2 },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 42,
          textTransform: 'none',
          fontSize: '0.8125rem',
          fontWeight: 600,
          color: color.textMuted,
          '&.Mui-selected': { color: color.text },
          '&:focus-visible': focusRing,
        },
      },
    },

    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: radius.md, border: '1px solid', fontSize: '0.8125rem', alignItems: 'flex-start' },
        standardError: { backgroundColor: color.dangerQuiet, borderColor: color.danger, color: color.text },
        standardWarning: { backgroundColor: color.warningQuiet, borderColor: color.warning, color: color.text },
        standardInfo: { backgroundColor: color.infoQuiet, borderColor: color.info, color: color.text },
        standardSuccess: { backgroundColor: color.successQuiet, borderColor: color.success, color: color.text },
      },
    },

    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: color.surfaceRaised,
          border: `1px solid ${color.borderStrong}`,
          color: color.text,
          fontSize: '0.75rem',
          borderRadius: radius.sm,
          padding: '6px 10px',
        },
        arrow: { color: color.surfaceRaised },
      },
    },

    MuiSkeleton: {
      defaultProps: { animation: 'wave' },
      styleOverrides: {
        root: { backgroundColor: color.surfaceRaised, borderRadius: radius.sm },
      },
    },

    MuiLinearProgress: {
      styleOverrides: {
        root: { height: 6, borderRadius: radius.pill, backgroundColor: color.surfaceSunken },
        bar: { borderRadius: radius.pill },
      },
    },

    MuiDivider: { styleOverrides: { root: { borderColor: color.border } } },

    MuiBreadcrumbs: {
      styleOverrides: {
        root: { fontSize: '0.8125rem', color: color.textMuted },
        separator: { color: color.textFaint, marginLeft: 6, marginRight: 6 },
      },
    },

    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: radius.sm,
          '&:focus-visible': { ...focusRing, boxShadow: `inset 0 0 0 2px ${color.borderFocus}` },
        },
      },
    },
  },
})

export { layout }
export default theme

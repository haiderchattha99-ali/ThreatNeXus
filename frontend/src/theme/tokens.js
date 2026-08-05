// ThreatNeXus design tokens — Phase 6.
//
// ONE source of truth for colour, type, spacing, radius, elevation and status
// semantics. Pages import from here (or from the MUI theme built on top of it);
// no page invents its own hex value. The Phase 5 and earlier screens scattered
// literals such as '#101723' and '#6ee7c7' across every file, which is why a
// single colour change previously meant editing a dozen components.
//
// Visual direction: "Modern Government CERT Operations", selected at the Phase
// 6 design checkpoint from three browser-rendered candidates. Document-like
// panels, institutional typography, generous air, provenance treated as
// first-class furniture rather than fine print.
//
// Locked constraints this file must keep satisfying:
//   - near-black, subtly green foundation
//   - restrained institutional green accents, never neon
//   - high contrast, readable analyst density
//   - status is NEVER communicated by colour alone (see STATUS_SEMANTICS: every
//     entry carries a label and an icon key as well as a colour)

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const color = {
  // Surfaces, darkest to lightest.
  canvas: '#070C0A',
  canvasAlt: '#0A1210',
  surface: '#0D1915',
  surfaceRaised: '#14251E',
  surfaceSunken: '#09120E',

  // Hairlines and dividers.
  border: '#20382F',
  borderStrong: '#315344',
  borderFocus: '#63D58E',

  // Text. `text` on `surface` measures ~13.9:1 and `textMuted` ~5.6:1.
  //
  // Phase 6.2 raised `textFaint` from #75899E. The old value cleared 4.5:1 on
  // `surface` (4.99:1) but fell to 4.44:1 on `surfaceRaised` — which is the
  // background behind every hover row and every sunken note, and is exactly
  // where small operational copy (timestamps, day captions, "not scored")
  // lands. The new value measures 5.33:1 on `surface` and 4.74:1 on
  // `surfaceRaised`, so it now clears 4.5:1 on EVERY surface in this palette
  // rather than on most of them.
  //
  // It is still reserved for supporting copy. A value a decision depends on
  // uses `textMuted` or `text`, whatever its size.
  text: '#EAF1F9',
  textMuted: '#9DAFC2',
  textFaint: '#7A8EA3',
  textInverse: '#06100A',

  // Accent. A lightened institutional green echoes the supplied PKCERT mark
  // while retaining enough contrast against the near-black operational shell.
  // Links use a quieter green-teal so actions and primary controls remain
  // distinguishable without introducing a second brand colour.
  accent: '#35C477',
  accentHover: '#55D28F',
  accentQuiet: '#123822',
  link: '#68BFA0',
  linkHover: '#87D2B5',

  // Semantic feedback. Chosen to stay distinguishable under the common
  // red/green colour-vision deficiencies — which is also why nothing in this
  // application relies on them alone.
  danger: '#F2617A',
  dangerQuiet: '#3A1620',
  warning: '#E8A33D',
  warningQuiet: '#3A2A12',
  success: '#4BCB92',
  successQuiet: '#103528',
  info: '#65ADD0',
  infoQuiet: '#122F3B',
  neutral: '#7C8AA0',
  neutralQuiet: '#1B2534',
}

// Risk v1 band colours. DELIBERATELY frozen and identical to what the design
// checkpoint compared: Risk v1 is a locked contract, so a visual refresh may
// change how a page is composed but never what CRITICAL looks like relative to
// HIGH. Order is the band order, lowest to highest.
export const RISK_BANDS = ['INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

export const riskBandColor = Object.freeze({
  CRITICAL: '#F2617A',
  HIGH: '#E8A33D',
  MEDIUM: '#65ADD0',
  LOW: '#35C477',
  INFORMATIONAL: '#7C8AA0',
})

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------
//
// IBM Plex Sans / IBM Plex Mono. Chosen at the design checkpoint: a technical,
// institutional family with real character (not Inter/Roboto/system-ui), whose
// mono cut is unusually good at the thing this application shows most — IPv4
// literals, ports, checksums, case and notification references.
//
// The families are loaded in index.css. Every stack below ends in a system
// fallback so a machine with no network still renders correct metrics.

export const font = {
  ui: "'IBM Plex Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace",
}

// A small, closed type scale. Anything not expressible here is a sign the
// layout is wrong, not that the scale needs another entry.
export const type = {
  displayLg: { fontSize: 'clamp(1.75rem, 2.6vw, 2.15rem)', fontWeight: 600, lineHeight: 1.15, letterSpacing: '-0.01em' },
  display: { fontSize: 'clamp(1.4rem, 2vw, 1.7rem)', fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.005em' },
  sectionTitle: { fontSize: '1.0625rem', fontWeight: 600, lineHeight: 1.35 },
  body: { fontSize: '0.875rem', fontWeight: 400, lineHeight: 1.6 },
  bodyStrong: { fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.55 },
  small: { fontSize: '0.8125rem', fontWeight: 400, lineHeight: 1.55 },
  caption: { fontSize: '0.75rem', fontWeight: 400, lineHeight: 1.5 },
  // The uppercase micro-label used for field names, table headers and section
  // eyebrows. Tracking is wide because uppercase at 11px is otherwise a wall.
  label: {
    fontSize: '0.6875rem',
    fontWeight: 600,
    lineHeight: 1.4,
    letterSpacing: '0.11em',
    textTransform: 'uppercase',
  },
  metric: { fontFamily: font.mono, fontSize: '2rem', fontWeight: 500, lineHeight: 1.05, letterSpacing: '-0.02em' },
  metricSm: { fontFamily: font.mono, fontSize: '1.375rem', fontWeight: 500, lineHeight: 1.1 },
  code: { fontFamily: font.mono, fontSize: '0.8125rem', fontWeight: 400, lineHeight: 1.5 },
}

// ---------------------------------------------------------------------------
// Space, radius, elevation, layout
// ---------------------------------------------------------------------------

// MUI's spacing factor is 8; these are the named steps the app actually uses.
export const space = { xs: 0.5, sm: 1, md: 2, lg: 3, xl: 4, xxl: 6 }

export const radius = { sm: 5, md: 9, lg: 13, pill: 999 }

// Shadows are deliberately quiet. On a near-black canvas a heavy drop shadow
// reads as smudge, not elevation — separation comes from the hairline border.
export const shadow = {
  none: 'none',
  panel: '0 1px 2px rgba(0, 0, 0, 0.4)',
  raised: '0 6px 20px -8px rgba(0, 0, 0, 0.65)',
  overlay: '0 24px 60px -18px rgba(0, 0, 0, 0.8)',
  focus: `0 0 0 2px ${color.canvas}, 0 0 0 4px ${color.borderFocus}`,
}

export const layout = {
  sidebarWidth: 248,
  sidebarCollapsedWidth: 72,
  topBarHeight: 60,
  contentMaxWidth: 1440,
  readableMaxWidth: 68, // ch — for prose blocks
}

// Breakpoints match MUI's defaults so `theme.breakpoints` and these agree.
export const breakpoint = { xs: 0, sm: 600, md: 900, lg: 1200, xl: 1536 }

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------
//
// Durations are short on purpose: this is an operational tool, and motion must
// never sit between an analyst and a decision. Every consumer must also honour
// prefers-reduced-motion — see hooks/useReducedMotion.js, which is the single
// place that question is answered.

export const motion = {
  instant: 90,
  fast: 160,
  base: 220,
  slow: 320,
  // The login opening timeline's total budget. The brief's window is
  // 1.5-2.5s; this sits deliberately at the short end.
  opening: 1800,
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
}

// ---------------------------------------------------------------------------
// Status semantics
// ---------------------------------------------------------------------------
//
// THE RULE: colour is never the only carrier. Every entry supplies a `label`
// (words) and an `icon` key (shape) alongside its `tone`. StatusBadge renders
// all three, so the same state is legible to a monochrome display, a
// colour-blind reader and a screen reader.
//
// `tone` names a semantic colour pair, not a literal, so a palette change can
// never leave one status hardcoded to an old hex.

const tone = (fg, bg) => ({ fg, bg })

export const TONES = Object.freeze({
  neutral: tone(color.neutral, color.neutralQuiet),
  info: tone(color.info, color.infoQuiet),
  accent: tone(color.accent, color.accentQuiet),
  success: tone(color.success, color.successQuiet),
  warning: tone(color.warning, color.warningQuiet),
  danger: tone(color.danger, color.dangerQuiet),
})

// Finding lifecycle (Prisma FindingStatus + occurrence-derived state).
export const FINDING_STATUS = Object.freeze({
  OPEN: { label: 'Open', tone: 'warning', icon: 'dot' },
  CLOSED: { label: 'Closed', tone: 'neutral', icon: 'check' },
})

// How a Finding came to be in its current shape. Derived from
// FindingOccurrence.action — see the dashboard controller, which is the only
// place these are counted.
export const FINDING_LIFECYCLE = Object.freeze({
  CREATED: { label: 'New', tone: 'info', icon: 'plus' },
  PERSISTED: { label: 'Persistent', tone: 'warning', icon: 'repeat' },
  RECURRED: { label: 'Recurred', tone: 'danger', icon: 'rotate' },
  HISTORICAL: { label: 'Historical', tone: 'neutral', icon: 'clock' },
})

// Case lifecycle (Prisma CaseLifecycleState).
export const CASE_STATE = Object.freeze({
  OPEN: { label: 'Open', tone: 'info', icon: 'dot' },
  WAITING_FOR_ORG: { label: 'Waiting for organization', tone: 'warning', icon: 'clock' },
  CLOSURE_PENDING: { label: 'Closure pending review', tone: 'accent', icon: 'gavel' },
  CLOSED: { label: 'Closed', tone: 'neutral', icon: 'check' },
})

// Notification lifecycle (Prisma NotificationLifecycleState).
export const NOTIFICATION_STATE = Object.freeze({
  DRAFT: { label: 'Draft', tone: 'neutral', icon: 'edit' },
  PENDING_REVIEW: { label: 'Pending review', tone: 'warning', icon: 'clock' },
  APPROVED: { label: 'Approved', tone: 'success', icon: 'check' },
  REJECTED: { label: 'Rejected', tone: 'danger', icon: 'cross' },
})

// Delivery observation (Prisma NotificationDeliveryStatus). These describe what
// a HUMAN reported after sending an exported artifact by hand — never anything
// this system did or observed itself.
export const DELIVERY_STATUS = Object.freeze({
  SENT_MANUALLY: { label: 'Sent manually', tone: 'info', icon: 'send' },
  DELIVERED: { label: 'Delivered', tone: 'success', icon: 'check' },
  FAILED: { label: 'Failed', tone: 'danger', icon: 'cross' },
  BOUNCED: { label: 'Bounced', tone: 'danger', icon: 'rotate' },
  UNKNOWN: { label: 'Unknown', tone: 'neutral', icon: 'question' },
})

// Ownership resolution confidence (Prisma OwnershipConfidence / status).
export const OWNERSHIP_CONFIDENCE = Object.freeze({
  CONFIRMED: { label: 'Confirmed', tone: 'success', icon: 'check' },
  HIGH: { label: 'High confidence', tone: 'accent', icon: 'dot' },
  MEDIUM: { label: 'Medium confidence', tone: 'info', icon: 'dot' },
  LOW: { label: 'Low confidence (ISP)', tone: 'warning', icon: 'dot' },
})

// ---------------------------------------------------------------------------
// Data availability
// ---------------------------------------------------------------------------
//
// The Phase 6 dashboard integrity contract. Every metric this application shows
// carries one of these, and the UI must render them DIFFERENTLY: an unavailable
// figure is never allowed to look like a zero, and a restricted figure is never
// allowed to look like an absent one.

export const AVAILABILITY = Object.freeze({
  // A real value was computed from a real query.
  AVAILABLE: { label: 'Available', tone: 'success', icon: 'check', showsValue: true },
  // The query ran and the answer is genuinely nothing. Distinct from
  // UNAVAILABLE: "we counted, and there are none".
  EMPTY: { label: 'No records yet', tone: 'neutral', icon: 'minus', showsValue: true },
  // We could not compute it. Renders as an em dash and a reason, NEVER as 0.
  UNAVAILABLE: { label: 'Unavailable', tone: 'warning', icon: 'warning', showsValue: false },
  // The caller's capabilities do not include reading this. Also never a zero.
  RESTRICTED: { label: 'Not available to your role', tone: 'neutral', icon: 'lock', showsValue: false },
  // A value exists but its source has not refreshed inside its freshness
  // window. Shown WITH the value and WITH the staleness, never silently.
  STALE: { label: 'Stale', tone: 'warning', icon: 'clock', showsValue: true },
  // Configured off. Distinct from unavailable: nothing is broken.
  DISABLED: { label: 'Disabled', tone: 'neutral', icon: 'power', showsValue: false },
  // Declared but never configured (e.g. no API key present).
  NOT_CONFIGURED: { label: 'Not configured', tone: 'neutral', icon: 'minus', showsValue: false },
})

export const TLP = Object.freeze({
  CLEAR: { label: 'TLP:CLEAR', fg: '#FFFFFF', bg: '#000000' },
  GREEN: { label: 'TLP:GREEN', fg: '#33FF00', bg: '#000000' },
  AMBER: { label: 'TLP:AMBER', fg: '#FFC000', bg: '#000000' },
  AMBER_STRICT: { label: 'TLP:AMBER+STRICT', fg: '#FFC000', bg: '#000000' },
  RED: { label: 'TLP:RED', fg: '#FF2B2B', bg: '#000000' },
})

export default {
  color,
  riskBandColor,
  RISK_BANDS,
  font,
  type,
  space,
  radius,
  shadow,
  layout,
  breakpoint,
  motion,
  TONES,
  FINDING_STATUS,
  FINDING_LIFECYCLE,
  CASE_STATE,
  NOTIFICATION_STATE,
  DELIVERY_STATUS,
  OWNERSHIP_CONFIDENCE,
  AVAILABILITY,
  TLP,
}

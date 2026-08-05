// The single place this application answers "may I animate?".
//
// Three inputs are folded into one boolean so no component has to remember all
// three:
//   1. the OS-level prefers-reduced-motion setting (authoritative)
//   2. a per-session opt-out the user can toggle in the UI
//   3. viewport width — ambient motion is reduced on small screens, where it
//      costs battery and attention for no analytical benefit
//
// The media query is subscribed to, not just read once: a user who changes the
// setting while the tab is open gets the new behaviour immediately.

import { useEffect, useState, useCallback } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'
export const MOTION_OPT_OUT_KEY = 'tnx.motion.reduced'
// Below this width, ambient/decorative motion is suppressed even when the user
// has expressed no preference.
const AMBIENT_MIN_WIDTH = 900

function readOptOut() {
  try {
    return window.localStorage.getItem(MOTION_OPT_OUT_KEY) === 'true'
  } catch {
    // Private mode / storage disabled. Failing towards "animate" is safe here
    // because the OS preference is checked independently below.
    return false
  }
}

function systemPrefersReduced() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(QUERY).matches
}

/**
 * @returns {boolean} true when motion must be suppressed.
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => systemPrefersReduced() || readOptOut())

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined

    const mql = window.matchMedia(QUERY)
    const sync = () => setReduced(mql.matches || readOptOut())

    // addEventListener is the modern API; addListener is kept for older
    // WebKit, which jsdom also still exposes in some versions.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', sync)
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(sync)
    }
    window.addEventListener('storage', sync)
    sync()

    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', sync)
      } else if (typeof mql.removeListener === 'function') {
        mql.removeListener(sync)
      }
      window.removeEventListener('storage', sync)
    }
  }, [])

  return reduced
}

/**
 * Ambient/decorative motion (the login network motif, hero shimmer). Stricter
 * than useReducedMotion: also off on narrow viewports.
 *
 * @returns {boolean} true when ambient motion is allowed.
 */
export function useAmbientMotionAllowed() {
  const reduced = useReducedMotion()
  const [wideEnough, setWideEnough] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= AMBIENT_MIN_WIDTH
  )

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setWideEnough(window.innerWidth >= AMBIENT_MIN_WIDTH)
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return !reduced && wideEnough
}

/** Lets the Settings screen offer an in-app reduced-motion switch. */
export function useMotionPreference() {
  const reduced = useReducedMotion()
  const [optOut, setOptOut] = useState(readOptOut)

  const setReducedMotion = useCallback((next) => {
    try {
      window.localStorage.setItem(MOTION_OPT_OUT_KEY, next ? 'true' : 'false')
    } catch {
      /* storage unavailable — the OS preference still applies */
    }
    setOptOut(next)
    // Same-tab listeners do not receive `storage`, so nudge them explicitly.
    window.dispatchEvent(new Event('storage'))
  }, [])

  return { reduced, optOut, systemReduced: systemPrefersReduced(), setReducedMotion }
}

export default useReducedMotion

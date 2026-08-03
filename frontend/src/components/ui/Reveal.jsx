// Reveal — a short entrance for summary panels.
//
// WHY THIS IS NOT SCROLL-LINKED (it was, and that was a bug)
// ---------------------------------------------------------
// The first implementation used GSAP ScrollTrigger with `once: true`, which is
// the conventional way to do reveal-on-scroll. Checking the real page in a
// browser showed why it is the wrong tool HERE: on the operations overview, six
// of fourteen sections were left at `opacity: 0` — permanently. Any layout
// change after ScrollTrigger computed its start positions (a zoom change, a
// late-loading webfont, a panel that grows when its data arrives, a refresh
// that was never issued) can leave a trigger that never fires, and a trigger
// that never fires means an analyst simply never sees that evidence.
//
// A decorative effect must not be able to hide operational content. So the
// reveal now runs once on mount, is not coupled to scroll position, and cannot
// strand anything: the element's resting state is fully visible, and GSAP only
// animates *from* a transparent offset toward that resting state. If the
// JavaScript never runs at all, the content is still there.
//
// The other constraints are unchanged:
//   - never wraps an evidence table (animating rows being read is prohibited)
//   - transform + opacity only, so the work stays on the compositor
//   - under prefers-reduced-motion, or the in-app opt-out, it renders its
//     children plainly and constructs no GSAP objects at all
//   - clearProps on completion, so no inline transform survives to interfere
//     with layout, focus scrolling or printing

import React from 'react'
import { Box } from '@mui/material'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { motion } from '../../theme/tokens'

gsap.registerPlugin(useGSAP)

// Bounded so a page with many panels does not end up with a visibly slow
// cascade — after this many, everything shares the last delay step.
const MAX_STAGGER_STEPS = 6
const STAGGER_STEP = 0.045

export function Reveal({ children, index = 0, y = 10, sx = {}, component = 'div' }) {
  const ref = React.useRef(null)
  const reduced = useReducedMotion()

  useGSAP(
    () => {
      if (reduced || !ref.current) return

      const delay = Math.min(index, MAX_STAGGER_STEPS) * STAGGER_STEP

      // fromTo, not from — and revert(), not kill().
      //
      // `gsap.from` records the element's current value as the END state and
      // immediately sets the START state. React StrictMode mounts effects
      // twice in development: the first tween sets opacity to 0, the cleanup
      // runs, and if that cleanup merely KILLS the tween the element is left
      // stranded at 0 forever. That is exactly what happened here — five
      // dashboard panels were invisible.
      //
      // `fromTo` states the end value explicitly, so it can never be inferred
      // from a mid-animation reading, and `revert()` restores the element's
      // original inline styles rather than freezing it wherever it had got to.
      const tween = gsap.fromTo(
        ref.current,
        { opacity: 0, y },
        {
          opacity: 1,
          y: 0,
          duration: motion.base / 1000,
          delay,
          ease: 'power2.out',
          // Leaves nothing behind on the element once it has played.
          clearProps: 'opacity,transform',
        }
      )

      return () => tween.revert()
    },
    { dependencies: [reduced, index, y], revertOnUpdate: true }
  )

  return (
    <Box ref={ref} component={component} sx={sx}>
      {children}
    </Box>
  )
}

export default Reveal

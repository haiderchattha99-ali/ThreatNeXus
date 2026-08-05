// The login opening motif: a small defensive network graph that draws itself in.
//
// What it is: brand motion. Nodes and links, abstract.
// What it is NOT, deliberately and permanently:
//   - live telemetry, threat counts, detections or provider health
//   - a map, or anything implying a geographic location
//   - a terminal, a log feed, or fabricated command output
// Nothing here is fed by data, and nothing here is labelled as if it were.
//
// Implementation notes (gsap-performance):
//   - node/label motion is transform + opacity only
//   - the link draw uses strokeDashoffset on eight short paths, which is the
//     standard line-draw technique and is cheap at this element count
//   - the ambient pulse is a single reused tween on one element, not a tween
//     per frame, and it pauses when the tab is hidden or the element scrolls
//     out of view
//   - useGSAP scopes every selector to this component and reverts all of it on
//     unmount, so navigating away leaves nothing running

import React from 'react'
import { Box } from '@mui/material'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { color } from '../theme/tokens'

gsap.registerPlugin(useGSAP)

// A fixed, hand-placed graph. Deterministic on purpose: a randomised layout
// would change on every render and read as "activity".
const NODES = [
  { id: 'core', x: 150, y: 130, r: 7, kind: 'core' },
  { id: 'a', x: 62, y: 66, r: 4.5 },
  { id: 'b', x: 244, y: 70, r: 4.5 },
  { id: 'c', x: 40, y: 196, r: 4.5 },
  { id: 'd', x: 258, y: 190, r: 4.5 },
  { id: 'e', x: 150, y: 30, r: 3.5 },
  { id: 'f', x: 150, y: 236, r: 3.5 },
  { id: 'g', x: 96, y: 148, r: 3 },
  { id: 'h', x: 208, y: 112, r: 3 },
]

const LINKS = [
  ['core', 'a'],
  ['core', 'b'],
  ['core', 'c'],
  ['core', 'd'],
  ['core', 'e'],
  ['core', 'f'],
  ['a', 'g'],
  ['b', 'h'],
]

const byId = Object.fromEntries(NODES.map((n) => [n.id, n]))

export function OpeningMotif({ animate = true, onComplete, size = 300 }) {
  const scope = React.useRef(null)

  useGSAP(
    () => {
      const links = gsap.utils.toArray('.tnx-link')
      const nodes = gsap.utils.toArray('.tnx-node')
      const rings = gsap.utils.toArray('.tnx-ring')

      // Reduced-motion / static path: put everything in its final state
      // immediately and create no timeline at all. Not "run it at duration 0" —
      // no animation objects are constructed.
      if (!animate) {
        gsap.set(links, { strokeDashoffset: 0, opacity: 0.75 })
        gsap.set(nodes, { opacity: 1, scale: 1 })
        gsap.set(rings, { opacity: 0.5, scale: 1 })
        if (onComplete) onComplete()
        return
      }

      links.forEach((path) => {
        const len = path.getTotalLength()
        gsap.set(path, { strokeDasharray: len, strokeDashoffset: len, opacity: 0.75 })
      })
      gsap.set(nodes, { opacity: 0, scale: 0.4, transformOrigin: 'center' })
      gsap.set(rings, { opacity: 0, scale: 0.75, transformOrigin: 'center' })

      // Total ≈ 1.65s, inside the 1.5-2.5s budget and at the short end of it.
      const tl = gsap.timeline({
        defaults: { ease: 'power2.out' },
        onComplete: () => {
          if (onComplete) onComplete()
        },
      })

      tl.addLabel('start', 0)
        .to('.tnx-core-node', { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(1.6)' }, 'start')
        .to(rings, { opacity: 0.45, scale: 1, duration: 0.7, stagger: 0.12 }, 'start+=0.15')
        .to(links, { strokeDashoffset: 0, duration: 0.75, stagger: 0.07 }, 'start+=0.3')
        .to(
          '.tnx-leaf-node',
          { opacity: 1, scale: 1, duration: 0.35, stagger: 0.05, ease: 'back.out(2)' },
          'start+=0.62'
        )

      // Ambient pulse: ONE reused tween travelling the core→a link, well after
      // the opening has settled. Slow, low-contrast, and easy to ignore — it
      // exists to stop the panel feeling like a screenshot, not to draw the eye.
      const pulse = gsap.fromTo(
        '.tnx-pulse',
        { opacity: 0, x: byId.core.x, y: byId.core.y },
        {
          opacity: 0.9,
          x: byId.a.x,
          y: byId.a.y,
          duration: 2.4,
          ease: 'sine.inOut',
          repeat: -1,
          repeatDelay: 2.2,
          yoyo: false,
          paused: true,
          onRepeat() {
            gsap.set('.tnx-pulse', { opacity: 0 })
          },
        }
      )
      tl.add(() => pulse.play(), '+=0.2')

      // Stop off-screen and background work (gsap-performance: "pause or kill
      // off-screen or inactive animations").
      const onVisibility = () => {
        if (document.hidden) pulse.pause()
        else pulse.resume()
      }
      document.addEventListener('visibilitychange', onVisibility)

      let observer
      if (typeof IntersectionObserver === 'function' && scope.current) {
        observer = new IntersectionObserver(
          ([entry]) => {
            if (entry.isIntersecting) pulse.resume()
            else pulse.pause()
          },
          { threshold: 0.05 }
        )
        observer.observe(scope.current)
      }

      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        if (observer) observer.disconnect()
        pulse.kill()
      }
    },
    { scope, dependencies: [animate], revertOnUpdate: true }
  )

  return (
    <Box
      ref={scope}
      // Decorative. A screen reader is told nothing about it, because there is
      // nothing here to know.
      aria-hidden="true"
      sx={{ width: '100%', maxWidth: size, mx: 'auto', willChange: 'transform' }}
    >
      <Box component="svg" viewBox="0 0 300 266" sx={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id="tnxCoreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={color.accent} stopOpacity="0.45" />
            <stop offset="100%" stopColor={color.accent} stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Concentric rings — a radar/perimeter suggestion, not a radar sweep. */}
        {[46, 78, 110].map((r) => (
          <circle
            key={r}
            className="tnx-ring"
            cx={byId.core.x}
            cy={byId.core.y}
            r={r}
            fill="none"
            stroke={color.borderStrong}
            strokeWidth="1.1"
            strokeDasharray="2 7"
          />
        ))}

        <circle cx={byId.core.x} cy={byId.core.y} r="52" fill="url(#tnxCoreGlow)" />

        {LINKS.map(([from, to]) => {
          const a = byId[from]
          const b = byId[to]
          return (
            <line
              key={`${from}-${to}`}
              className="tnx-link"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={color.link}
              strokeWidth="1.4"
              strokeLinecap="round"
              // getTotalLength works on <line> in all target browsers; the
              // dash values are set by GSAP above.
              pathLength={undefined}
            />
          )
        })}

        {NODES.map((n) => (
          <circle
            key={n.id}
            className={`tnx-node ${n.kind === 'core' ? 'tnx-core-node' : 'tnx-leaf-node'}`}
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.kind === 'core' ? color.accent : color.surfaceRaised}
            stroke={n.kind === 'core' ? color.accent : color.link}
            strokeWidth={n.kind === 'core' ? 0 : 1.6}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          />
        ))}

        {/* The single ambient element. Positioned by GSAP via x/y transforms. */}
        <circle className="tnx-pulse" cx="0" cy="0" r="2.6" fill={color.accent} opacity="0" />
      </Box>
    </Box>
  )
}

export default OpeningMotif

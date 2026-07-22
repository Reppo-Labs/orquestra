import { useRef, useState, type CSSProperties, type ReactNode } from 'react'

// Small ⓘ affordance with a hover/focus tooltip bubble. Keyboard-reachable
// (tabIndex 0) and screen-reader labelled. Reveal is pure CSS (see .tip in
// styles.css); on reveal we clamp the bubble inside the viewport — it centers
// on the trigger, so near a screen edge half of it would otherwise be clipped
// (worst on mobile). --tip-shift moves the bubble; the arrow counter-shifts to
// keep pointing at the trigger.
export function Tip({ children, label = 'more info' }: { children: ReactNode; label?: string }) {
  const bubble = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)

  // The bubble is visibility:hidden (not display:none) when closed, so it has
  // a rect to measure. Re-runs per reveal: the rect includes the current shift,
  // so an already-fitting bubble measures dx = 0 and state stays put.
  const clamp = () => {
    const b = bubble.current
    if (!b) return
    const pad = 8
    // Clip bounds = viewport ∩ nearest overflow-clipping ancestor: inside a modal,
    // drawer, or panel-box (all scroll containers) the bubble clips at THAT edge,
    // not the viewport's.
    let min = pad
    let max = window.innerWidth - pad
    for (let el = b.parentElement; el; el = el.parentElement) {
      const o = getComputedStyle(el)
      if (o.overflow !== 'visible' || o.overflowX !== 'visible' || o.overflowY !== 'visible') {
        const cr = el.getBoundingClientRect()
        min = Math.max(min, cr.left + pad)
        max = Math.min(max, cr.right - pad)
        break
      }
    }
    const r = b.getBoundingClientRect()
    const dx = r.left < min ? min - r.left : r.right > max ? max - r.right : 0
    if (dx !== 0) setShift((s) => s + dx)
  }

  return (
    <span className="tip" tabIndex={0} role="note" aria-label={label} onMouseEnter={clamp} onFocus={clamp}>
      <span aria-hidden="true" className="tip-mark">ⓘ</span>
      <span className="tip-bubble" ref={bubble} style={{ '--tip-shift': `${shift}px` } as CSSProperties}>{children}</span>
    </span>
  )
}

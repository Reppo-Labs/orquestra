import type { ReactNode } from 'react'

// Small ⓘ affordance with a hover/focus tooltip bubble. Keyboard-reachable
// (tabIndex 0) and screen-reader labelled. Pure CSS reveal — see .tip in styles.css.
export function Tip({ children, label = 'more info' }: { children: ReactNode; label?: string }) {
  return (
    <span className="tip" tabIndex={0} role="note" aria-label={label}>
      <span aria-hidden="true" className="tip-mark">ⓘ</span>
      <span className="tip-bubble">{children}</span>
    </span>
  )
}

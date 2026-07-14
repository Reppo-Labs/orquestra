import { useState } from 'react'
import type { ActivityRow, DatanetEntry, Health } from '../api'
import { Activity } from './Activity'
import { HealthTab } from './HealthTab'
import { LearningTab } from './LearningTab'

// Activity, reliability and learning are diagnostics, not a daily surface: an operator who
// is making money never needs them, and one who is not needs the Datanets tab first. So
// they lose their top-level tabs and gather here — one click from Home's details disclosure
// and from the header. Nothing was deleted: the same three components, reached from a place
// that matches how often they are actually needed.

type Sub = 'activity' | 'health' | 'learning'

const SUBS: { id: Sub; label: string }[] = [
  { id: 'activity', label: 'Activity log' },
  { id: 'health', label: 'Reliability' },
  { id: 'learning', label: 'Learning' },
]

export function DiagnosticsTab({ activity, health, healthLoaded, datanets, netNames, onOpenPanel, onConfigChanged, onBack }: {
  activity: ActivityRow[]
  health: Health | null
  healthLoaded: boolean
  /** The configured datanets — the denominator for the coverage headline, shared with Home. */
  datanets: Record<string, DatanetEntry>
  netNames: Record<string, string>
  onOpenPanel: (r: ActivityRow) => void
  onConfigChanged: () => void
  onBack: () => void
}) {
  const [sub, setSub] = useState<Sub>('activity')
  return (
    <div key="diagnostics">
      <div className="diag-head">
        <button className="link-btn" onClick={onBack}>← Home</button>
        <div className="subtabs" role="tablist" aria-label="Diagnostics sections">
          {SUBS.map((s) => (
            <button
              key={s.id} role="tab" aria-selected={sub === s.id}
              className={`subtab ${sub === s.id ? 'active' : ''}`}
              onClick={() => setSub(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {sub === 'activity' && <Activity activity={activity} netNames={netNames} onOpenPanel={onOpenPanel} />}
      {sub === 'health' && (
        <HealthTab health={health} loaded={healthLoaded} datanets={datanets} activity={activity} netNames={netNames} />
      )}
      {sub === 'learning' && <LearningTab netNames={netNames} onConfigChanged={onConfigChanged} />}
    </div>
  )
}

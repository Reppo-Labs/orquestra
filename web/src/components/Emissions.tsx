import type { Snapshot } from '../api'
import { fmt } from '../lib/format'

export function Emissions({ snapshot }: { snapshot: Snapshot | null }) {
  const pods = snapshot?.emissionsDue.pods ?? []
  return (
    <div className="panel-box">
      <table>
        <thead><tr><th>Pod</th><th>Datanet</th><th>Epoch</th><th>REPPO</th></tr></thead>
        <tbody>
          {pods.length ? pods.map((e, i) => (
            <tr key={`${e.podId}-${e.epoch}-${i}`}>
              <td className="mono">{e.podId}</td><td>{e.datanetId}</td><td className="mono">{e.epoch}</td><td className="mono pos">{fmt(e.reppo)}</td>
            </tr>
          )) : <tr><td colSpan={4} className="empty">none — all claimed</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

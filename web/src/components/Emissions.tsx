import type { Snapshot } from '../api'
import { fmt } from '../lib/format'

export function Emissions({ snapshot }: { snapshot: Snapshot | null }) {
  const pods = snapshot?.emissionsDue.pods ?? []
  return (
    <>
      <h2>Claimable emissions</h2>
      <table>
        <thead><tr><th>Pod</th><th>Datanet</th><th>Epoch</th><th>REPPO</th></tr></thead>
        <tbody>
          {pods.length ? pods.map((e, i) => (
            <tr key={`${e.podId}-${e.epoch}-${i}`}>
              <td>{e.podId}</td><td>{e.datanetId}</td><td>{e.epoch}</td><td>{fmt(e.reppo)}</td>
            </tr>
          )) : <tr><td colSpan={4} className="muted">none — all claimed</td></tr>}
        </tbody>
      </table>
    </>
  )
}

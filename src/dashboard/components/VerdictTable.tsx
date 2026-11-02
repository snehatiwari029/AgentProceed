import type { MismatchResult } from '../../shared/schemas'
import { MatchBadge } from './Badges'

const dash = (v: string | null) => (v && v !== '' ? v : '–')

// Field | Grant | Merchant terms | Actual | Match | Cause | Next action / Who acts
export default function VerdictTable({ rows }: { rows: MismatchResult[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-dash-body">No line-by-line results were stored with this receipt.</p>
  }
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
          <thead data-tour="verdict-head">
            <tr className="border-b border-dash-edge text-xs uppercase tracking-wider text-dash-label">
              <th className="py-2 pr-4 font-semibold">Field</th>
              <th className="py-2 pr-4 font-semibold">Grant</th>
              <th className="py-2 pr-4 font-semibold">Merchant terms</th>
              <th className="py-2 pr-4 font-semibold">Actual</th>
              <th className="py-2 pr-4 font-semibold">Match</th>
              <th className="py-2 pr-4 font-semibold">Cause</th>
              <th className="py-2 font-semibold">Next action / Who acts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.field}-${i}`} data-field-key={r.key} className="border-b border-dash-edge align-top">
                <th scope="row" className="py-2 pr-4 font-semibold text-dash-ink">
                  {r.field}
                </th>
                <td className="py-2 pr-4">{dash(r.grant)}</td>
                <td className="py-2 pr-4">{dash(r.merchant_terms)}</td>
                <td className="py-2 pr-4">{dash(r.actual)}</td>
                <td className="py-2 pr-4 whitespace-nowrap">
                  <MatchBadge value={r.result} />
                </td>
                <td className="py-2 pr-4">{dash(r.cause)}</td>
                <td className="py-2">{dash(r.next_action_who)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-dash-label">Agent Receipt shows mismatch facts only; it does not decide liability and no network rule moves liability on this screen.</p>
    </div>
  )
}

import { DECISION_LABEL, type Decision, type MismatchResult } from '../../shared/schemas'

// Colour is never the only signal: every badge has text.
// The pre-fulfillment decision. Only these three values exist.
export function DecisionBadge({ value }: { value: Decision | null }) {
  if (!value) return <span className="text-xs font-semibold text-dash-label">No decision</span>
  const cls: Record<Decision, string> = {
    pass: 'border-dash-teal text-dash-teal',
    review_required: 'border-dash-attention text-dash-attention',
    hold_suspicion: 'border-dash-violation text-dash-violation',
  }
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-bold ${cls[value]}`}>{DECISION_LABEL[value]}</span>
}

export function MatchBadge({ value }: { value: MismatchResult['result'] }) {
  if (value === 'mismatch') {
    return <span className="font-bold text-dash-violation">✕ Mismatch</span>
  }
  if (value === 'match') {
    return <span className="font-semibold text-dash-teal">✓ Match</span>
  }
  if (value === 'cannot_determine') {
    return <span className="font-bold text-dash-attention">? Cannot determine — merchant review</span>
  }
  if (value === 'missing') {
    return <span className="font-bold text-dash-attention">⚠ Record missing</span>
  }
  return <span className="font-semibold text-dash-label">– Not specified</span>
}

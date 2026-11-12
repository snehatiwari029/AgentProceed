import { formatMoney } from '../../shared/format'

// A PayPal dispute that arrived through the verified PayPal webhook (paypal_dispute_records, read live). Read-only:
// the record is created and updated only by the paypal-webhook function, after PayPal's signature check.
export type WebhookDisputeRow = {
  paypal_dispute_id: string
  matched: boolean
  receipt_id: string | null
  order_ref: string | null
  paypal_order_id: string | null
  transaction_id: string | null
  reason: string | null
  status: string | null
  stage: string | null
  outcome: string | null
  amount_cents: number | null
  currency: string | null
  seller_response_due_date: string | null
  last_event_type: string | null
  created_at: string
  updated_at: string
}

const day = (v: string | null) => (v ? v.slice(0, 10) : null)

export default function WebhookDispute({ d }: { d: WebhookDisputeRow }) {
  return (
    <div className="mt-2 rounded-md border border-dash-edge bg-dash-card p-2 text-xs" data-testid="webhook-dispute" data-dispute={d.paypal_dispute_id}>
      <p className="font-semibold text-dash-ink">
        PayPal dispute received by webhook <span className="font-mono">{d.paypal_dispute_id}</span>
        {!d.matched && <span className="ml-2 rounded-full border border-dash-attention px-2 py-0.5 text-dash-attention">Unmatched</span>}
      </p>
      <p className="mt-1 text-dash-body">
        {d.status ?? 'status not given'}{d.stage ? ` · ${d.stage}` : ''}{d.outcome ? ` · outcome ${d.outcome}` : ''}
        {d.reason ? ` · ${d.reason}` : ''}
        {d.amount_cents !== null ? ` · ${formatMoney(d.amount_cents, d.currency ?? 'USD')}` : ''}
        {d.seller_response_due_date ? ` · response due ${day(d.seller_response_due_date)}` : ''}
      </p>
      <p className="mt-1 text-dash-label">
        {d.matched ? `Matched to order ${d.order_ref ?? '–'} by transaction ${d.transaction_id ?? '–'}.` : `No recorded PayPal payment for transaction ${d.transaction_id ?? '(none in the event)'}.`}
        {' '}Last event {d.last_event_type ?? '–'}, {day(d.updated_at)}. Signature verified with PayPal.
      </p>
    </div>
  )
}

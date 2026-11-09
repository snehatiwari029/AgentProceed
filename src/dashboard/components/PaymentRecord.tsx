import { useEffect, useState } from 'react'
import { supabase } from '../../shared/supabase'
import { formatMoney } from '../../shared/format'

// The PayPal Sandbox record for one order (PRD Amendment 10): every payment event chained for its grant, read live.
// Orders paid through the simulated demo checkout have none, and nothing is shown. A read error is shown plainly.
export type PaymentEventRow = {
  event: 'order_created' | 'captured' | 'capture_failed' | 'cancelled'
  paypal_order_id: string | null
  capture_id: string | null
  status: string | null
  amount_cents: number | null
  currency: string | null
  error: string | null
  created_at: string
  entry_hash: string
}

const LABEL: Record<PaymentEventRow['event'], string> = {
  order_created: 'PayPal order created',
  captured: 'Payment captured',
  capture_failed: 'Capture failed',
  cancelled: 'Cancelled by shopper',
}

export function paymentSummary(rows: PaymentEventRow[]): { headline: string; tone: 'ok' | 'attention' | 'violation' } | null {
  if (rows.length === 0) return null
  const captured = [...rows].reverse().find((r) => r.event === 'captured')
  if (captured) return { headline: `Paid in PayPal Sandbox (test money): ${captured.status ?? 'COMPLETED'}`, tone: captured.error ? 'attention' : 'ok' }
  const last = rows[rows.length - 1]
  if (last.event === 'capture_failed') return { headline: 'PayPal Sandbox payment failed. The order is recorded but not paid.', tone: 'violation' }
  if (last.event === 'cancelled') return { headline: 'Shopper cancelled on PayPal. The order is recorded but not paid.', tone: 'attention' }
  return { headline: 'Waiting for the shopper to approve on PayPal Sandbox.', tone: 'attention' }
}

export default function PaymentRecord({ grantId }: { grantId: string }) {
  const [state, setState] = useState<{ rows: PaymentEventRow[] } | { error: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!supabase) return
    supabase
      .from('payment_events')
      .select('event,paypal_order_id,capture_id,status,amount_cents,currency,error,created_at,entry_hash')
      .eq('grant_id', grantId)
      .order('chain_seq', { ascending: true })
      .then(
        ({ data, error }) => { if (!cancelled) setState(error ? { error: error.message } : { rows: (data ?? []) as PaymentEventRow[] }) },
        (e: unknown) => { if (!cancelled) setState({ error: e instanceof Error ? e.message : 'Network error' }) },
      )
    return () => { cancelled = true }
  }, [grantId])

  if (!state) return null
  if ('error' in state) return <p className="mt-3 text-xs text-dash-label">Payment record could not be read: {state.error}</p>
  const summary = paymentSummary(state.rows)
  if (!summary) return null
  const tone = summary.tone === 'ok' ? 'text-dash-teal' : summary.tone === 'violation' ? 'text-dash-violation' : 'text-dash-attention'
  return (
    <div className="mt-4 rounded-md border border-dash-edge p-3" data-testid="payment-record">
      <p className="text-xs font-semibold uppercase tracking-wider text-dash-label">Payment record · PayPal Sandbox</p>
      <p className={`mt-1 text-sm font-semibold ${tone}`}>{summary.headline}</p>
      <ul className="mt-2 space-y-1 text-xs text-dash-body">
        {state.rows.map((r) => (
          <li key={r.entry_hash} className="break-all">
            <span className="font-semibold text-dash-ink">{LABEL[r.event]}</span>
            {r.paypal_order_id && <> · PayPal order <span className="font-mono">{r.paypal_order_id}</span></>}
            {r.capture_id && <> · transaction <span className="font-mono">{r.capture_id}</span></>}
            {r.amount_cents !== null && <> · {formatMoney(r.amount_cents, r.currency ?? 'USD')}</>}
            {r.error && <span className="text-dash-attention"> · {r.error}</span>}
            <span className="block text-dash-label">Chained, entry hash {r.entry_hash}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-dash-label">
        Test money only. A captured payment does not change the order's check: the decision above stands.
      </p>
    </div>
  )
}

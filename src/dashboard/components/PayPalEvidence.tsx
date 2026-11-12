import { useEffect, useState } from 'react'
import type { Reply } from '../../../supabase/functions/paypal-disputes/run'
import type { DisputeSummary } from '../../../supabase/functions/paypal-disputes/paypal'
import { submitPayPalEvidence, paypalDisputeStatus } from '../paypalDisputes'

// "Submit evidence to PayPal (Sandbox)" for one order paid through PayPal Sandbox. The button calls the server, which
// finds the PayPal dispute on the order's transaction and submits the evidence when PayPal offers that action. The
// result is shown as PayPal returned it: submitted with the new status, not available yet, or the API error.
// An order whose evidence PayPal already accepted shows the recorded submission instead of the button, with the
// dispute's current status read live from PayPal.
const BTN = 'rounded-md border border-dash-teal px-3 py-1.5 text-sm font-semibold text-dash-teal hover:bg-dash-card-raised disabled:cursor-not-allowed disabled:opacity-50'

// One row of paypal_evidence_submissions (read-only in the browser).
export type EvidenceSubmission = {
  id: string
  receipt_id: string
  order_ref: string | null
  paypal_dispute_id: string
  paypal_order_id: string | null
  capture_id: string
  evidence_type: string
  receipt_hash: string
  dispute_reason: string | null
  stage_before: string | null
  status_before: string | null
  stage_after: string | null
  status_after: string | null
  dispute_state_after: string | null
  source: string
  submitted_at: string
}

function DisputeLine({ d, label }: { d: DisputeSummary; label: string }) {
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs md:grid-cols-[12rem_1fr]" data-testid="paypal-dispute-status">
      <dt className="text-dash-label">{label}</dt>
      <dd className="font-mono text-dash-ink">{d.dispute_id}</dd>
      <dt className="text-dash-label">Status</dt>
      <dd className="font-semibold text-dash-ink">{d.status ?? '–'}</dd>
      <dt className="text-dash-label">Lifecycle stage</dt>
      <dd className="text-dash-ink">{d.stage ?? '–'}{d.dispute_state ? ` · ${d.dispute_state}` : ''}</dd>
      <dt className="text-dash-label">PayPal reason</dt>
      <dd className="text-dash-ink">{d.reason ?? '–'}</dd>
      {d.amount && <><dt className="text-dash-label">Amount</dt><dd className="text-dash-ink">{d.amount} {d.currency ?? ''}</dd></>}
      {d.seller_response_due_date && <><dt className="text-dash-label">Seller response due</dt><dd className="text-dash-ink">{d.seller_response_due_date.slice(0, 10)}</dd></>}
      <dt className="text-dash-label">Actions PayPal offers</dt>
      <dd className="text-dash-body">{d.links.filter((l) => l !== 'self').join(', ') || 'none'}</dd>
    </dl>
  )
}

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function PayPalResult({ reply }: { reply: Reply }) {
  if (reply.type === 'error') {
    return (
      <div className="mt-3 rounded-md border border-dash-violation p-3 text-sm" role="alert" data-testid="paypal-evidence-error">
        <p className="font-semibold text-dash-violation">{reply.message}</p>
        {reply.paypal?.detail && <p className="mt-1 break-words text-xs text-dash-body">PayPal: {reply.paypal.detail}</p>}
        {reply.paypal?.attempts && reply.paypal.attempts.length > 0 && (
          <p className="mt-1 text-xs text-dash-label">Evidence types tried: {reply.paypal.attempts.map((a) => `${a.evidence_type} (${a.issue ?? a.status})`).join(', ')}</p>
        )}
        {reply.paypal?.dispute && <DisputeLine d={reply.paypal.dispute} label="PayPal dispute" />}
      </div>
    )
  }
  const r = reply.result
  if (r.outcome === 'status') return <DisputeLine d={r.dispute} label="PayPal dispute" />
  if (r.outcome === 'submitted') {
    return (
      <div className="mt-3 rounded-md border border-dash-teal p-3 text-sm" role="status" data-testid="paypal-evidence-submitted">
        <p className="font-semibold text-dash-teal">Evidence submitted to PayPal Sandbox ({r.attempts[r.attempts.length - 1]?.evidence_type}). PayPal accepted it.</p>
        <p className="mt-1 text-xs text-dash-body">Status before: {r.dispute_before.status ?? '–'} → now: {r.dispute.status ?? '–'}</p>
        {reply.type === 'paypal_evidence' && reply.record_error && <p className="mt-1 text-xs text-dash-attention">{reply.record_error}</p>}
        <DisputeLine d={r.dispute} label="PayPal dispute" />
      </div>
    )
  }
  if (r.outcome === 'no_dispute') {
    return <p className="mt-3 text-sm font-semibold text-dash-attention" role="status" data-testid="paypal-evidence-none">{r.message}</p>
  }
  return (
    <div className="mt-3 rounded-md border border-dash-attention p-3 text-sm" role="status" data-testid={`paypal-evidence-${r.outcome === 'not_available' ? 'not-available' : 'not-submitted'}`}>
      <p className="font-semibold text-dash-attention">{r.message}</p>
      <DisputeLine d={r.dispute} label="PayPal dispute" />
    </div>
  )
}

// The recorded submission, with the dispute's current status read live from PayPal (read-only call).
export function Submitted({ s, live }: { s: EvidenceSubmission; live: Reply | 'loading' | null }) {
  return (
    <div className="mt-3 rounded-md border border-dash-teal p-3 text-sm" role="status" data-testid="paypal-evidence-recorded">
      <p className="font-semibold text-dash-teal">Submitted — PayPal accepted this evidence.</p>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs md:grid-cols-[12rem_1fr]">
        <dt className="text-dash-label">Evidence type</dt>
        <dd className="font-mono text-dash-ink" data-testid="submitted-evidence-type">{s.evidence_type}</dd>
        <dt className="text-dash-label">Receipt hash</dt>
        <dd className="break-all font-mono text-dash-real" data-testid="submitted-receipt-hash">{s.receipt_hash}</dd>
        <dt className="text-dash-label">Submitted</dt>
        <dd className="text-dash-ink" data-testid="submitted-at">{when(s.submitted_at)}</dd>
        <dt className="text-dash-label">PayPal dispute</dt>
        <dd className="font-mono text-dash-ink">{s.paypal_dispute_id}</dd>
        <dt className="text-dash-label">At submission</dt>
        <dd className="text-dash-ink">{s.status_before ?? '–'} → {s.status_after ?? '–'}{s.stage_after ? ` (${s.stage_after})` : ''}</dd>
      </dl>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-dash-label">Current status with PayPal</p>
      {live === 'loading' && <p className="mt-1 text-xs text-dash-body" data-testid="paypal-live-loading">Reading the dispute from PayPal Sandbox…</p>}
      {live && live !== 'loading' && <PayPalResult reply={live} />}
      {s.source === 'backfill' && <p className="mt-2 text-xs text-dash-label">Recorded from PayPal&apos;s provide-evidence response after the submission.</p>}
    </div>
  )
}

export default function PayPalEvidence({ merchantId, receiptId, disputeId, orderRef, paypalOrderId, captureId, submission }: {
  merchantId: string; receiptId: string; disputeId?: string | null; orderRef: string | null; paypalOrderId: string | null; captureId: string
  submission?: EvidenceSubmission | null
}) {
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<Reply | null>(null)
  const [live, setLive] = useState<Reply | 'loading' | null>(null)

  // A recorded submission: read the dispute's current status from PayPal (read-only, sends nothing).
  useEffect(() => {
    if (!submission) return
    let cancelled = false
    setLive('loading')
    paypalDisputeStatus({ action: 'dispute_status', merchant_id: merchantId, receipt_id: receiptId }).then((r) => { if (!cancelled) setLive(r) })
    return () => { cancelled = true }
  }, [submission, merchantId, receiptId])

  const submit = async () => {
    setBusy(true); setReply(null)
    setReply(await submitPayPalEvidence({ action: 'submit_evidence', merchant_id: merchantId, receipt_id: receiptId, dispute_id: disputeId ?? null }))
    setBusy(false)
  }
  return (
    <div className="rounded-md border border-dash-edge p-3" data-testid="paypal-evidence" data-paypal-order={orderRef ?? undefined}>
      <p className="text-sm text-dash-body">
        Order <span className="font-semibold text-dash-real">{orderRef ?? '–'}</span>
        {paypalOrderId && <> · PayPal order <span className="font-mono text-dash-real">{paypalOrderId}</span></>}
        {' · '}transaction <span className="font-mono text-dash-real">{captureId}</span>
      </p>
      {submission ? (
        <Submitted s={submission} live={live} />
      ) : (
        <>
          <button type="button" className={`${BTN} mt-2`} onClick={submit} disabled={busy || (reply?.type === 'paypal_evidence' && reply.result.outcome === 'submitted')}>
            {busy ? 'Submitting to PayPal Sandbox…' : 'Submit evidence to PayPal (Sandbox)'}
          </button>
          {reply && <PayPalResult reply={reply} />}
        </>
      )}
    </div>
  )
}

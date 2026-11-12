import { useEffect, useState } from 'react'
import { supabase } from '../../shared/supabase'
import type { Reply } from '../../../supabase/functions/receipt-seal/seal'

// The receipt's seal, signed: the Ed25519 merchant signature over the seal (receipt_signatures, read live), the
// custom_id it is anchored to on the PayPal order ("ap1:" + seal), and a public verify that reads custom_id from live
// PayPal Sandbox, recomputes the receipt and checks the signature (receipt-seal function). Read-only here.
type SignatureRow = { seal_hash: string; signature: string; key_id: string; public_key: string; signed_at: string }

async function verifySeal(body: { paypal_order_id: string } | { receipt_id: string }): Promise<Reply> {
  const base = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!base || !key) return { type: 'error', message: 'Supabase is not configured.' }
  try {
    const res = await fetch(`${base}/functions/v1/receipt-seal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key }, body: JSON.stringify({ action: 'verify', ...body }),
    })
    const json = (await res.json().catch(() => null)) as Reply | null
    return json && typeof json === 'object' && 'type' in json ? json : { type: 'error', message: `The verify function answered HTTP ${res.status}.` }
  } catch {
    return { type: 'error', message: 'Could not reach the verify function.' }
  }
}

const BTN = 'rounded-md border border-dash-teal px-3 py-1.5 text-xs font-semibold text-dash-teal hover:bg-dash-card disabled:cursor-not-allowed disabled:opacity-50'

export default function ReceiptSeal({ receiptId, grantId, sealHash }: { receiptId: string; grantId: string; sealHash: string }) {
  const [sig, setSig] = useState<SignatureRow | null | 'loading' | { error: string }>('loading')
  const [ppOrder, setPpOrder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Reply | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!supabase) return
    // Same query shape as the other live reads on this page (select, eq, order); filtered here.
    supabase.from('receipt_signatures').select('seal_hash,signature,key_id,public_key,signed_at').eq('receipt_id', receiptId).order('signed_at', { ascending: true })
      .then(
        ({ data, error }) => { if (!cancelled) setSig(error ? { error: error.message } : ((data?.[0] as SignatureRow | undefined) ?? null)) },
        (e: unknown) => { if (!cancelled) setSig({ error: e instanceof Error ? e.message : 'Network error' }) },
      )
    supabase.from('payment_events').select('paypal_order_id,chain_seq').eq('grant_id', grantId).order('chain_seq', { ascending: true })
      .then(
        ({ data }) => {
          const ids = ((data ?? []) as { paypal_order_id: string | null }[]).map((r) => r.paypal_order_id).filter((x): x is string => !!x)
          if (!cancelled) setPpOrder(ids.at(-1) ?? null)
        },
        () => undefined,
      )
    return () => { cancelled = true }
  }, [receiptId, grantId])

  const run = async () => {
    setBusy(true); setResult(null)
    setResult(await verifySeal(ppOrder ? { paypal_order_id: ppOrder } : { receipt_id: receiptId }))
    setBusy(false)
  }

  if (sig === 'loading') return null
  return (
    <div className="mt-4 rounded-md border border-dash-edge p-3" data-testid="receipt-seal">
      <p className="text-xs font-semibold uppercase tracking-wider text-dash-label">Receipt seal · Ed25519 merchant signature</p>
      {'error' in (sig ?? {}) ? (
        <p className="mt-1 text-xs text-dash-label">Signature could not be read: {(sig as { error: string }).error}</p>
      ) : sig === null ? (
        <p className="mt-1 text-sm text-dash-body" data-testid="seal-unsigned">Not signed: this receipt was sealed before merchant signing was switched on.</p>
      ) : (
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs md:grid-cols-[11rem_1fr]">
          <dt className="text-dash-label">Seal (receipt hash)</dt>
          <dd className="break-all font-mono text-dash-real">{(sig as SignatureRow).seal_hash}</dd>
          <dt className="text-dash-label">Signature</dt>
          <dd className="break-all font-mono text-dash-ink" data-testid="seal-signature">{(sig as SignatureRow).signature}</dd>
          <dt className="text-dash-label">Merchant key</dt>
          <dd className="break-all font-mono text-dash-body">{(sig as SignatureRow).key_id} · public key {(sig as SignatureRow).public_key}</dd>
          <dt className="text-dash-label">PayPal custom_id</dt>
          <dd className="break-all font-mono text-dash-ink" data-testid="seal-custom-id">
            {ppOrder ? <>ap1:{sealHash} <span className="font-sans text-dash-label">(on PayPal order {ppOrder}, written before payment)</span></> : <span className="font-sans text-dash-label">No PayPal order: this order was not paid with PayPal Sandbox.</span>}
          </dd>
        </dl>
      )}
      {sig && !('error' in sig) && (
        <button type="button" className={`${BTN} mt-3`} onClick={run} disabled={busy}>
          {busy ? 'Verifying…' : ppOrder ? 'Verify against live PayPal Sandbox' : 'Verify signature'}
        </button>
      )}
      {result && <SealResult r={result} />}
    </div>
  )
}

export function SealResult({ r }: { r: Reply }) {
  if (r.type === 'error') return <p className="mt-2 text-sm font-semibold text-dash-violation" role="alert">{r.message}</p>
  if (r.type !== 'verify') return null
  const ok = r.result === 'match'
  return (
    <div className={`mt-3 rounded-md border p-3 text-xs ${ok ? 'border-dash-teal' : 'border-dash-violation'}`} role="status" data-testid="seal-verify-result">
      <p className={`text-sm font-semibold ${ok ? 'text-dash-teal' : 'text-dash-violation'}`}>
        {ok ? 'Match: the PayPal order carries this receipt\'s seal and the merchant signature verifies.' : 'Mismatch: at least one check failed.'}
      </p>
      {r.custom_id !== null && <p className="mt-1 break-all font-mono text-dash-body">Live PayPal custom_id: {r.custom_id}{r.paypal_status ? ` (order ${r.paypal_status})` : ''}</p>}
      <ul className="mt-2 space-y-1">
        {r.checks.map((c) => (
          <li key={c.key} className="break-all">
            <span className={`font-semibold ${c.ok ? 'text-dash-teal' : 'text-dash-violation'}`}>{c.ok ? '✓' : '✗'} {c.label}</span>
            <span className="text-dash-label"> · {c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

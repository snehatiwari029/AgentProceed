import type { Reply } from '../../supabase/functions/paypal-disputes/run'

// The Dispute page's "Submit evidence to PayPal (Sandbox)" calls the paypal-disputes edge function (publishable key
// only). Every PayPal call, and the PayPal client id and secret, stay on the server.
export type PayPalEvidenceRequest = { action: 'submit_evidence'; merchant_id: string; receipt_id: string; dispute_id?: string | null }

export async function submitPayPalEvidence(body: PayPalEvidenceRequest): Promise<Reply> {
  const base = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!base || !key) return { type: 'error', message: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.' }
  try {
    const res = await fetch(`${base}/functions/v1/paypal-disputes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as Reply | null
    if (json && typeof json === 'object' && 'type' in json) return json
    return { type: 'error', message: `The PayPal disputes function answered HTTP ${res.status}.` }
  } catch {
    return { type: 'error', message: 'Could not reach the PayPal disputes function. Check your connection and try again.' }
  }
}

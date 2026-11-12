// Supabase edge function: paypal-disputes (PayPal Sandbox Disputes API, for the Dispute page's submit button).
// Every PayPal call happens here, server-side, against api-m.sandbox.paypal.com only. The browser sends the merchant id
// and the order (receipt) id; it never sees PayPal credentials, tokens or URLs it could call itself.
// Deployed with verify_jwt = false: the demo dashboard calls it with the publishable key (not a JWT), like disputes.
// Secrets: PAYPAL_CLIENT_ID / PAYPAL_SECRET (the same Sandbox app as the Orders checkout in shopper-agent).
// Reads with the service role (receipt, dispute, payment_events and shipment of that one order). Writes only one
// paypal_evidence_submissions row, after PayPal accepted a submission.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { ROUTES, type PayPalDisputesDb } from './run.ts'
import { createPayPalDisputesClient } from './paypal.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

type Row = Record<string, unknown>
// deno-lint-ignore no-explicit-any
function createDb(db: any): PayPalDisputesDb {
  const one = async (q: Promise<{ data?: Row[]; error: { message: string } | null }>, what: string): Promise<Row | null> => {
    const r = await q
    if (r.error) throw new Error(`${what}: ${r.error.message}`)
    return r.data?.[0] ?? null
  }
  return {
    async merchant(id) {
      const r = await one(db.from('merchants').select('id,name').eq('id', id).limit(1), 'read merchant')
      return r ? { id: r.id as string, name: r.name as string } : null
    },
    receiptById: (merchantId, id) => one(db.from('receipts').select('*').eq('merchant_id', merchantId).eq('id', id).limit(1), 'read receipt'),
    disputeById: (id) => one(db.from('disputes').select('*').eq('id', id).limit(1), 'read dispute'),
    async paymentEvents(grantId) {
      const r = await db.from('payment_events').select('event,paypal_order_id,capture_id,status,chain_seq').eq('grant_id', grantId).order('chain_seq', { ascending: true })
      if (r.error) throw new Error(`read payment events: ${r.error.message}`)
      return (r.data ?? []) as Row[]
    },
    async recordSubmission(row) {
      const r = await db.from('paypal_evidence_submissions').insert(row).select('id,submitted_at').limit(1)
      if (r.error) throw new Error(`insert submission: ${r.error.message}`)
      return r.data[0] as { id: string; submitted_at: string }
    },
    shipment: (receiptId) => one(db.from('shipments').select('carrier,tracking_ref,shipped_on,delivered_on').eq('receipt_id', receiptId).limit(1), 'read shipment'),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return json({ type: 'error', message: 'POST only' }, 405)
  try {
    const text = await req.text()
    if (text.length > 4_000) return json({ type: 'error', message: 'Request too large.' }, 413)
    let body: Record<string, unknown>
    try { body = JSON.parse(text) } catch { return json({ type: 'error', message: 'Bad request' }, 400) }
    const run = typeof body.action === 'string' ? ROUTES[body.action] : undefined
    if (!run) return json({ type: 'error', message: `action must be one of: ${Object.keys(ROUTES).join(', ')}.` }, 400)
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) return json({ type: 'error', message: 'Server is missing its Supabase settings.' }, 500)
    const id = Deno.env.get('PAYPAL_CLIENT_ID')
    const secret = Deno.env.get('PAYPAL_SECRET')
    const reply = await run(body, {
      db: createDb(createClient(url, serviceKey, { auth: { persistSession: false } })),
      paypal: id && secret ? createPayPalDisputesClient(id, secret) : null,
    })
    // A PayPal answer (including "not available yet") is a 200; only a bad request or a PayPal error is not.
    return json(reply, reply.type === 'error' ? (reply.paypal ? 502 : 400) : 200)
  } catch (e) {
    console.error('paypal-disputes failure', e instanceof Error ? e.message : e)
    return json({ type: 'error', message: 'The PayPal disputes function could not finish. Please try again.' }, 500)
  }
})

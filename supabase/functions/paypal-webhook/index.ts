// Supabase edge function: paypal-webhook (PayPal Sandbox webhook dispute intake). Rules in webhook.ts.
// PayPal POSTs here; every request is verified with PayPal's verify-webhook-signature API (sandbox only) before
// anything is written beyond the log line. Deployed with verify_jwt = false: PayPal sends no Supabase JWT, and the
// PayPal signature check is the authentication.
// Secrets: PAYPAL_CLIENT_ID / PAYPAL_SECRET (the same Sandbox app as checkout) and PAYPAL_WEBHOOK_ID (the id PayPal shows
// for this webhook in Developer Dashboard > Sandbox > Webhooks). None of them is logged or returned.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { SIGNATURE_HEADERS, handleWebhook, type Match, type SignatureHeaders, type WebhookDb } from './webhook.ts'

const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Row = Record<string, unknown>
// deno-lint-ignore no-explicit-any
function createWebhookDb(db: any): WebhookDb {
  const must = (r: { error: { message: string } | null }, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`) }
  return {
    async logEvent(row) { must(await db.from('paypal_webhook_events').insert(row), 'log webhook') },
    async eventProcessed(eventId) {
      const r = await db.from('paypal_webhook_events').select('id').eq('event_id', eventId).eq('verification', 'SUCCESS').in('outcome', ['created', 'updated']).limit(1)
      must(r, 'read webhook log')
      return (r.data ?? []).length > 0
    },
    async matchTransaction(ids) {
      if (ids.length === 0) return null
      const p = await db.from('payment_events').select('grant_id,paypal_order_id,capture_id').eq('event', 'captured').in('capture_id', ids).limit(1)
      must(p, 'read payments')
      const pay = p.data?.[0] as Row | undefined
      if (!pay) return null
      const r = await db.from('receipts').select('id,merchant_id,order_ref').eq('grant_id', pay.grant_id).order('chain_seq', { ascending: true }).limit(1)
      must(r, 'read receipt')
      const rec = r.data?.[0] as Row | undefined
      return rec ? ({ receipt_id: rec.id, merchant_id: rec.merchant_id ?? null, order_ref: rec.order_ref ?? null, paypal_order_id: pay.paypal_order_id ?? null } as Match) : null
    },
    async disputeRecord(disputeId) {
      const r = await db.from('paypal_dispute_records').select('*').eq('paypal_dispute_id', disputeId).limit(1)
      must(r, 'read dispute record')
      return (r.data?.[0] as Row | undefined) ?? null
    },
    async insertDispute(row) { must(await db.from('paypal_dispute_records').insert(row), 'insert dispute record') },
    async updateDispute(disputeId, patch) { must(await db.from('paypal_dispute_records').update(patch).eq('paypal_dispute_id', disputeId), 'update dispute record') },
  }
}

// PayPal's verify-webhook-signature (sandbox). The event goes in exactly as received (raw body, not re-serialised).
function createVerifier(clientId: string, secret: string, webhookId: string) {
  return async (h: SignatureHeaders, rawBody: string): Promise<'SUCCESS' | 'FAILURE'> => {
    const t = await fetch(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
      method: 'POST', headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10_000),
    })
    const token = ((await t.json().catch(() => null)) as { access_token?: unknown } | null)?.access_token
    if (typeof token !== 'string') throw new Error(`PayPal Sandbox sign-in failed (${t.status})`)
    const head = JSON.stringify({
      auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'],
      transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: webhookId,
    })
    const r = await fetch(`${PAYPAL_SANDBOX_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: `${head.slice(0, -1)},"webhook_event":${rawBody}}`, signal: AbortSignal.timeout(15_000),
    })
    const out = (await r.json().catch(() => null)) as { verification_status?: unknown } | null
    if (!r.ok) throw new Error(`verify-webhook-signature returned ${r.status}`)
    return out?.verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE'
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, message: 'POST only' }, 405)
  try {
    const rawBody = await req.text()
    if (rawBody.length > 200_000) return json({ ok: false, message: 'Request too large.' }, 413)
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) return json({ ok: false, message: 'Server is missing its Supabase settings.' }, 500)
    const id = Deno.env.get('PAYPAL_CLIENT_ID')
    const secret = Deno.env.get('PAYPAL_SECRET')
    const webhookId = Deno.env.get('PAYPAL_WEBHOOK_ID')
    const headers = Object.fromEntries(SIGNATURE_HEADERS.map((h) => [h, req.headers.get(h) ?? ''])) as SignatureHeaders
    const out = await handleWebhook(rawBody, headers, {
      db: createWebhookDb(createClient(url, serviceKey, { auth: { persistSession: false } })),
      verify: id && secret && webhookId ? createVerifier(id, secret, webhookId) : null,
      now: () => new Date(),
    })
    return json(out.body, out.status)
  } catch (e) {
    console.error('paypal-webhook failure', e instanceof Error ? e.message : e)
    return json({ ok: false, message: 'The webhook could not be processed.' }, 500)
  }
})

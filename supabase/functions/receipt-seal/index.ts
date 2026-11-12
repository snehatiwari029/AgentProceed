// Supabase edge function: receipt-seal (Ed25519 merchant signature over the Agent Receipt seal, and its public verify).
// Rules in seal.ts. Deployed with verify_jwt = false: shopper-agent calls `seal` server-to-server, and `verify` /
// `public_key` are public by design (anyone can check a receipt against live PayPal Sandbox).
// Secrets: MERCHANT_ED25519_SEED (32-byte Ed25519 seed, 64 hex; set in Supabase > Edge Functions > Secrets, never in the
// repo or the browser), PAYPAL_CLIENT_ID / PAYPAL_SECRET (PayPal Sandbox, read-only GET of an order).
// Writes only receipt_signatures rows. Never changes a receipt, the chain or a verdict.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { ROUTES, merchantKeyFromSeed, type MerchantKey, type SealDb } from './seal.ts'

const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

type Row = Record<string, unknown>
// deno-lint-ignore no-explicit-any
function createSealDb(db: any): SealDb {
  const one = async (q: Promise<{ data?: Row[]; error: { message: string } | null }>, what: string): Promise<Row | null> => {
    const r = await q
    if (r.error) throw new Error(`${what}: ${r.error.message}`)
    return r.data?.[0] ?? null
  }
  const receiptForGrant = (grantId: string) => one(db.from('receipts').select('*').eq('grant_id', grantId).order('chain_seq', { ascending: true }).limit(1), 'read receipt')
  return {
    async receiptForSession(sessionId) {
      const g = await one(db.from('grants').select('id').eq('session_id', sessionId).order('chain_seq', { ascending: false }).limit(1), 'read grant')
      return g ? receiptForGrant(g.id as string) : null
    },
    receiptById: (id) => one(db.from('receipts').select('*').eq('id', id).limit(1), 'read receipt'),
    async receiptForPayPalOrder(paypalOrderId) {
      const p = await one(db.from('payment_events').select('grant_id').eq('paypal_order_id', paypalOrderId).limit(1), 'read payment')
      return p ? receiptForGrant(p.grant_id as string) : null
    },
    signatureFor: (receiptId) => one(db.from('receipt_signatures').select('*').eq('receipt_id', receiptId).limit(1), 'read signature'),
    async insertSignature(row) {
      const r = await db.from('receipt_signatures').insert(row)
      if (!r.error) return 'inserted'
      if (r.error.code === '23505') return 'exists' // unique receipt_id: already signed (a race)
      throw new Error(`insert signature: ${r.error.message}`)
    },
  }
}

// Read-only PayPal Sandbox order lookup (OAuth client credentials, then GET the order).
function createPayPalReader(clientId: string, secret: string) {
  return async (orderId: string) => {
    const t = await fetch(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
      method: 'POST', headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10_000),
    })
    const token = ((await t.json().catch(() => null)) as { access_token?: unknown } | null)?.access_token
    if (typeof token !== 'string') throw new Error(`PayPal Sandbox sign-in failed (${t.status})`)
    const r = await fetch(`${PAYPAL_SANDBOX_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    })
    if (r.status === 404) return { found: false, custom_id: null, status: null }
    const body = (await r.json().catch(() => null)) as { status?: unknown; purchase_units?: { custom_id?: unknown }[] } | null
    if (!r.ok) throw new Error(`PayPal Sandbox order lookup returned ${r.status}`)
    const cid = body?.purchase_units?.[0]?.custom_id
    return { found: true, custom_id: typeof cid === 'string' ? cid : null, status: typeof body?.status === 'string' ? body.status : null }
  }
}

let keyCache: { seed: string; key: MerchantKey } | null = null
async function merchantKey(): Promise<MerchantKey | null> {
  const seed = Deno.env.get('MERCHANT_ED25519_SEED')
  if (!seed) return null
  if (keyCache?.seed !== seed) keyCache = { seed, key: await merchantKeyFromSeed(seed) }
  return keyCache.key
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  try {
    let body: Record<string, unknown>
    if (req.method === 'GET') body = Object.fromEntries(new URL(req.url).searchParams)
    else if (req.method === 'POST') {
      const text = await req.text()
      if (text.length > 2_000) return json({ type: 'error', message: 'Request too large.' }, 413)
      try { body = JSON.parse(text) } catch { return json({ type: 'error', message: 'Bad request' }, 400) }
    } else return json({ type: 'error', message: 'GET or POST only' }, 405)
    const run = typeof body.action === 'string' ? ROUTES[body.action] : undefined
    if (!run) return json({ type: 'error', message: `action must be one of: ${Object.keys(ROUTES).join(', ')}.` }, 400)
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) return json({ type: 'error', message: 'Server is missing its Supabase settings.' }, 500)
    const ppId = Deno.env.get('PAYPAL_CLIENT_ID')
    const ppSecret = Deno.env.get('PAYPAL_SECRET')
    const reply = await run(body, {
      db: createSealDb(createClient(url, serviceKey, { auth: { persistSession: false } })),
      key: await merchantKey(),
      runAuditor: async (sessionId) => {
        await fetch(`${url}/functions/v1/auditor`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }), signal: AbortSignal.timeout(30_000),
        }).catch(() => undefined)
      },
      paypalCustomId: ppId && ppSecret ? createPayPalReader(ppId, ppSecret) : null,
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    return json(reply, reply.type === 'error' ? 400 : 200)
  } catch (e) {
    console.error('receipt-seal failure', e instanceof Error ? e.message : e)
    return json({ type: 'error', message: 'The receipt seal function could not finish. Please try again.' }, 500)
  }
})

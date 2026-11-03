// Supabase edge function: shopper-agent (the brain). Muse Spark runs here; the key lives only in the
// Supabase secret MODEL_API_KEY. Deployed with verify_jwt = false because the phone screen calls it with the
// publishable key (which is not a JWT). Abuse limits live in agent.ts (message count, length, model turns).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { respond, type Deps } from './agent.ts'
import { createStore } from './store.ts'
import { MISSING_KEY_MESSAGE, ModelCallError, ModelKeyMissingError, createMetaClient } from './model.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

// Supabase's edge runtime keeps a background promise alive after the response is sent.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined
const inBackground = (p: Promise<unknown>) => {
  try { if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p) } catch { /* the promise still runs */ }
}

// The same error replies for the JSON and the streamed answer.
function failure(e: unknown): { body: { type: 'error'; message: string }; status: number } {
  if (e instanceof ModelKeyMissingError) return { body: { type: 'error', message: MISSING_KEY_MESSAGE }, status: 500 }
  if (e instanceof ModelCallError) {
    console.error('model error', e.status, e.message)
    return { body: { type: 'error', message: 'Muse could not answer just now. Please try again.' }, status: 502 }
  }
  console.error('shopper-agent failure', e instanceof Error ? e.message : e)
  return { body: { type: 'error', message: 'Something went wrong. Please try again.' }, status: 500 }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return json({ type: 'error', message: 'POST only' }, 405)
  try {
    const text = await req.text()
    if (text.length > 30_000) return json({ type: 'error', message: 'Request too large.' }, 413)
    let body: unknown
    try { body = JSON.parse(text) } catch { return json({ type: 'error', message: 'Bad request' }, 400) }

    const model = createMetaClient(Deno.env.get('MODEL_API_KEY')) // throws a clear error if the secret is missing
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) return json({ type: 'error', message: 'Server is missing its Supabase settings.' }, 500)
    const db = createClient(url, serviceKey, { auth: { persistSession: false } })

    const deps: Deps = {
      model, store: createStore(db), now: () => new Date(), demoDate: Deno.env.get('DEMO_DATE') ?? null,
      newId: () => crypto.randomUUID(),
      // Tell the order system an order arrived (session id only). The reply is never read, and the customer's
      // confirmation does not wait for it: it runs in the background after the response is sent.
      onOrderReceived: (sessionId) => {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 30_000)
        const p = fetch(`${url}/functions/v1/auditor`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        }).then(() => undefined).finally(() => clearTimeout(timer))
        inBackground(p)
        return p
      },
      // The order system's read-only order-status function: session id in, order number out (nothing else).
      orderNumber: async (sessionId) => {
        const res = await fetch(`${url}/functions/v1/order-status`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }),
          signal: AbortSignal.timeout(8_000),
        })
        const out = (await res.json().catch(() => null)) as { order_number?: unknown } | null
        return typeof out?.order_number === 'string' ? out.order_number : null
      },
    }

    // The phone asks for a stream (Accept: application/x-ndjson): one {"type":"step"} line per "Muse is checking"
    // as it happens, then one {"type":"reply"} line. Anything else gets the plain JSON reply, as before.
    if ((req.headers.get('accept') ?? '').includes('application/x-ndjson')) {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(`${JSON.stringify(o)}\n`)) } catch { /* client went away */ } }
          deps.onStep = (line) => send({ type: 'step', text: line })
          try {
            send({ type: 'reply', reply: await respond(body, deps) })
          } catch (e) {
            send({ type: 'reply', reply: failure(e).body })
          }
          try { ctrl.close() } catch { /* already closed */ }
        },
      })
      return new Response(stream, { status: 200, headers: { ...cors, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
    }

    const reply = await respond(body, deps)
    return json(reply, reply.type === 'error' ? 400 : 200)
  } catch (e) {
    const f = failure(e)
    return json(f.body, f.status)
  }
})

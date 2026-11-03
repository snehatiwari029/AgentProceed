// Supabase edge function: order-status. The order system's read-only lookup of an order number by session id,
// used so the shopper's confirmation can show its order number once the order system has assigned it.
// Deployed with verify_jwt = false (called server-to-server by shopper-agent, like the auditor). It never writes.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { orderStatus } from './run.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ type: 'error', message: 'POST only' }, 405)
  try {
    const text = await req.text()
    if (text.length > 500) return json({ type: 'error', message: 'Request too large.' }, 413)
    let body: unknown
    try { body = JSON.parse(text) } catch { return json({ type: 'error', message: 'Bad request' }, 400) }
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) return json({ type: 'error', message: 'Server is missing its Supabase settings.' }, 500)
    const db = createClient(url, serviceKey, { auth: { persistSession: false } })
    const reply = await orderStatus(body, {
      async grantIdForSession(sessionId) {
        const { data, error } = await db.from('grants').select('id').eq('session_id', sessionId).limit(1)
        if (error) throw new Error(error.message)
        return (data?.[0]?.id as string | undefined) ?? null
      },
      async orderRefForGrant(grantId) {
        const { data, error } = await db.from('receipts').select('order_ref').eq('grant_id', grantId).limit(1)
        if (error) throw new Error(error.message)
        return (data?.[0]?.order_ref as string | null | undefined) ?? null
      },
    })
    return json(reply, reply.type === 'error' ? 400 : 200)
  } catch (e) {
    console.error('order-status failure', e instanceof Error ? e.message : e)
    return json({ type: 'error', message: 'Could not read the order status.' }, 500)
  }
})

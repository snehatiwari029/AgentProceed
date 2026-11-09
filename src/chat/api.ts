import type { AgentReply, PaymentReply } from './types'

// The phone screen talks to one place: the shopper-agent function. It sends the typed words and shows the answer.
export type AgentRequestBody = {
  messages: { role: 'user' | 'assistant'; text: string }[]
  session_id?: string | null
  draft?: unknown
  offers?: unknown[]
}

const endpoint = () => {
  const base = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  return base && key ? { url: `${base}/functions/v1/shopper-agent`, key } : null
}

const isReply = (v: unknown): v is AgentReply => !!v && typeof v === 'object' && 'type' in v

// Asks Muse. When the function streams (application/x-ndjson), each "Muse is checking" line is handed to onStep as it
// arrives, then the final reply is returned. A plain JSON answer works the same way, without live steps.
export async function askAgent(body: AgentRequestBody, onStep?: (line: string) => void): Promise<AgentReply> {
  const ep = endpoint()
  if (!ep) return { type: 'error', message: 'This screen is not connected yet.' }
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, application/json', apikey: ep.key },
      body: JSON.stringify(body),
    })
    const type = res.headers?.get?.('content-type') ?? ''
    if (type.includes('application/x-ndjson') && res.body) {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let reply: AgentReply | null = null
      const take = (line: string) => {
        if (!line.trim()) return
        const ev = JSON.parse(line) as { type?: string; text?: unknown; reply?: unknown }
        if (ev.type === 'step' && typeof ev.text === 'string') onStep?.(ev.text)
        if (ev.type === 'reply' && isReply(ev.reply)) reply = ev.reply
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (value) buf += dec.decode(value, { stream: true })
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          take(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          nl = buf.indexOf('\n')
        }
        if (done) break
      }
      take(buf)
      return reply ?? { type: 'error', message: 'Muse could not answer just now. Please try again.' }
    }
    const json = (await res.json().catch(() => null)) as unknown
    if (isReply(json)) return json
    return { type: 'error', message: 'Muse could not answer just now. Please try again.' }
  } catch {
    return { type: 'error', message: 'Could not reach Muse. Check your connection and try again.' }
  }
}

// The PayPal Sandbox step for this chat's own order: start (get the approval link), capture after approval, or cancel.
// The amount is never sent: the function charges the total it recorded for the order.
export async function payPal(
  action: 'paypal_start' | 'paypal_capture' | 'paypal_cancel',
  sessionId: string,
  paypalOrderId?: string,
): Promise<PaymentReply> {
  const ep = endpoint()
  if (!ep) return { type: 'error', message: 'This screen is not connected yet.' }
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ep.key },
      body: JSON.stringify({ action, session_id: sessionId, ...(paypalOrderId ? { paypal_order_id: paypalOrderId } : {}) }),
    })
    const json = (await res.json().catch(() => null)) as PaymentReply | null
    if (json && (json.type === 'payment' || json.type === 'error')) return json
    return { type: 'error', message: 'PayPal Sandbox could not be reached. Please try again.' }
  } catch {
    return { type: 'error', message: 'Could not reach the store. Check your connection and try again.' }
  }
}

// Only a PayPal page is ever opened from the phone.
export function isPayPalLink(u: unknown): u is string {
  if (typeof u !== 'string') return false
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && (url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'))
  } catch {
    return false
  }
}

// After an order: the order number, once the store has assigned it (null while it is still being assigned).
export async function orderNumber(sessionId: string): Promise<string | null> {
  const ep = endpoint()
  if (!ep) return null
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ep.key },
      body: JSON.stringify({ action: 'order_status', session_id: sessionId }),
    })
    const json = (await res.json().catch(() => null)) as { type?: string; order_number?: unknown } | null
    return json?.type === 'order_status' && typeof json.order_number === 'string' ? json.order_number : null
  } catch {
    return null
  }
}

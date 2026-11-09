// PayPal Sandbox checkout (PRD Amendment 10). Test money only: the base URL is fixed to PayPal's Sandbox, so this
// build cannot reach live PayPal. Plain REST calls (OAuth client credentials, Orders v2 create and capture).
// Pure TypeScript: fetch is injected, so tests run it without the network. The client id and secret come only from
// the Supabase edge-function secrets PAYPAL_CLIENT_ID and PAYPAL_SECRET (read by name in index.ts).

export const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'
export const PAYPAL_ENVIRONMENT = 'sandbox'
export const PAYPAL_RAIL = 'paypal_sandbox'
export const PAYPAL_LABEL = 'PayPal Sandbox (test money)'

// PayPal order ids are upper-case letters and digits.
export const PAYPAL_ORDER_ID = /^[A-Z0-9]{8,32}$/

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly issue: string | null) {
    super(message)
    this.name = 'PayPalError'
  }
}

export type CreatedOrder = { id: string; status: string; approveUrl: string }
export type CapturedOrder = {
  orderStatus: string
  captureId: string | null
  captureStatus: string | null
  amountCents: number | null
  currency: string | null
}

export interface PayPalClient {
  createOrder(input: {
    totalCents: number
    currency: string
    requestId: string
    referenceId: string
    description: string
    returnUrl: string
    cancelUrl: string
  }): Promise<CreatedOrder>
  captureOrder(orderId: string): Promise<CapturedOrder>
}

export const centsToValue = (cents: number) => (cents / 100).toFixed(2)
export function valueToCents(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d+(\.\d{1,2})?$/.test(v)) return null
  return Math.round(Number(v) * 100)
}

// Only an https link on paypal.com (the Sandbox approval page is www.sandbox.paypal.com) is ever handed to the phone.
export function isPayPalApproveUrl(u: unknown): u is string {
  if (typeof u !== 'string') return false
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && (url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'))
  } catch {
    return false
  }
}

const issueOf = (body: unknown): string | null => {
  const b = body as { details?: { issue?: unknown }[]; name?: unknown; error?: unknown } | null
  const issue = b?.details?.[0]?.issue ?? b?.name ?? b?.error
  return typeof issue === 'string' ? issue.slice(0, 80) : null
}

export function createPayPalClient(clientId: string, secret: string, fetchFn: FetchFn = fetch as unknown as FetchFn): PayPalClient {
  if (!clientId || !secret) throw new Error('PayPal Sandbox is not configured')
  let token: { value: string; until: number } | null = null

  async function accessToken(): Promise<string> {
    if (token && token.until > Date.now() + 60_000) return token.value
    const res = await fetchFn(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    if (!res.ok || typeof body?.access_token !== 'string') throw new PayPalError('PayPal Sandbox sign-in failed', res.status, issueOf(body))
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 300
    token = { value: body.access_token, until: Date.now() + ttl * 1000 }
    return token.value
  }

  async function call(path: string, payload: unknown, requestId: string): Promise<unknown> {
    const res = await fetchFn(`${PAYPAL_SANDBOX_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
        // Idempotency: the same request id returns the same PayPal result instead of a second order or capture.
        'PayPal-Request-Id': requestId,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new PayPalError(`PayPal Sandbox returned ${res.status}`, res.status, issueOf(body))
    return body
  }

  return {
    async createOrder(input) {
      if (!Number.isInteger(input.totalCents) || input.totalCents <= 0) throw new Error('Order total must be a positive number of cents')
      const body = (await call('/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: input.referenceId,
          custom_id: input.referenceId,
          description: input.description.slice(0, 127),
          amount: { currency_code: input.currency, value: centsToValue(input.totalCents) },
        }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Northwind Outfitters (demo)',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      }, input.requestId)) as { id?: unknown; status?: unknown; links?: { rel?: unknown; href?: unknown }[] } | null
      const id = body?.id
      const link = body?.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href
      if (typeof id !== 'string' || !PAYPAL_ORDER_ID.test(id)) throw new PayPalError('PayPal Sandbox returned no order id', 502, null)
      if (!isPayPalApproveUrl(link)) throw new PayPalError('PayPal Sandbox returned no approval link', 502, null)
      return { id, status: typeof body?.status === 'string' ? body.status : 'CREATED', approveUrl: link }
    },

    async captureOrder(orderId) {
      if (!PAYPAL_ORDER_ID.test(orderId)) throw new Error('Bad PayPal order id')
      const body = (await call(`/v2/checkout/orders/${orderId}/capture`, {}, `capture-${orderId}`)) as {
        status?: unknown
        purchase_units?: { payments?: { captures?: { id?: unknown; status?: unknown; amount?: { value?: unknown; currency_code?: unknown } }[] } }[]
      } | null
      const cap = body?.purchase_units?.[0]?.payments?.captures?.[0]
      return {
        orderStatus: typeof body?.status === 'string' ? body.status : 'UNKNOWN',
        captureId: typeof cap?.id === 'string' ? cap.id : null,
        captureStatus: typeof cap?.status === 'string' ? cap.status : null,
        amountCents: valueToCents(cap?.amount?.value),
        currency: typeof cap?.amount?.currency_code === 'string' ? cap.amount.currency_code : null,
      }
    },
  }
}

// The PayPal Sandbox step after an order (PRD Amendment 10). The phone asks the brain to start or finish the
// PayPal payment for its own session; the brain never takes an amount from the phone. The amount is the total the
// server recorded on the checkout action. Every PayPal result (order created, captured, failed, cancelled) is
// appended to the hash chain as a payment_events row, so the store's record carries the PayPal order id and
// capture id. A capture never changes the order record or its checks, and a failed or cancelled payment is never
// turned into a success.
import { PAYPAL_ENVIRONMENT, PAYPAL_ORDER_ID, PAYPAL_RAIL, PayPalError, isPayPalApproveUrl, type PayPalClient } from './paypal.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PaymentEventType = 'order_created' | 'captured' | 'capture_failed' | 'cancelled'

export type PaymentEvent = {
  event: PaymentEventType
  paypal_order_id: string | null
  capture_id: string | null
  status: string | null
  amount_cents: number | null
  currency: string | null
}

export type CheckoutRecord = { grantId: string; totalCents: number; currency: string; rail: string | null; productName: string | null }

export interface PaymentStore {
  checkoutFor(sessionId: string): Promise<CheckoutRecord | null>
  paymentEvents(sessionId: string): Promise<PaymentEvent[]>
  addPaymentEvent(row: Record<string, unknown>): Promise<void>
}

export type PayPalDeps = {
  client: PayPalClient
  store: PaymentStore
  // The site the shopper returns to after approving. Fixed by the server (SITE_URL), never taken from the request.
  siteUrl: string
  newId: () => string
}

export type PaymentReply =
  | {
    type: 'payment'
    session_id: string
    status: 'approval_needed' | 'captured' | 'failed' | 'cancelled'
    approve_url?: string
    paypal_order_id?: string
    capture_id?: string
    amount_cents?: number
    message?: string
  }
  | { type: 'error'; message: string }

export const NOT_SET_UP = 'PayPal Sandbox is not set up on this server yet.'

const latest = (events: PaymentEvent[], type: PaymentEventType) => [...events].reverse().find((e) => e.event === type) ?? null

const failureText = (e: unknown) => {
  if (e instanceof PayPalError) {
    if (e.issue === 'ORDER_NOT_APPROVED') return 'PayPal says this payment was not approved yet.'
    return `PayPal Sandbox could not complete the payment${e.issue ? ` (${e.issue})` : ''}.`
  }
  return 'PayPal Sandbox could not be reached. Please try again.'
}

async function record(deps: PayPalDeps, sessionId: string, grantId: string, ev: PaymentEvent & { error?: string | null }) {
  await deps.store.addPaymentEvent({
    id: deps.newId(), session_id: sessionId, grant_id: grantId, provider: 'paypal', environment: PAYPAL_ENVIRONMENT,
    event: ev.event, paypal_order_id: ev.paypal_order_id, capture_id: ev.capture_id, status: ev.status,
    amount_cents: ev.amount_cents, currency: ev.currency, error: ev.error ?? null,
  })
}

async function checkoutOf(raw: Record<string, unknown>, deps: PayPalDeps | undefined) {
  const sid = raw.session_id
  if (typeof sid !== 'string' || !UUID_RE.test(sid)) return { error: 'session_id is required.' } as const
  if (!deps) return { error: NOT_SET_UP } as const
  const checkout = await deps.store.checkoutFor(sid)
  if (!checkout) return { error: 'No order in this chat yet.' } as const
  if (checkout.rail !== PAYPAL_RAIL) return { error: 'This order was not placed with PayPal Sandbox.' } as const
  return { sid, checkout, events: await deps.store.paymentEvents(sid) } as const
}

// Starts the PayPal payment: creates (or re-reads) the Sandbox order for the recorded total and returns the approval link.
export async function startPayPal(raw: Record<string, unknown>, deps: PayPalDeps | undefined): Promise<PaymentReply> {
  const c = await checkoutOf(raw, deps)
  if ('error' in c) return { type: 'error', message: c.error as string }
  const d = deps as PayPalDeps
  const done = latest(c.events, 'captured')
  if (done) {
    return { type: 'payment', session_id: c.sid, status: 'captured', paypal_order_id: done.paypal_order_id ?? undefined, capture_id: done.capture_id ?? undefined, amount_cents: done.amount_cents ?? undefined }
  }
  const back = (state: 'return' | 'cancel') => `${d.siteUrl.replace(/\/+$/, '')}/chat?paypal=${state}&session=${c.sid}`
  try {
    // The same session always asks PayPal with the same request id, so a second tap returns the same PayPal order.
    const order = await d.client.createOrder({
      totalCents: c.checkout.totalCents, currency: c.checkout.currency, requestId: `ap-order-${c.sid}`, referenceId: c.sid,
      description: c.checkout.productName ? `Northwind Outfitters: ${c.checkout.productName}` : 'Northwind Outfitters order',
      returnUrl: back('return'), cancelUrl: back('cancel'),
    })
    if (!isPayPalApproveUrl(order.approveUrl)) return { type: 'error', message: 'PayPal Sandbox returned no approval link.' }
    const known = c.events.some((e) => e.event === 'order_created' && e.paypal_order_id === order.id)
    if (!known) {
      await record(d, c.sid, c.checkout.grantId, {
        event: 'order_created', paypal_order_id: order.id, capture_id: null, status: order.status,
        amount_cents: c.checkout.totalCents, currency: c.checkout.currency,
      })
    }
    return { type: 'payment', session_id: c.sid, status: 'approval_needed', approve_url: order.approveUrl, paypal_order_id: order.id, amount_cents: c.checkout.totalCents }
  } catch (e) {
    console.error('paypal create failed', e instanceof Error ? e.message : e)
    return { type: 'payment', session_id: c.sid, status: 'failed', message: failureText(e) }
  }
}

// Finishes the payment after the shopper approved it on PayPal: captures the order this session created, and only that one.
export async function capturePayPal(raw: Record<string, unknown>, deps: PayPalDeps | undefined): Promise<PaymentReply> {
  const c = await checkoutOf(raw, deps)
  if ('error' in c) return { type: 'error', message: c.error as string }
  const d = deps as PayPalDeps
  const token = raw.paypal_order_id
  if (typeof token !== 'string' || !PAYPAL_ORDER_ID.test(token)) return { type: 'error', message: 'paypal_order_id is required.' }
  const created = latest(c.events, 'order_created')
  if (!created || created.paypal_order_id !== token) return { type: 'error', message: 'This PayPal payment does not belong to the order in this chat.' }
  const done = latest(c.events, 'captured')
  if (done) {
    return { type: 'payment', session_id: c.sid, status: 'captured', paypal_order_id: token, capture_id: done.capture_id ?? undefined, amount_cents: done.amount_cents ?? undefined }
  }
  try {
    const cap = await d.client.captureOrder(token)
    if (cap.captureStatus !== 'COMPLETED' || !cap.captureId) {
      await record(d, c.sid, c.checkout.grantId, {
        event: 'capture_failed', paypal_order_id: token, capture_id: cap.captureId, status: cap.captureStatus ?? cap.orderStatus,
        amount_cents: cap.amountCents, currency: cap.currency, error: `Capture status ${cap.captureStatus ?? cap.orderStatus}`,
      })
      return { type: 'payment', session_id: c.sid, status: 'failed', paypal_order_id: token, message: `PayPal Sandbox reports the payment as ${cap.captureStatus ?? cap.orderStatus}.` }
    }
    await record(d, c.sid, c.checkout.grantId, {
      event: 'captured', paypal_order_id: token, capture_id: cap.captureId, status: cap.captureStatus,
      amount_cents: cap.amountCents, currency: cap.currency,
      error: cap.amountCents === c.checkout.totalCents ? null : `Captured amount differs from the recorded total (${c.checkout.totalCents} cents)`,
    })
    return { type: 'payment', session_id: c.sid, status: 'captured', paypal_order_id: token, capture_id: cap.captureId, amount_cents: cap.amountCents ?? undefined }
  } catch (e) {
    console.error('paypal capture failed', e instanceof Error ? e.message : e)
    await record(d, c.sid, c.checkout.grantId, {
      event: 'capture_failed', paypal_order_id: token, capture_id: null, status: null, amount_cents: null, currency: null,
      error: e instanceof PayPalError ? `${e.status}${e.issue ? ` ${e.issue}` : ''}` : 'network',
    })
    return { type: 'payment', session_id: c.sid, status: 'failed', paypal_order_id: token, message: failureText(e) }
  }
}

// The shopper came back from PayPal without approving. Recorded once; the order stays, unpaid.
export async function cancelPayPal(raw: Record<string, unknown>, deps: PayPalDeps | undefined): Promise<PaymentReply> {
  const c = await checkoutOf(raw, deps)
  if ('error' in c) return { type: 'error', message: c.error as string }
  const d = deps as PayPalDeps
  const created = latest(c.events, 'order_created')
  if (latest(c.events, 'captured')) return { type: 'error', message: 'This order is already paid.' }
  if (created && !latest(c.events, 'cancelled')) {
    await record(d, c.sid, c.checkout.grantId, {
      event: 'cancelled', paypal_order_id: created.paypal_order_id, capture_id: null, status: 'CANCELLED_BY_SHOPPER',
      amount_cents: null, currency: null,
    })
  }
  return { type: 'payment', session_id: c.sid, status: 'cancelled', message: 'PayPal payment cancelled. The order is recorded but not paid.' }
}

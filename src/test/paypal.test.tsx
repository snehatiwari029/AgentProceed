import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createPayPalClient, isPayPalApproveUrl, PAYPAL_SANDBOX_BASE, valueToCents, centsToValue, type PayPalClient } from '../../supabase/functions/shopper-agent/paypal'
import { cancelPayPal, capturePayPal, NOT_SET_UP, startPayPal, type CheckoutRecord, type PaymentEvent, type PaymentStore, type PayPalDeps } from '../../supabase/functions/shopper-agent/payment'
import { handle, respond, type AgentReply, type Deps, type ProductRow, type Store } from '../../supabase/functions/shopper-agent/agent'
import { OrderCard } from '../chat/Cards'
import type { OrderData } from '../chat/types'

const SID = '11111111-2222-4333-8444-555555555555'
const GRANT = '99999999-2222-4333-8444-555555555555'
const ORDER_ID = '5O190127TN364715T'
const CAPTURE_ID = '3C679366HH908993F'
const APPROVE = `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`

// ---------- the PayPal REST client, with fetch stubbed ----------
type Seen = { url: string; method: string; headers: Record<string, string>; body?: string }
function fakeFetch(answers: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = []
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    seen.push({ url, ...init })
    const path = url.replace(PAYPAL_SANDBOX_BASE, '')
    const a = answers[path]
    if (!a) throw new Error(`unexpected call ${url}`)
    const status = a.status ?? 200
    return { ok: status < 400, status, json: async () => a.body }
  }
  return { fn, seen }
}

const TOKEN = { body: { access_token: 'A21-test-token', expires_in: 32400 } }
const orderInput = { totalCents: 50995, currency: 'USD', requestId: `ap-order-${SID}`, referenceId: SID, description: 'Northwind Outfitters: Spellbinder', returnUrl: 'https://site.test/chat?paypal=return', cancelUrl: 'https://site.test/chat?paypal=cancel' }

describe('PayPal Sandbox client', () => {
  it('only ever talks to the Sandbox host', () => {
    expect(PAYPAL_SANDBOX_BASE).toBe('https://api-m.sandbox.paypal.com')
  })

  it('signs in with client credentials, then creates a CAPTURE order for the exact total with an idempotency key', async () => {
    const f = fakeFetch({
      '/v1/oauth2/token': TOKEN,
      '/v2/checkout/orders': { status: 201, body: { id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'https://api-m.sandbox.paypal.com/x' }, { rel: 'payer-action', href: APPROVE }] } },
    })
    const client = createPayPalClient('client-id', 'secret', f.fn)
    const order = await client.createOrder(orderInput)
    expect(order).toEqual({ id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED', approveUrl: APPROVE })

    const [auth, create] = f.seen
    expect(auth.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token')
    expect(auth.headers.Authorization).toBe(`Basic ${btoa('client-id:secret')}`)
    expect(auth.body).toBe('grant_type=client_credentials')
    expect(create.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders')
    expect(create.headers.Authorization).toBe('Bearer A21-test-token')
    expect(create.headers['PayPal-Request-Id']).toBe(`ap-order-${SID}`)
    const body = JSON.parse(create.body!)
    expect(body.intent).toBe('CAPTURE')
    expect(body.purchase_units[0]).toMatchObject({ reference_id: SID, custom_id: SID, amount: { currency_code: 'USD', value: '509.95' } })
    expect(body.payment_source.paypal.experience_context).toMatchObject({ return_url: orderInput.returnUrl, cancel_url: orderInput.cancelUrl, user_action: 'PAY_NOW' })
  })

  it('reuses the sign-in token for the next call', async () => {
    const f = fakeFetch({
      '/v1/oauth2/token': TOKEN,
      '/v2/checkout/orders': { body: { id: ORDER_ID, status: 'CREATED', links: [{ rel: 'approve', href: APPROVE }] } },
    })
    const client = createPayPalClient('id', 'secret', f.fn)
    await client.createOrder(orderInput)
    await client.createOrder(orderInput)
    expect(f.seen.filter((s) => s.url.endsWith('/oauth2/token'))).toHaveLength(1)
  })

  it('refuses an approval link that is not on paypal.com', async () => {
    const f = fakeFetch({
      '/v1/oauth2/token': TOKEN,
      '/v2/checkout/orders': { body: { id: ORDER_ID, status: 'CREATED', links: [{ rel: 'payer-action', href: 'https://paypal.com.evil.test/checkout' }] } },
    })
    await expect(createPayPalClient('id', 'secret', f.fn).createOrder(orderInput)).rejects.toThrow(/no approval link/)
    expect(isPayPalApproveUrl('http://www.sandbox.paypal.com/x')).toBe(false)
    expect(isPayPalApproveUrl('https://www.sandbox.paypal.com/checkoutnow?token=X')).toBe(true)
    expect(isPayPalApproveUrl('javascript:alert(1)')).toBe(false)
  })

  it('never sends a zero or fractional-cent total', async () => {
    const client = createPayPalClient('id', 'secret', fakeFetch({}).fn)
    await expect(client.createOrder({ ...orderInput, totalCents: 0 })).rejects.toThrow()
    await expect(client.createOrder({ ...orderInput, totalCents: 10.5 })).rejects.toThrow()
  })

  it('reads the capture id, status and amount from a capture', async () => {
    const f = fakeFetch({
      '/v1/oauth2/token': TOKEN,
      [`/v2/checkout/orders/${ORDER_ID}/capture`]: { status: 201, body: { id: ORDER_ID, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: CAPTURE_ID, status: 'COMPLETED', amount: { value: '509.95', currency_code: 'USD' } }] } }] } },
    })
    const cap = await createPayPalClient('id', 'secret', f.fn).captureOrder(ORDER_ID)
    expect(cap).toEqual({ orderStatus: 'COMPLETED', captureId: CAPTURE_ID, captureStatus: 'COMPLETED', amountCents: 50995, currency: 'USD' })
    expect(f.seen[1].headers['PayPal-Request-Id']).toBe(`capture-${ORDER_ID}`)
  })

  it('turns a PayPal error into a PayPalError with its issue code', async () => {
    const f = fakeFetch({
      '/v1/oauth2/token': TOKEN,
      [`/v2/checkout/orders/${ORDER_ID}/capture`]: { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } },
    })
    await expect(createPayPalClient('id', 'secret', f.fn).captureOrder(ORDER_ID)).rejects.toMatchObject({ name: 'PayPalError', status: 422, issue: 'ORDER_NOT_APPROVED' })
  })

  it('refuses to build without keys, and refuses a malformed order id before calling PayPal', async () => {
    expect(() => createPayPalClient('', 'secret')).toThrow()
    const f = fakeFetch({})
    await expect(createPayPalClient('id', 'secret', f.fn).captureOrder('../../v1/x')).rejects.toThrow()
    expect(f.seen).toHaveLength(0)
  })

  it('converts money both ways', () => {
    expect(centsToValue(50995)).toBe('509.95')
    expect(valueToCents('509.95')).toBe(50995)
    expect(valueToCents('1e3')).toBeNull()
  })
})

// ---------- the payment step, with a fake client and store ----------
function fakeClient(over: Partial<PayPalClient> = {}) {
  const calls: { op: string; arg: unknown }[] = []
  const client: PayPalClient = {
    createOrder: async (input) => { calls.push({ op: 'create', arg: input }); return { id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED', approveUrl: APPROVE } },
    captureOrder: async (id) => { calls.push({ op: 'capture', arg: id }); return { orderStatus: 'COMPLETED', captureId: CAPTURE_ID, captureStatus: 'COMPLETED', amountCents: 50995, currency: 'USD' } },
    ...over,
  }
  return { client, calls }
}

function fakeStore(checkout: CheckoutRecord | null = { grantId: GRANT, totalCents: 50995, currency: 'USD', rail: 'paypal_sandbox', productName: 'Spellbinder Snowboard 2026/2027' }) {
  const rows: Record<string, unknown>[] = []
  const store: PaymentStore = {
    checkoutFor: async (sid) => (sid === SID ? checkout : null),
    paymentEvents: async (sid) => rows.filter((r) => r.session_id === sid) as unknown as PaymentEvent[],
    addPaymentEvent: async (row) => void rows.push(row),
  }
  return { store, rows }
}

let ids = 0
const payDeps = (client: PayPalClient, store: PaymentStore): PayPalDeps => ({ client, store, siteUrl: 'https://agent-receipt-mu.vercel.app/', newId: () => `pe-${++ids}` })

describe('PayPal payment step', () => {
  it('says plainly when the server has no PayPal keys', async () => {
    expect(await startPayPal({ session_id: SID }, undefined)).toEqual({ type: 'error', message: NOT_SET_UP })
  })

  it('refuses a bad session, a chat with no order, and an order not placed with PayPal', async () => {
    const c = fakeClient()
    expect(await startPayPal({ session_id: 'nope' }, payDeps(c.client, fakeStore().store))).toMatchObject({ type: 'error' })
    expect(await startPayPal({ session_id: SID }, payDeps(c.client, fakeStore(null).store))).toMatchObject({ type: 'error', message: 'No order in this chat yet.' })
    const card = fakeStore({ grantId: GRANT, totalCents: 50995, currency: 'USD', rail: null, productName: null })
    expect(await startPayPal({ session_id: SID }, payDeps(c.client, card.store))).toMatchObject({ type: 'error', message: 'This order was not placed with PayPal Sandbox.' })
    expect(c.calls).toHaveLength(0)
  })

  it('charges the total the server recorded, never an amount from the phone, and records the order once', async () => {
    const c = fakeClient()
    const s = fakeStore()
    const d = payDeps(c.client, s.store)
    const r = await startPayPal({ session_id: SID, amount_cents: 1, total_cents: 1 }, d)
    expect(r).toEqual({ type: 'payment', session_id: SID, status: 'approval_needed', approve_url: APPROVE, paypal_order_id: ORDER_ID, amount_cents: 50995 })
    expect(c.calls[0].arg).toMatchObject({
      totalCents: 50995, currency: 'USD', requestId: `ap-order-${SID}`, referenceId: SID,
      returnUrl: `https://agent-receipt-mu.vercel.app/chat?paypal=return&session=${SID}`,
      cancelUrl: `https://agent-receipt-mu.vercel.app/chat?paypal=cancel&session=${SID}`,
    })
    await startPayPal({ session_id: SID }, d)
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0]).toMatchObject({ session_id: SID, grant_id: GRANT, provider: 'paypal', environment: 'sandbox', event: 'order_created', paypal_order_id: ORDER_ID, amount_cents: 50995, currency: 'USD' })
  })

  it('reports a failure to start as failed, with nothing recorded', async () => {
    const c = fakeClient({ createOrder: async () => { throw new Error('network down') } })
    const s = fakeStore()
    expect(await startPayPal({ session_id: SID }, payDeps(c.client, s.store))).toMatchObject({ type: 'payment', status: 'failed', message: 'PayPal Sandbox could not be reached. Please try again.' })
    expect(s.rows).toHaveLength(0)
  })

  it('only captures the PayPal order this chat created', async () => {
    const c = fakeClient()
    const s = fakeStore()
    const d = payDeps(c.client, s.store)
    expect(await capturePayPal({ session_id: SID, paypal_order_id: ORDER_ID }, d)).toMatchObject({ type: 'error' })
    await startPayPal({ session_id: SID }, d)
    expect(await capturePayPal({ session_id: SID, paypal_order_id: 'OTHER0RDER123456' }, d)).toMatchObject({ type: 'error', message: 'This PayPal payment does not belong to the order in this chat.' })
    expect(await capturePayPal({ session_id: SID, paypal_order_id: 'bad id' }, d)).toMatchObject({ type: 'error' })
    expect(c.calls.filter((x) => x.op === 'capture')).toHaveLength(0)
  })

  it('records a completed capture with its transaction id, and a second tap does not capture twice', async () => {
    const c = fakeClient()
    const s = fakeStore()
    const d = payDeps(c.client, s.store)
    await startPayPal({ session_id: SID }, d)
    const r = await capturePayPal({ session_id: SID, paypal_order_id: ORDER_ID }, d)
    expect(r).toEqual({ type: 'payment', session_id: SID, status: 'captured', paypal_order_id: ORDER_ID, capture_id: CAPTURE_ID, amount_cents: 50995 })
    expect(s.rows.at(-1)).toMatchObject({ event: 'captured', paypal_order_id: ORDER_ID, capture_id: CAPTURE_ID, status: 'COMPLETED', amount_cents: 50995, error: null })
    expect(await capturePayPal({ session_id: SID, paypal_order_id: ORDER_ID }, d)).toMatchObject({ status: 'captured', capture_id: CAPTURE_ID })
    expect(await startPayPal({ session_id: SID }, d)).toMatchObject({ status: 'captured', capture_id: CAPTURE_ID })
    expect(c.calls.filter((x) => x.op === 'capture')).toHaveLength(1)
    expect(await cancelPayPal({ session_id: SID }, d)).toMatchObject({ type: 'error', message: 'This order is already paid.' })
  })

  it('notes a captured amount that differs from the recorded total', async () => {
    const c = fakeClient({ captureOrder: async () => ({ orderStatus: 'COMPLETED', captureId: CAPTURE_ID, captureStatus: 'COMPLETED', amountCents: 100, currency: 'USD' }) })
    const s = fakeStore()
    const d = payDeps(c.client, s.store)
    await startPayPal({ session_id: SID }, d)
    await capturePayPal({ session_id: SID, paypal_order_id: ORDER_ID }, d)
    expect(String(s.rows.at(-1)!.error)).toMatch(/differs from the recorded total/)
  })

  it('never turns a pending or failed capture into a success', async () => {
    const pending = fakeClient({ captureOrder: async () => ({ orderStatus: 'COMPLETED', captureId: CAPTURE_ID, captureStatus: 'PENDING', amountCents: 50995, currency: 'USD' }) })
    const s1 = fakeStore()
    const d1 = payDeps(pending.client, s1.store)
    await startPayPal({ session_id: SID }, d1)
    expect(await capturePayPal({ session_id: SID, paypal_order_id: ORDER_ID }, d1)).toMatchObject({ status: 'failed', message: 'PayPal Sandbox reports the payment as PENDING.' })
    expect(s1.rows.at(-1)).toMatchObject({ event: 'capture_failed', status: 'PENDING' })

    const { PayPalError } = await import('../../supabase/functions/shopper-agent/paypal')
    const refused = fakeClient({ captureOrder: async () => { throw new PayPalError('x', 422, 'ORDER_NOT_APPROVED') } })
    const s2 = fakeStore()
    const d2 = payDeps(refused.client, s2.store)
    await startPayPal({ session_id: SID }, d2)
    expect(await capturePayPal({ session_id: SID, paypal_order_id: ORDER_ID }, d2)).toMatchObject({ status: 'failed', message: 'PayPal says this payment was not approved yet.' })
    expect(s2.rows.at(-1)).toMatchObject({ event: 'capture_failed', capture_id: null, error: '422 ORDER_NOT_APPROVED' })
    expect(s2.rows.some((r) => r.event === 'captured')).toBe(false)
  })

  it('records a cancel once and leaves the order unpaid', async () => {
    const c = fakeClient()
    const s = fakeStore()
    const d = payDeps(c.client, s.store)
    await startPayPal({ session_id: SID }, d)
    const r = await cancelPayPal({ session_id: SID }, d)
    expect(r).toMatchObject({ type: 'payment', status: 'cancelled', message: 'PayPal payment cancelled. The order is recorded but not paid.' })
    await cancelPayPal({ session_id: SID }, d)
    expect(s.rows.filter((x) => x.event === 'cancelled')).toHaveLength(1)
    expect(s.rows.at(-1)).toMatchObject({ event: 'cancelled', paypal_order_id: ORDER_ID, status: 'CANCELLED_BY_SHOPPER' })
  })

  it('is reached through the same shopper-agent endpoint', async () => {
    const r = await respond({ action: 'paypal_start', session_id: SID }, { paypal: undefined } as unknown as Deps)
    expect(r).toEqual({ type: 'error', message: NOT_SET_UP })
  })
})

// ---------- the order with PayPal Sandbox switched on ----------
const BURTON = '40c70768-77ac-4953-8bae-c75c8319fcf4'
const PRODUCT: ProductRow = { id: BURTON, name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', category: 'snowboard', size_cm: 156, colour: 'Serpent', price_cents: 44995, currency: 'USD', marketing_blurb: 'Easy returns.', standard_shipping_cents: 0, standard_delivery_days: 5, expedited_shipping_cents: 6000, expedited_delivery_days: 4 }

function orderStore() {
  const grants: Record<string, unknown>[] = []
  const actions: { type: string; detail: Record<string, unknown> }[] = []
  const store: Store = {
    listProducts: async () => [PRODUCT],
    merchantId: async () => '32b14be6-26e6-49df-a7af-79532f910510',
    hasStep: async () => false,
    createSession: async () => {},
    logStep: async () => {},
    addGrant: async (row) => void grants.push(row),
    addProposal: async () => {},
    addAction: async (_g, type, detail) => { actions.push({ type, detail: detail as Record<string, unknown> }); return actions.length },
  }
  return { store, grants, actions }
}

async function placeOrder(payment_method: string, paypal: PayPalDeps | undefined) {
  const m = orderStore()
  let n = 0
  const offer = { product_id: BURTON, name: PRODUCT.name, brand: 'Burton', size_cm: 156, colour: 'Serpent', price_cents: 44995, summary: 'Easy returns', delivery_label: 'Fri Oct 30', delivery_date: '2026-10-30', shipping_method: 'expedited', shown_at: '2026-10-26T18:00:00.000Z' }
  const deps: Deps = {
    model: { complete: async () => ({ content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'place_order', arguments: JSON.stringify({ product_id: BURTON, payment_method, why: 'x' }) } }] }) },
    store: m.store, now: () => new Date('2026-10-26T18:00:00Z'), demoDate: null,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, paypal,
  }
  const r = (await handle({ messages: [{ role: 'user', text: 'Order the Burton snowboard, pay with PayPal' }], offers: [offer] }, deps)) as AgentReply
  return { r, m }
}

describe('placing an order with PayPal Sandbox on', () => {
  const on = () => payDeps(fakeClient().client, fakeStore().store)

  it('marks a PayPal order as a Sandbox payment waiting for approval, not simulated', async () => {
    const { r, m } = await placeOrder('PayPal', on())
    expect(r.type).toBe('ordered')
    const order = (r as Extract<AgentReply, { type: 'ordered' }>).order
    expect(order).toMatchObject({ payment_label: 'PayPal Sandbox (test money)', pay: { provider: 'paypal', environment: 'sandbox' }, total_cents: 50995 })
    expect(m.actions[0].detail).toMatchObject({ payment_simulated: false, payment_rail: 'paypal_sandbox', payment_status: 'awaiting_approval', total_cents: 50995 })
  })

  it('keeps every other payment simulated, exactly as before', async () => {
    const { r, m } = await placeOrder('Mastercard', on())
    const order = (r as Extract<AgentReply, { type: 'ordered' }>).order
    expect(order.pay).toBeUndefined()
    expect(m.actions[0].detail).toMatchObject({ payment_simulated: true })
    expect(m.actions[0].detail.payment_rail).toBeUndefined()
  })

  it('keeps PayPal simulated when the server has no PayPal keys', async () => {
    const { r, m } = await placeOrder('PayPal', undefined)
    expect((r as Extract<AgentReply, { type: 'ordered' }>).order.pay).toBeUndefined()
    expect(m.actions[0].detail).toMatchObject({ payment_simulated: true })
  })
})

// ---------- the phone's order card ----------
const ORDER: OrderData = {
  product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', item_price_cents: 44995,
  shipping_label: 'Expedited shipping', shipping_cents: 6000, total_cents: 50995, delivery_label: 'Fri Oct 30', payment_label: 'PayPal Sandbox (test money)',
  pay: { provider: 'paypal', environment: 'sandbox' },
}

describe('order card with PayPal Sandbox', () => {
  it('offers Pay with PayPal and says it is test money', () => {
    render(<OrderCard order={ORDER} onPay={() => {}} />)
    expect(screen.getByRole('button', { name: 'Pay with PayPal' })).toBeEnabled()
    expect(screen.getByText(/test money/i)).toBeInTheDocument()
    expect(screen.queryByText(/real payment/i)).toBeNull()
  })

  it('shows the PayPal transaction id once captured', () => {
    render(<OrderCard order={ORDER} payment={{ status: 'captured', capture_id: CAPTURE_ID, paypal_order_id: ORDER_ID }} />)
    expect(screen.getByText('Paid with PayPal Sandbox (test money).', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(CAPTURE_ID)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /PayPal/ })).toBeNull()
  })

  it('offers a retry after a failure, with the reason', () => {
    render(<OrderCard order={ORDER} payment={{ status: 'failed', message: 'PayPal says this payment was not approved yet.' }} onPay={() => {}} />)
    expect(screen.getByText('PayPal says this payment was not approved yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try PayPal again' })).toBeInTheDocument()
  })

  it('keeps the simulated wording for other payments', () => {
    const { pay: _pay, ...simulated } = ORDER
    render(<OrderCard order={{ ...simulated, payment_label: 'Demo Checkout — Mastercard' }} />)
    expect(screen.getByText(/Simulated, no real payment/)).toBeInTheDocument()
  })
})

// ---------- keys and hosts ----------
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? filesUnder(p) : [p]
  })
}

describe('PayPal keys stay on the server', () => {
  it('reads the keys only by name from the edge-function environment', () => {
    const index = readFileSync('supabase/functions/shopper-agent/index.ts', 'utf8')
    expect(index).toContain("Deno.env.get('PAYPAL_CLIENT_ID')")
    expect(index).toContain("Deno.env.get('PAYPAL_SECRET')")
  })

  it('has no PayPal key in the browser code and never names the live PayPal API', () => {
    const src = filesUnder('src').filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(`${join('src', 'test')}`))
    for (const f of src) expect(readFileSync(f, 'utf8'), f).not.toMatch(/VITE_PAYPAL|PAYPAL_SECRET|PAYPAL_CLIENT_ID/)
    for (const f of filesUnder('supabase/functions')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/api-m\.paypal\.com|api\.paypal\.com/)
  })
})

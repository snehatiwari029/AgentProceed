import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PayPalResult } from '../dashboard/components/PayPalEvidence'
import { createPayPalDisputesClient, PAYPAL_SANDBOX_BASE, type DisputesFetch } from '../../supabase/functions/paypal-disputes/paypal'
import { NO_CAPTURE, NOT_RECEIVED_NO_SHIPMENT, PAYPAL_NOT_SET_UP, submitEvidence, type PayPalDisputesDb } from '../../supabase/functions/paypal-disputes/run'

const MERCHANT = '32b14be6-26e6-49df-a7af-79532f910510'
const RECEIPT = 'd9aed7ea-2882-4521-bf40-629863f016cf'
const GRANT = 'f81784d4-1ac1-4761-ac95-3b5d02866b9c'
const ORDER = '7DV27015UC915202F'
const CAPTURE = '64958042Y10660906'
const DISPUTE = 'PP-D-12345'
const HASH = `sha256:${'a'.repeat(64)}`

type Seen = { url: string; method: string; headers: Record<string, string>; body?: string | FormData }
type Answer = { status?: number; body: unknown }
function fakeFetch(answers: Record<string, Answer | Answer[]>) {
  const seen: Seen[] = []
  const fn: DisputesFetch = async (url, init) => {
    seen.push({ url, ...init })
    const key = `${init.method} ${url.replace(PAYPAL_SANDBOX_BASE, '')}`
    const a = answers[key]
    if (!a) throw new Error(`unexpected call ${key}`)
    const one = Array.isArray(a) ? a.shift()! : a
    const status = one.status ?? 200
    return { ok: status < 400, status, json: async () => one.body }
  }
  return { fn, seen }
}

const TOKEN = { body: { access_token: 'A21-test', expires_in: 32400 } }
const LIST = { body: { items: [{ dispute_id: DISPUTE, status: 'WAITING_FOR_SELLER_RESPONSE', create_time: '2026-11-12T02:31:40Z' }] } }
const link = (rel: string) => ({ rel, href: `${PAYPAL_SANDBOX_BASE}/v1/customer/disputes/${DISPUTE}/${rel.replace('_', '-')}`, method: 'POST' })
const detail = (over: Record<string, unknown>) => ({
  body: {
    dispute_id: DISPUTE, status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'UNAUTHORISED', dispute_life_cycle_stage: 'CHARGEBACK',
    dispute_amount: { value: '509.95', currency_code: 'USD' }, links: [{ rel: 'self', href: 'x' }, link('provide_evidence')], ...over,
  },
})

function world(opts: { shipment?: Record<string, unknown> | null; captured?: boolean } = {}) {
  const db: PayPalDisputesDb = {
    async merchant(id) { return id === MERCHANT ? { id, name: 'Northwind Outfitters' } : null },
    async receiptById(m, id) {
      return m === MERCHANT && id === RECEIPT
        ? { id, merchant_id: m, grant_id: GRANT, order_ref: '15010', receipt_ref: 'AR-2026-0053', entry_hash: HASH, decision: 'review_required', problems_found: 2, sealed_at: '2026-11-11T20:35:31Z' }
        : null
    },
    async disputeById() { return null },
    async paymentEvents(g) {
      return g === GRANT && opts.captured !== false
        ? [{ event: 'order_created', paypal_order_id: ORDER, capture_id: null }, { event: 'captured', paypal_order_id: ORDER, capture_id: CAPTURE }]
        : []
    },
    async shipment() { return opts.shipment ?? null },
  }
  return db
}

const inputOf = (s: Seen) => new Promise<{ evidences: Record<string, unknown>[] }>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(JSON.parse(String(r.result)))
  r.onerror = reject
  r.readAsText((s.body as FormData).get('input') as Blob)
})

const body = { action: 'submit_evidence', merchant_id: MERCHANT, receipt_id: RECEIPT }

describe('PayPal Sandbox Disputes: submit evidence', () => {
  it('signs in, lists by transaction id, uses the canonical dispute id, submits the evidence and reads the new status', async () => {
    const f = fakeFetch({
      'POST /v1/oauth2/token': TOKEN,
      [`GET /v1/customer/disputes?disputed_transaction_id=${CAPTURE}`]: LIST,
      [`GET /v1/customer/disputes/${DISPUTE}`]: [detail({}), detail({ status: 'UNDER_REVIEW', links: [{ rel: 'self', href: 'x' }] })],
      [`POST /v1/customer/disputes/${DISPUTE}/provide-evidence`]: { body: { links: [{ rel: 'self' }] } },
    })
    const r = await submitEvidence(body, { db: world(), paypal: createPayPalDisputesClient('id', 'secret', f.fn) })
    expect(r.type).toBe('paypal_evidence')
    if (r.type !== 'paypal_evidence' || r.result.outcome !== 'submitted') throw new Error('not submitted')
    expect(r.result.dispute).toMatchObject({ dispute_id: DISPUTE, status: 'UNDER_REVIEW' })
    expect(r.result.dispute_before.status).toBe('WAITING_FOR_SELLER_RESPONSE')
    expect(f.seen.every((s) => s.url.startsWith('https://api-m.sandbox.paypal.com/'))).toBe(true)
    expect(f.seen[0].headers.Authorization).toBe(`Basic ${btoa('id:secret')}`)
    const post = f.seen.find((s) => s.method === 'POST' && s.url.endsWith('/provide-evidence'))!
    expect(post.body).toBeInstanceOf(FormData)
    const input = await inputOf(post)
    const notes = String(input.evidences[0].notes)
    expect(input.evidences[0].evidence_type).toBe('PROOF_OF_RECEIPT_COPY')
    for (const s of [HASH, ORDER, CAPTURE, 'AR-2026-0053', 'UNAUTHORISED', 'Review Required']) expect(notes).toContain(s)
  })

  it('says evidence submission is not available yet when there is no provide_evidence link, and sends nothing', async () => {
    const f = fakeFetch({
      'POST /v1/oauth2/token': TOKEN,
      [`GET /v1/customer/disputes?disputed_transaction_id=${CAPTURE}`]: LIST,
      [`GET /v1/customer/disputes/${DISPUTE}`]: detail({ dispute_life_cycle_stage: 'INQUIRY', links: [{ rel: 'self', href: 'x' }, link('send_message')] }),
    })
    const r = await submitEvidence(body, { db: world(), paypal: createPayPalDisputesClient('id', 'secret', f.fn) })
    expect(r).toMatchObject({ type: 'paypal_evidence', result: { outcome: 'not_available', dispute: { stage: 'INQUIRY' } } })
    expect(f.seen.some((s) => s.url.endsWith('/provide-evidence'))).toBe(false)
  })

  it('item not received with no shipment: does not present the record as proof of fulfillment', async () => {
    const f = fakeFetch({
      'POST /v1/oauth2/token': TOKEN,
      [`GET /v1/customer/disputes?disputed_transaction_id=${CAPTURE}`]: LIST,
      [`GET /v1/customer/disputes/${DISPUTE}`]: detail({ reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' }),
    })
    const r = await submitEvidence(body, { db: world(), paypal: createPayPalDisputesClient('id', 'secret', f.fn) })
    expect(r).toMatchObject({ type: 'paypal_evidence', result: { outcome: 'not_submitted', message: NOT_RECEIVED_NO_SHIPMENT } })
    expect(f.seen.some((s) => s.url.endsWith('/provide-evidence'))).toBe(false)
  })

  it('item not received with a shipment: sends proof of fulfillment with the recorded tracking', async () => {
    const f = fakeFetch({
      'POST /v1/oauth2/token': TOKEN,
      [`GET /v1/customer/disputes?disputed_transaction_id=${CAPTURE}`]: LIST,
      [`GET /v1/customer/disputes/${DISPUTE}`]: [detail({ reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' }), detail({ status: 'UNDER_REVIEW' })],
      [`POST /v1/customer/disputes/${DISPUTE}/provide-evidence`]: { body: {} },
    })
    const db = world({ shipment: { carrier: 'UPS', tracking_ref: '1Z999', shipped_on: '2026-11-11' } })
    const r = await submitEvidence(body, { db, paypal: createPayPalDisputesClient('id', 'secret', f.fn) })
    expect(r).toMatchObject({ result: { outcome: 'submitted' } })
    const post = f.seen.find((s) => s.url.endsWith('/provide-evidence'))!
    const input = await inputOf(post)
    expect(input.evidences[0]).toMatchObject({ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ tracking_number: '1Z999', carrier_name_other: 'UPS' }] } })
  })

  it('tries the next evidence type only on EVIDENCE_TYPE_IS_NOT_ALLOWED and shows any other PayPal error plainly', async () => {
    const f = fakeFetch({
      'POST /v1/oauth2/token': TOKEN,
      [`GET /v1/customer/disputes?disputed_transaction_id=${CAPTURE}`]: LIST,
      [`GET /v1/customer/disputes/${DISPUTE}`]: detail({}),
      [`POST /v1/customer/disputes/${DISPUTE}/provide-evidence`]: [
        { status: 400, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'EVIDENCE_TYPE_IS_NOT_ALLOWED' }] } },
        { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', details: [{ issue: 'NOTES_TOO_LONG', description: 'Notes too long' }] } },
      ],
    })
    const r = await submitEvidence(body, { db: world(), paypal: createPayPalDisputesClient('id', 'secret', f.fn) })
    expect(r.type).toBe('error')
    if (r.type !== 'error') return
    expect(r.message).toContain('422')
    expect(r.paypal).toMatchObject({ status: 422, issue: 'NOTES_TOO_LONG', attempts: [{ evidence_type: 'PROOF_OF_RECEIPT_COPY' }, { evidence_type: 'DETAILS_OF_PURCHASE' }] })
    expect(r.paypal?.detail).toContain('Notes too long')
  })

  it('no dispute on the transaction, no captured payment, no credentials, wrong merchant', async () => {
    const f = fakeFetch({ 'POST /v1/oauth2/token': TOKEN, [`GET /v1/customer/disputes?disputed_transaction_id=${CAPTURE}`]: { body: { items: [] } } })
    expect(await submitEvidence(body, { db: world(), paypal: createPayPalDisputesClient('id', 'secret', f.fn) })).toMatchObject({ result: { outcome: 'no_dispute' } })
    expect(await submitEvidence(body, { db: world({ captured: false }), paypal: null })).toEqual({ type: 'error', message: NO_CAPTURE })
    expect(await submitEvidence(body, { db: world(), paypal: null })).toEqual({ type: 'error', message: PAYPAL_NOT_SET_UP })
    expect(await submitEvidence({ ...body, merchant_id: '00000000-0000-4000-a000-000000000099' }, { db: world(), paypal: null })).toMatchObject({ type: 'error', message: 'Unknown merchant.' })
  })
})

describe('PayPal Sandbox Disputes: result panel', () => {
  const pp = { dispute_id: 'PP-R-YLY-10199668', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'INQUIRY', dispute_state: 'REQUIRED_ACTION', amount: '509.95', currency: 'USD', create_time: null, update_time: null, seller_response_due_date: '2026-12-02T02:31:40.600Z', links: ['self', 'provide_evidence'] }
  it('shows not available yet, not submitted, submitted and API errors plainly', () => {
    const { rerender } = render(<PayPalResult reply={{ type: 'paypal_evidence', environment: 'sandbox', order_ref: '15010', paypal_order_id: ORDER, result: { outcome: 'not_available', transaction_id: CAPTURE, dispute: pp, message: 'Evidence submission is not available yet.' } }} />)
    expect(screen.getByTestId('paypal-evidence-not-available').textContent).toContain('INQUIRY')
    rerender(<PayPalResult reply={{ type: 'paypal_evidence', environment: 'sandbox', order_ref: '15010', paypal_order_id: ORDER, result: { outcome: 'not_submitted', transaction_id: CAPTURE, dispute: pp, message: NOT_RECEIVED_NO_SHIPMENT } }} />)
    expect(screen.getByTestId('paypal-evidence-not-submitted').textContent).toContain('PP-R-YLY-10199668')
    rerender(<PayPalResult reply={{ type: 'paypal_evidence', environment: 'sandbox', order_ref: '15010', paypal_order_id: ORDER, result: { outcome: 'submitted', transaction_id: CAPTURE, dispute_before: pp, dispute: { ...pp, status: 'UNDER_REVIEW' }, response: {}, request: {}, attempts: [{ evidence_type: 'PROOF_OF_FULFILLMENT', status: 200, issue: null }] } }} />)
    expect(screen.getByTestId('paypal-evidence-submitted').textContent).toContain('now: UNDER_REVIEW')
    rerender(<PayPalResult reply={{ type: 'error', message: 'PayPal Sandbox provide-evidence returned 422 (NOTES_TOO_LONG).', paypal: { status: 422, issue: 'NOTES_TOO_LONG', detail: 'Notes too long', dispute: null, attempts: [] } }} />)
    expect(screen.getByRole('alert').textContent).toContain('Notes too long')
  })
})

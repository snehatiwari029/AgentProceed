import { describe, expect, it } from 'vitest'
import { disputeFields, handleWebhook, SIGNATURE_HEADERS, type Match, type SignatureHeaders, type WebhookDb } from '../../supabase/functions/paypal-webhook/webhook'

const HEADERS = Object.fromEntries(SIGNATURE_HEADERS.map((h) => [h, `test-${h}`])) as SignatureHeaders
const CAPTURE = '4BM03217CF5644340'
const MATCH: Match = { receipt_id: 'f12a6d0a-d1f3-4f05-b0d9-d3c2b8d93aab', merchant_id: '32b14be6-26e6-49df-a7af-79532f910510', order_ref: '15016', paypal_order_id: '12123471LF747714E' }

const event = (type: string, over: Record<string, unknown> = {}, id = `WH-${type}-1`) => JSON.stringify({
  id, event_type: type, resource_type: 'dispute', create_time: '2026-11-12T06:00:00Z',
  resource: {
    dispute_id: 'PP-R-NEW-10200001', reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', status: 'OPEN', dispute_life_cycle_stage: 'INQUIRY',
    dispute_amount: { currency_code: 'USD', value: '370.83' }, seller_response_due_date: '2026-12-02T06:00:00.000Z',
    create_time: '2026-11-12T06:00:00.000Z', update_time: '2026-11-12T06:00:00.000Z',
    disputed_transactions: [{ seller_transaction_id: CAPTURE, buyer_transaction_id: '0G243719T68368018' }],
    ...over,
  },
})

function world(opts: { verify?: 'SUCCESS' | 'FAILURE' | 'throw' | null; match?: Match | null } = {}) {
  const log: Record<string, unknown>[] = []
  const records = new Map<string, Record<string, unknown>>()
  const matchedWith: string[][] = []
  const db: WebhookDb = {
    logEvent: async (row) => void log.push(row),
    eventProcessed: async (id) => log.some((l) => l.event_id === id && l.verification === 'SUCCESS' && (l.outcome === 'created' || l.outcome === 'updated')),
    matchTransaction: async (ids) => { matchedWith.push(ids); return opts.match === undefined ? MATCH : opts.match },
    disputeRecord: async (id) => records.get(id) ?? null,
    insertDispute: async (row) => void records.set(String(row.paypal_dispute_id), { ...row }),
    updateDispute: async (id, patch) => void records.set(id, { ...records.get(id), ...patch }),
  }
  const v = opts.verify === undefined ? 'SUCCESS' : opts.verify
  const deps = {
    db, now: () => new Date('2026-11-12T06:00:05Z'),
    verify: v === null ? null : async () => { if (v === 'throw') throw new Error('timeout'); return v },
  }
  return { log, records, matchedWith, run: (body: string, h: Partial<SignatureHeaders> = HEADERS) => handleWebhook(body, h, deps) }
}

describe('PayPal webhook dispute intake', () => {
  it('reads the dispute fields from the webhook resource', () => {
    const f = disputeFields(JSON.parse(event('CUSTOMER.DISPUTE.CREATED')).resource)
    expect(f).toMatchObject({ dispute_id: 'PP-R-NEW-10200001', reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', status: 'OPEN', amount_cents: 37083, currency: 'USD', transaction_id: CAPTURE, seller_response_due_date: '2026-12-02T06:00:00.000Z' })
    expect(f.transaction_ids).toEqual([CAPTURE, '0G243719T68368018'])
  })

  it('CREATED, verified: creates a record matched by the disputed transaction id, and logs it', async () => {
    const w = world()
    const r = await w.run(event('CUSTOMER.DISPUTE.CREATED'))
    expect(r).toMatchObject({ status: 200, body: { ok: true, outcome: 'created', verification: 'SUCCESS', matched: true, dispute_id: 'PP-R-NEW-10200001' } })
    expect(w.matchedWith[0]).toContain(CAPTURE)
    expect(w.records.get('PP-R-NEW-10200001')).toMatchObject({ matched: true, receipt_id: MATCH.receipt_id, order_ref: '15016', paypal_order_id: MATCH.paypal_order_id, transaction_id: CAPTURE, status: 'OPEN', amount_cents: 37083, source: 'paypal_webhook' })
    expect(w.log).toEqual([expect.objectContaining({ event_id: 'WH-CUSTOMER.DISPUTE.CREATED-1', event_type: 'CUSTOMER.DISPUTE.CREATED', paypal_dispute_id: 'PP-R-NEW-10200001', verification: 'SUCCESS', outcome: 'created' })])
    // Nothing secret is logged: no headers, no signature, no body.
    expect(JSON.stringify(w.log)).not.toMatch(/test-paypal|transmission/)
  })

  it('CREATED with no recorded payment: still creates the record, marked unmatched', async () => {
    const w = world({ match: null })
    const r = await w.run(event('CUSTOMER.DISPUTE.CREATED'))
    expect(r.body).toMatchObject({ outcome: 'created', matched: false })
    expect(w.records.get('PP-R-NEW-10200001')).toMatchObject({ matched: false, receipt_id: null, transaction_id: CAPTURE })
  })

  it('UPDATED and RESOLVED change the status (and only fields PayPal sent); a redelivery changes nothing', async () => {
    const w = world()
    await w.run(event('CUSTOMER.DISPUTE.CREATED'))
    const u = await w.run(event('CUSTOMER.DISPUTE.UPDATED', { status: 'UNDER_REVIEW', dispute_life_cycle_stage: 'CHARGEBACK', seller_response_due_date: undefined }))
    expect(u.body).toMatchObject({ outcome: 'updated', matched: true })
    expect(w.records.get('PP-R-NEW-10200001')).toMatchObject({ status: 'UNDER_REVIEW', stage: 'CHARGEBACK', seller_response_due_date: '2026-12-02T06:00:00.000Z', last_event_type: 'CUSTOMER.DISPUTE.UPDATED' })
    const res = await w.run(event('CUSTOMER.DISPUTE.RESOLVED', { status: 'RESOLVED', dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' } }))
    expect(res.body.outcome).toBe('updated')
    expect(w.records.get('PP-R-NEW-10200001')).toMatchObject({ status: 'RESOLVED', outcome: 'RESOLVED_SELLER_FAVOUR' })
    const again = await w.run(event('CUSTOMER.DISPUTE.RESOLVED', { status: 'OPEN' }))
    expect(again).toMatchObject({ status: 200, body: { outcome: 'duplicate' } })
    expect(w.records.get('PP-R-NEW-10200001')?.status).toBe('RESOLVED')
    expect(w.log.map((l) => l.outcome)).toEqual(['created', 'updated', 'updated', 'duplicate'])
  })

  it('an UPDATED that arrives before any CREATED creates the record, so no dispute is lost', async () => {
    const w = world()
    const r = await w.run(event('CUSTOMER.DISPUTE.UPDATED', { status: 'WAITING_FOR_SELLER_RESPONSE' }))
    expect(r.body).toMatchObject({ outcome: 'created', matched: true })
    expect(w.records.get('PP-R-NEW-10200001')?.status).toBe('WAITING_FOR_SELLER_RESPONSE')
  })

  it('rejects anything that does not verify, writes no dispute, and logs the result', async () => {
    for (const [opts, headers, status, verification] of [
      [{ verify: 'FAILURE' }, HEADERS, 401, 'FAILURE'],
      [{ verify: 'throw' }, HEADERS, 503, 'ERROR'],
      [{ verify: null }, HEADERS, 503, 'NOT_CONFIGURED'],
      [{}, { ...HEADERS, 'paypal-transmission-sig': '' }, 401, 'MISSING_HEADERS'],
    ] as const) {
      const w = world(opts as Parameters<typeof world>[0])
      const r = await w.run(event('CUSTOMER.DISPUTE.CREATED'), headers)
      expect(r).toMatchObject({ status, body: { ok: false, outcome: 'rejected', verification } })
      expect(w.records.size).toBe(0)
      expect(w.log).toEqual([expect.objectContaining({ verification, outcome: 'rejected', event_type: 'CUSTOMER.DISPUTE.CREATED' })])
    }
    const bad = world()
    expect(await bad.run('not json')).toMatchObject({ status: 400, body: { verification: 'ERROR' } })
  })

  it('a verified event that is not a dispute event is logged as ignored', async () => {
    const w = world()
    const r = await w.run(JSON.stringify({ id: 'WH-PAY-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture', resource: { id: CAPTURE } }))
    expect(r).toMatchObject({ status: 200, body: { outcome: 'ignored' } })
    expect(w.records.size).toBe(0)
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSeed, MERCHANT_ID } from '../../scripts/seed-dashboard-demo'
import {
  CE3_LINE, DEADLINE_LINE, FALLBACK_LABEL, MC_REGISTRATION_LINE, NO_REVIEW, SAMPLE_LABEL, buildPack, packHashOf, sparkInput, validateSparkTexts,
  type Gate, type PackInput, type Processor,
} from '../../supabase/functions/disputes/pack'
import { NOT_AGENT_ORDER, ONE_DISPUTE, ROUTES, type DisputesDb, type DisputesDeps } from '../../supabase/functions/disputes/run'
import { createSparkTextWriter, type PackTextWriter } from '../../supabase/functions/disputes/spark'
import { verifyOrderChain, type ChainRecord } from '../shared/chain'
import { packExport, packToHtml } from '../dashboard/packView'
import { sampleDisputeFor } from '../dashboard/sampleDispute'

type Row = Record<string, unknown>
const NW = { id: MERCHANT_ID, name: 'Northwind Outfitters' }

// Test only: an in-memory copy of the seeded tables. Nothing here touches a live database.
async function world() {
  const { records } = await buildSeed()
  const tables: Record<string, Row[]> = {}
  for (const r of records) (tables[r.table] ??= []).push({ ...r.row })
  tables.merchants = [{ ...NW }, { id: '00000000-0000-4000-a000-000000000099', name: 'Other Merchant' }]
  for (const t of ['shipments', 'merchant_reviews', 'disputes', 'dispute_events']) tables[t] ??= []
  let seq = Math.max(...records.filter((r) => r.entry_type).map((r) => r.row.chain_seq as number))
  const chained = ['grants', 'proposals', 'actions', 'receipts', 'shipments', 'merchant_reviews', 'dispute_events']
  const latest = () => chained.flatMap((t) => tables[t]).sort((a, b) => (b.chain_seq as number) - (a.chain_seq as number))[0]
  const writes: { table: string; row: Row }[] = []
  const db: DisputesDb = {
    async latestHash() { return (latest()?.entry_hash as string) ?? null },
    async insert(table, row) { seq += 1; const full = { ...row, chain_seq: seq, created_at: '2026-11-03T10:00:00.000Z' }; tables[table].push(full); writes.push({ table, row: full }) },
    async insertPlain(table, row) { tables[table].push({ ...row }); writes.push({ table, row }) },
    async merchant(id) { const m = tables.merchants.find((x) => x.id === id); return m ? { id: m.id as string, name: m.name as string } : null },
    async receiptByOrderRef(m, ref) { return tables.receipts.find((r) => r.merchant_id === m && r.order_ref === ref) ?? null },
    async gapSessionForOrder(m, ref) { return tables.sessions.some((s) => s.merchant_id === m && s.detection_source === 'none' && String(s.gap_note).startsWith(`Order ${ref}:`)) },
    async receiptById(m, id) { return tables.receipts.find((r) => r.merchant_id === m && r.id === id) ?? null },
    async disputeForReceipt(id) { return tables.disputes.find((d) => d.receipt_id === id) ?? null },
    async disputeById(id) { return tables.disputes.find((d) => d.id === id) ?? null },
    async events(id) { return tables.dispute_events.filter((e) => e.dispute_id === id) },
    async grant(id) { return tables.grants.find((g) => g.id === id) ?? null },
    async proposal(id) { return tables.proposals.find((g) => g.id === id) ?? null },
    async checkout(id) { return tables.actions.find((a) => a.grant_id === id && a.type === 'checkout') ?? null },
    async shipment(id) { return tables.shipments.find((s) => s.receipt_id === id) ?? null },
    async reviews(id) { return tables.merchant_reviews.filter((s) => s.receipt_id === id) },
  }
  const sparkCalls: unknown[] = []
  const writer: PackTextWriter = { async write(input) { sparkCalls.push(input); return { texts: null, text_source: 'rules-fallback', reason: 'no key (test)' } } }
  let n = 0
  const deps: DisputesDeps = { db, writer, now: () => new Date('2026-11-03T10:00:00.000Z'), newId: () => `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}` }
  const call = (action: string, body: Row) => ROUTES[action]({ action, merchant_id: NW.id, ...body }, deps)
  return { tables, writes, deps, call, sparkCalls, records }
}

// The pack for one seeded order, built the way the dashboard builds it, with the real tamper check.
async function packFor(w: Awaited<ReturnType<typeof world>>, orderRef: string, processor: Processor, over: Partial<PackInput> = {}) {
  const receipt = w.tables.receipts.find((r) => r.order_ref === orderRef)!
  const dispute = w.tables.disputes.find((d) => d.receipt_id === receipt.id)!
  const gate = over.gate ?? (await gateFor(w, receipt))
  return buildPack({
    processor, merchant: NW, receipt, grant: w.tables.grants.find((g) => g.id === receipt.grant_id)!, proposal: w.tables.proposals.find((p) => p.id === receipt.proposal_id) ?? null,
    action: w.tables.actions.find((a) => a.grant_id === receipt.grant_id)!, shipment: w.tables.shipments.find((s) => s.receipt_id === receipt.id) ?? null,
    reviews: w.tables.merchant_reviews.filter((r) => r.receipt_id === receipt.id), dispute, gate, ...over,
  })
}
async function gateFor(w: Awaited<ReturnType<typeof world>>, receipt: Row): Promise<Gate> {
  const all = ['grants', 'proposals', 'actions', 'receipts', 'shipments', 'merchant_reviews', 'dispute_events'].flatMap((t) => w.tables[t].map((row) => ({ t, row })))
  const types: Record<string, ChainRecord['entry_type']> = { grants: 'grant', proposals: 'proposal', actions: 'action', receipts: 'receipt', shipments: 'shipment', merchant_reviews: 'merchant_review', dispute_events: 'dispute_event' }
  const dispute = w.tables.disputes.find((d) => d.receipt_id === receipt.id)
  const own = all.filter(({ row }) => row.id === receipt.id || row.id === receipt.grant_id || row.id === receipt.proposal_id || row.grant_id === receipt.grant_id || row.receipt_id === receipt.id || (dispute && row.dispute_id === dispute.id))
  const check = await verifyOrderChain(own.map(({ t, row }) => ({ chain_seq: row.chain_seq as number, entry_type: types[t], row: row as ChainRecord['row'] })), (s) => all.find((x) => x.row.chain_seq === s)?.row.entry_hash as string)
  return check.ok && check.receipt_hash ? { status: 'passed', receipt_hash: check.receipt_hash } : { status: 'failed', message: check.failed?.message ?? '', failing_link: null }
}

const textOf = (p: unknown) => JSON.stringify(p)
const RECOMMENDATION = /recommend|win probability|likely to win|chance of winning|\bscore\b|you should (fight|concede|represent)|we suggest/i

describe('Dispute Agent: evidence pack for 13422 (seeded, Visa 10.4)', () => {
  it('lays out the record in Visa field order, with the claim and the condition shown separately, as filed', async () => {
    const w = await world()
    const p = await packFor(w, '13422', 'visa')
    expect(p.processor_label).toBe('Visa')
    expect(p.sections.map((s) => s.key)).toEqual(['dispute', 'grant', 'action', 'terms', 'verdict', 'receipt', 'merchant_review', 'delivery'])
    expect(p.claim).toMatchObject({
      as_filed: 'Agent overstep — agent exceeded budget / bought outside grant', claim_type: 'agent_outside_grant',
      condition_as_filed: '10.4 — Other Fraud, Card-Absent Environment', condition_name: 'Other Fraud — Card-Absent Environment', code_flag: null,
    })
    expect(p.claim.condition_plain).toMatch(/did not authorise or take part in this card-absent/)
    // product scope is null in the seed: unspecified, no check — never "snowboard", never a match
    const scope = p.sections.find((s) => s.key === 'grant')!.items.find((i) => i.label === 'Product scope')!
    expect(scope).toMatchObject({ status: 'unspecified', value: 'Not specified by the customer — no product scope check' })
    expect(p.claim_vs_record.find((e) => e.element === 'Product')!.result).toBe('unspecified')
    expect(p.claim_vs_record.find((e) => e.element === 'Budget')).toMatchObject({ result: 'match', record: expect.stringContaining('$500.00 max') })
    // shipment record present; delivery proof, carrier, tracking listed as missing, not invented
    const delivery = p.sections.find((s) => s.key === 'delivery')!.items
    expect(delivery.find((i) => i.label === 'Shipped on')).toMatchObject({ status: 'present', value: '2026-10-27' })
    expect(delivery.find((i) => i.label === 'Delivered on')).toMatchObject({ status: 'present', value: '2026-10-29' })
    for (const label of ['Carrier', 'Tracking reference', 'Proof of delivery']) {
      expect(delivery.find((i) => i.label === label)).toMatchObject({ status: 'missing', value: null, obtain_from: 'Obtain from fulfilment system' })
    }
    expect(p.merchant_review_statement).toMatch(/No merchant review record\. The order was Pass at Agent Receipt check, so no review was flagged\./)
  })

  it('lists every missing item with where to obtain it, and flags merchant input; nothing is filled in', async () => {
    const w = await world()
    const p = await packFor(w, '13422', 'visa')
    expect(p.needs.map((n) => [n.item, n.obtain_from])).toEqual([
      ['Acquirer / channel', 'Obtain from acquirer'],
      ['Dispute amount', 'Obtain from acquirer'],
      ['Processor reference', 'Obtain from acquirer'],
      ['Payment credential (last 4 / token only)', 'Obtain from acquirer'],
      ['Carrier', 'Obtain from fulfilment system'],
      ['Tracking reference', 'Obtain from fulfilment system'],
      ['Proof of delivery', 'Obtain from fulfilment system'],
    ])
    expect(p.needs.filter((n) => n.merchant_input).map((n) => n.item)).toEqual(['Carrier', 'Tracking reference', 'Proof of delivery'])
    // no credential, card number, carrier or tracking value appears anywhere: only the labels of what is missing
    const dispute = p.sections.find((s) => s.key === 'dispute')!.items
    expect(dispute.find((i) => i.label === 'Payment credential (last 4 / token only)')).toMatchObject({ status: 'missing', value: null })
    expect(textOf(p)).not.toMatch(/\b\d{13,19}\b|•••|\*{4}/)
  })

  it('CE3.0, deadline and remedy lines: cannot be determined from the record; no computed deadline', async () => {
    const w = await world()
    const p = await packFor(w, '13422', 'visa')
    expect(p.notes).toContain(CE3_LINE)
    expect(p.notes).toContain(DEADLINE_LINE)
    expect(textOf(p)).not.toMatch(/CE3\.0 (is )?(not )?applicable|45 days|deadline: 20\d\d/i)
    expect(p.notes.join(' ')).toMatch(/Visa Rules prevail/)
    expect(p.disclaimer).toMatch(/Does not replace Visa \/ Mastercard Rules\. Does not guarantee outcome\. Confirm eligibility with your acquirer before submitting\. Agent Proceed does not submit this pack on your behalf, and does not decide liability\./)
  })

  it('tamper gate: one line with the receipt hash when the chain verifies; the failing link and an untrusted pack when it does not', async () => {
    const w = await world()
    const receipt = w.tables.receipts.find((r) => r.order_ref === '13422')!
    const ok = await packFor(w, '13422', 'visa')
    expect(ok.trusted).toBe(true)
    expect(ok.tamper_line).toBe(`Receipt chain verified — tamper check passed · ${receipt.entry_hash}`)
    // edit the receipt after it was written
    receipt.action_summary = { ...(receipt.action_summary as Row), total_cents: 4898 }
    const bad = await packFor(w, '13422', 'visa')
    expect(bad.trusted).toBe(false)
    expect(bad.tamper_line).toMatch(/^Receipt chain failed verification — tamper check failed\. Untrusted record\. Entry \d+ \(receipt\) no longer matches its hash/)
    expect(bad.tamper_line).not.toMatch(/passed/)
  })

  it('AR-2026-0041 tamper proof is unchanged: original $449.95 passes, an edited copy at $44.99 fails', async () => {
    const w = await world()
    const r = w.tables.receipts.find((x) => x.receipt_ref === 'AR-2026-0041')!
    expect((r.action_summary as Row).total_cents).toBe(44995)
    expect((await gateFor(w, r)).status).toBe('passed')
    r.action_summary = { ...(r.action_summary as Row), total_cents: 4499 }
    expect((await gateFor(w, r)).status).toBe('failed')
  })

  it('changing the processor rebuilds the pack in that format: own field order, wording and checklist, not a relabel', async () => {
    const w = await world()
    const v = await packFor(w, '13422', 'visa')
    const m = await packFor(w, '13422', 'mastercard')
    expect(m.processor_label).toBe('Mastercard')
    expect(m.sections.map((s) => s.key)).toEqual(['dispute', 'action', 'grant', 'terms', 'delivery', 'merchant_review', 'verdict', 'receipt', 'eligibility'])
    expect(m.sections.map((s) => s.title)).not.toEqual(v.sections.map((s) => s.title))
    expect(m.needs.map((n) => n.item)).toEqual(expect.arrayContaining(['Authorisation code / initial authorisation date', 'Settlement Date (DE 15) / Central Site Business Date', 'Signed proof of delivery', 'Cardholder registration status (registered or guest checkout)']))
    expect(m.needs.map((n) => n.item)).not.toContain('Payment credential (last 4 / token only)')
    expect(m.notes).toContain(MC_REGISTRATION_LINE)
    expect(m.notes).not.toContain(CE3_LINE)
    // a Visa condition is never translated with the Mastercard table
    expect(m.claim.condition_name).toBeNull()
    expect(m.claim.condition_plain).toMatch(/Filed under Visa as "10\.4 — Other Fraud, Card-Absent Environment"\. This Mastercard format has no translation/)
    expect(m.pack_hash).not.toBe(v.pack_hash)
    // the underlying record does not change between formats
    const grantOf = (p: typeof v) => p.sections.find((s) => s.key === 'grant')!.items
    expect(grantOf(m)).toEqual(grantOf(v))
    expect(m.sections.find((s) => s.key === 'verdict')!.verdict).toEqual(v.sections.find((s) => s.key === 'verdict')!.verdict)
  })

  it('the seeded pack generation record matches the pack rebuilt from the record (same canonical JSON hash)', async () => {
    const w = await world()
    const p = await packFor(w, '13422', 'visa')
    const ev = w.tables.dispute_events.find((e) => e.event_type === 'pack_generated')!
    expect((ev.basis as Row).pack_hash).toBe(p.pack_hash)
    expect(await packHashOf(p)).toBe(p.pack_hash)
    expect(p.text_source).toBe('rules-fallback')
    expect(p.text_label).toBe(FALLBACK_LABEL)
  })

  it('JSON and printable view come from one object: same grant, action, verdict and hash', async () => {
    const w = await world()
    const p = await packFor(w, '13422', 'visa')
    const events = w.tables.dispute_events as never
    const json = packExport(p, events)
    const html = packToHtml(p, events)
    expect(json.pack).toBe(p)
    for (const v of [p.pack_hash, p.tamper_line, '$500.00 max', '$489.83', 'Free returns within 30 days', 'Not specified by the customer — no product scope check', p.disclaimer]) {
      expect(html).toContain(v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
      expect(JSON.stringify(json)).toContain(JSON.stringify(v).slice(1, -1))
    }
    expect(json.merchant_reported.map((m) => [m.entry, m.date])).toEqual([['Fought (submitted to acquirer)', '2026-11-01'], ['Won', '2026-11-02']])
  })

  it('no build vocabulary ("Layer 1 / 2 / 3") in the printable view or the downloaded JSON, in either format', async () => {
    const w = await world()
    for (const proc of ['visa', 'mastercard'] as const) {
      const p = await packFor(w, '13422', proc)
      expect(packToHtml(p, w.tables.dispute_events as never)).not.toMatch(/layer/i)
      expect(JSON.stringify(packExport(p, w.tables.dispute_events as never))).not.toMatch(/layer/i)
    }
  })

  it('printable view carries the same legend at the top; a sample pack is marked once and never as a filing', async () => {
    const w = await world()
    const real = await packFor(w, '13422', 'visa')
    const html = packToHtml(real, [])
    expect(html).toContain('<b class="real">Blue</b> = real data from the transaction record. <b class="sample">Orange</b> = sample data — what we would receive from merchant dispute records when the store is connected.')
    expect(html.indexOf('class="legend"')).toBeLessThan(html.indexOf('<h1>'))
    expect(real.sample).toBe(false)
    expect(html).not.toContain(SAMPLE_LABEL)
    const receipt = w.tables.receipts.find((r) => r.order_ref === '13422')!
    const sample = await packFor(w, '13422', 'visa', { dispute: { ...sampleDisputeFor(receipt as never) } as never })
    expect(sample.sample).toBe(true)
    const sh = packToHtml(sample, [])
    expect(sh.split(SAMPLE_LABEL).length - 1).toBe(1) // marked once
    expect(sh).toContain('<span class="sample">SAMPLE-13422-VISA-104</span>')
    expect(sh).toContain('<span class="real">Ivan Dijkstra</span>')
    // the real record is identical in both packs
    for (const k of ['grant', 'action', 'terms', 'verdict', 'receipt']) {
      expect(sample.sections.find((x) => x.key === k)).toEqual(real.sections.find((x) => x.key === k))
    }
  })

  it('no recommendation, classifier, win probability or score anywhere in the pack or the printable view', async () => {
    const w = await world()
    for (const proc of ['visa', 'mastercard'] as const) {
      const p = await packFor(w, '13422', proc)
      expect(textOf(p)).not.toMatch(RECOMMENDATION)
      expect(packToHtml(p, [])).not.toMatch(RECOMMENDATION)
      expect(Object.keys(p)).not.toEqual(expect.arrayContaining(['recommendation']))
    }
  })
})

describe('Dispute Agent: record a dispute (manual form, through the edge function)', () => {
  it('an order that is not an AgentReceipt order builds no pack and writes nothing', async () => {
    const w = await world()
    const r = await w.call('record_dispute', { order_ref: 'TEST-99999', processor: 'visa', claim: 'x', claim_type: 'other', reason_code: '10.4', dispute_date: '2026-11-01' })
    expect(r).toEqual({ type: 'not_agent_order', message: NOT_AGENT_ORDER, gap: false })
    expect(NOT_AGENT_ORDER).toBe('Not an Agent Receipt order — no evidence package built.')
    expect(w.writes).toEqual([])
    // 14522 is a recorded gap (no receipt): still no pack
    expect(await w.call('record_dispute', { order_ref: '14522', processor: 'visa', claim: 'x', claim_type: 'other', reason_code: '10.4', dispute_date: '2026-11-01' })).toMatchObject({ type: 'not_agent_order', gap: true })
    expect(w.writes).toEqual([])
  })

  it('a second dispute for the same order is out of scope: the first dispute is kept, nothing written', async () => {
    const w = await world()
    const r = await w.call('record_dispute', { order_ref: '13422', processor: 'mastercard', claim: 'again', claim_type: 'other', reason_code: '4853', dispute_date: '2026-11-03' })
    expect(r).toMatchObject({ type: 'out_of_scope', message: ONE_DISPUTE })
    expect(w.writes).toEqual([])
    expect(w.tables.disputes).toHaveLength(1)
  })

  it('records the dispute as filed, with the code kept as filed and sealed in the chain; merchant isolation by merchant_id', async () => {
    const w = await world()
    const r = await w.call('record_dispute', { order_ref: '12322', processor: 'visa', claim: 'Item not as described', claim_type: 'not_as_described', reason_code: '10.4', dispute_date: '2026-11-03', dispute_amount_cents: 50995 })
    expect(r.type).toBe('dispute_recorded')
    const d = w.tables.disputes.find((x) => x.reason === 'Item not as described')!
    expect(d).toMatchObject({ processor: 'visa', reason_code: '10.4', claim_type: 'not_as_described', processor_reference: null, merchant_id: MERCHANT_ID })
    const opened = w.writes.find((x) => x.table === 'dispute_events')!.row
    expect(opened).toMatchObject({ event_type: 'opened', basis: expect.objectContaining({ reason_code: '10.4', claim: 'Item not as described' }) })
    // code as filed does not fit the claim: flagged, not corrected
    const p = await packFor(w, '12322', 'visa', { gate: { status: 'passed', receipt_hash: 'sha256:x' } })
    expect(p.claim.condition_as_filed).toBe('10.4')
    expect(p.claim.code_flag).toBe('Code does not match claim — confirm with acquirer.')
    // another merchant cannot see or write this order
    const other = await ROUTES.record_dispute({ merchant_id: '00000000-0000-4000-a000-000000000099', order_ref: '13422', processor: 'visa', claim: 'x', claim_type: 'other', reason_code: '10.4', dispute_date: '2026-11-01' }, w.deps)
    expect(other).toMatchObject({ type: 'not_agent_order' })
    expect(await ROUTES.record_event({ merchant_id: '00000000-0000-4000-a000-000000000099', dispute_id: d.id, event_type: 'conceded' }, w.deps)).toMatchObject({ type: 'error' })
  })

  it('PayPal and other processors are refused in this build', async () => {
    const w = await world()
    expect(await w.call('record_dispute', { order_ref: '12322', processor: 'paypal', claim: 'x', claim_type: 'other', reason_code: 'x', dispute_date: '2026-11-03' })).toMatchObject({ type: 'error' })
  })
})

describe('Dispute Agent: Layer 2 merchant review record', () => {
  it('a flagged order with no merchant action says "No merchant review record." and nothing is backfilled', async () => {
    const w = await world()
    await w.call('record_dispute', { order_ref: '12322', processor: 'visa', claim: 'Misled about returns', claim_type: 'misrepresentation', reason_code: '13.5', dispute_date: '2026-11-03' })
    const p = await packFor(w, '12322', 'visa', { gate: { status: 'passed', receipt_hash: 'sha256:x' } })
    expect(p.merchant_review_statement).toMatch(new RegExp(`^${NO_REVIEW} This order was Review Required at Agent Receipt check and no merchant action was recorded at review time\\.`))
    expect(w.tables.merchant_reviews).toEqual([])
    // held, no shipment, no release: the merchant must say whether it shipped
    expect(p.needs.find((n) => n.item === 'Confirmation that this order shipped')).toMatchObject({ merchant_input: true })
    expect(p.claim_vs_record.find((e) => e.element === 'Returns')!.result).toBe('mismatch')
    expect(p.claim_vs_record.find((e) => e.element === 'Terms acknowledged by the customer')!.result).toBe('not_in_record')
  })

  it('a recorded merchant action is its own chained record, appended, with a server timestamp, and appears as Layer 2 with gaps shown', async () => {
    const w = await world()
    const receipt = w.tables.receipts.find((r) => r.order_ref === '12322')!
    const before = JSON.stringify(w.tables.receipts)
    const r = await w.call('record_review', {
      receipt_id: receipt.id, action_taken: 'called_confirmed', method: 'phone', notes: 'Customer confirmed on the phone.',
      confirmed_total: '$509.95 total', confirmed_terms: null, release_decision: 'released', recorded_at: '1999-01-01T00:00:00Z',
    })
    expect(r.type).toBe('review_recorded')
    const review = w.tables.merchant_reviews[0]
    expect(review).toMatchObject({ recorded_at: '2026-11-03T10:00:00.000Z', confirmed_total: '$509.95 total', confirmed_terms: null, recorded_by: 'Northwind Outfitters' })
    expect(review.entry_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(w.tables.receipts)).toBe(before) // Layer 1 untouched
    await w.call('record_review', { receipt_id: receipt.id, action_taken: 'kept_on_hold', method: 'other', notes: 'Second note.', release_decision: 'not_released' })
    expect(w.tables.merchant_reviews).toHaveLength(2)
    expect(w.tables.merchant_reviews[0]).toEqual(review) // never overwritten

    await w.call('record_dispute', { order_ref: '12322', processor: 'visa', claim: 'Misled', claim_type: 'misrepresentation', reason_code: '13.5', dispute_date: '2026-11-03' })
    const p = await packFor(w, '12322', 'visa', { gate: { status: 'passed', receipt_hash: 'sha256:x' } })
    const l2 = p.sections.find((s) => s.key === 'merchant_review')!.items
    expect(l2.find((i) => i.label === 'Action taken (1)')!.value).toBe('Called customer and confirmed')
    expect(l2.find((i) => i.label === 'Confirmed total (1)')).toMatchObject({ status: 'present', value: '$509.95 total' })
    expect(l2.find((i) => i.label === 'Confirmed terms (1)')).toMatchObject({ status: 'missing', value: null })
    expect(p.needs.map((n) => n.item)).toContain('Confirmed terms in the merchant review record')
    expect(p.needs.map((n) => n.item)).not.toContain('Confirmed total in the merchant review record')
    expect(p.claim_vs_record.find((e) => e.element === 'Budget')!.record).toMatch(/Merchant review: confirmed total "\$509\.95 total"/)
    expect(p.needs.find((n) => n.item === 'Confirmation that this order shipped')).toBeUndefined() // released
  })

  it('merchant actions are only for Review Required / Hold for Suspicion orders, and only the listed fields', async () => {
    const w = await world()
    const pass = w.tables.receipts.find((r) => r.order_ref === '13422')!
    expect(await w.call('record_review', { receipt_id: pass.id, action_taken: 'called_confirmed', method: 'phone', notes: 'x', release_decision: 'released' })).toMatchObject({ type: 'error' })
    const hero = w.tables.receipts.find((r) => r.order_ref === '12322')!
    expect(await w.call('record_review', { receipt_id: hero.id, action_taken: 'sent_email_link', method: 'phone', notes: 'x', release_decision: 'released' })).toMatchObject({ type: 'error' })
    expect(await w.call('record_review', { receipt_id: hero.id, action_taken: 'kept_on_hold', method: 'phone', notes: 'x', confirmed_total: '$1', release_decision: 'not_released' })).toMatchObject({ type: 'error' })
    expect(w.tables.merchant_reviews).toEqual([])
  })
})

describe('Dispute Agent: merchant decisions, outcomes and pack records', () => {
  it('appends decisions and outcomes; never overwrites; Fought needs the submission date', async () => {
    const w = await world()
    const d = w.tables.disputes[0]
    const n0 = w.tables.dispute_events.length
    expect(await w.call('record_event', { dispute_id: d.id, event_type: 'represented' })).toMatchObject({ type: 'error' })
    expect(await w.call('record_event', { dispute_id: d.id, event_type: 'recommendation' })).toMatchObject({ type: 'error' })
    await w.call('record_event', { dispute_id: d.id, event_type: 'investigating', reason: 'Checking with the warehouse.' })
    await w.call('record_event', { dispute_id: d.id, event_type: 'outcome_pending', date: '2026-11-03' })
    await w.call('record_event', { dispute_id: d.id, event_type: 'merchant_note', reason: 'Called the acquirer.' })
    expect(w.tables.dispute_events.length).toBe(n0 + 3)
    expect(w.tables.dispute_events.slice(-1)[0]).toMatchObject({ event_type: 'merchant_note', basis: expect.objectContaining({ label: 'Dispute-time merchant note', recorded_at: '2026-11-03T10:00:00.000Z' }) })
  })

  it('format_pack sends Spark only this dispute\'s pack facts and falls back to template text when Spark is unavailable', async () => {
    const w = await world()
    const d = w.tables.disputes[0]
    const r = await w.call('format_pack', { dispute_id: d.id, processor: 'visa' })
    expect(r).toEqual({ type: 'texts', texts: null, text_source: 'rules-fallback', reason: 'no key (test)' })
    const input = w.sparkCalls[0] as Row
    expect(Object.keys(input).sort()).toEqual(['claim_as_filed', 'claim_type', 'condition_as_filed', 'condition_name', 'in_record', 'needed', 'order_ref', 'processor', 'receipt_ref'])
    expect(JSON.stringify(input)).not.toMatch(/private_chat|Jemaih|12322|AR-2026-0042|chat/i)
  })

  it('record_pack stores the version; refuses Spark texts that fail the check; repeats are not duplicated', async () => {
    const w = await world()
    const d = w.tables.disputes[0]
    const p = await packFor(w, '13422', 'mastercard')
    const r = await w.call('record_pack', { dispute_id: d.id, processor: 'mastercard', pack_hash: p.pack_hash, text_source: 'rules-fallback', texts: null })
    expect(r).toMatchObject({ type: 'pack_recorded', already: false })
    expect(await w.call('record_pack', { dispute_id: d.id, processor: 'mastercard', pack_hash: p.pack_hash, text_source: 'rules-fallback', texts: null })).toMatchObject({ already: true })
    const bad = await w.call('record_pack', { dispute_id: d.id, processor: 'visa', pack_hash: p.pack_hash, text_source: 'muse-spark', texts: { claim_plain: 'The customer was charged $1,000.', explanation: 'x' } })
    expect(bad).toMatchObject({ type: 'error', message: expect.stringMatching(/rejected/) })
  })
})

describe('Spark adds no facts: validator and client', () => {
  const input = { processor: 'Visa', order_ref: '13422', receipt_ref: 'AR-2026-0043', claim_as_filed: 'Agent overstep', claim_type: 'Agent bought outside what was authorised', condition_as_filed: '10.4', condition_name: 'Other Fraud — Card-Absent Environment', in_record: ['Budget (maximum total)'], needed: ['Proof of delivery'] }
  it('accepts plain text that only uses facts from the input', () => {
    expect(validateSparkTexts({ claim_plain: 'The customer says the agent bought outside what they allowed.', explanation: 'This Visa pack for order 13422 (AR-2026-0043) under 10.4 lists what the record holds; proof of delivery is still needed.' }, input).ok).toBe(true)
  })
  it.each([
    ['a new amount', 'The order cost $489.83.'],
    ['a new date', 'Filed on 2026-10-30.'],
    ['a new code', 'This looks like 4837.'],
    ['a hash', 'Hash sha256:abcdef.'],
    ['a DE value', 'Put COMP EVID in DE 72.'],
    ['a recommendation', 'You should fight this dispute.'],
    ['a prediction', 'The merchant is likely to win.'],
    ['a liability call', 'The customer is liable.'],
  ])('rejects %s', (_label, bad) => {
    expect(validateSparkTexts({ claim_plain: 'The customer disputes the order.', explanation: bad }, input).ok).toBe(false)
  })
  it('without a key, or with an answer that adds facts, the client returns rules-fallback', async () => {
    const si = sparkInput({ processor_label: 'Visa', order_ref: '13422', receipt_ref: 'AR-2026-0043', claim: { as_filed: 'Agent overstep', claim_type: 'agent_outside_grant', claim_type_label: 'x', condition_as_filed: '10.4', condition_name: null, condition_plain: '', code_flag: null }, sections: [], needs: [] })
    expect(await createSparkTextWriter(undefined).write(si)).toMatchObject({ texts: null, text_source: 'rules-fallback' })
    const fake = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"claim_plain":"Customer says agent spent $900.","explanation":"x"}' } }] }))) as unknown as typeof fetch
    expect(await createSparkTextWriter('k', fake).write(si)).toMatchObject({ texts: null, text_source: 'rules-fallback', reason: expect.stringMatching(/rejected/) })
    const good = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"claim_plain":"Customer says the agent overstepped.","explanation":"This Visa pack for order 13422 lays out the record."}' } }] }))) as unknown as typeof fetch
    expect(await createSparkTextWriter('k', good).write(si)).toMatchObject({ text_source: 'muse-spark' })
  })
})

describe('disputes function: boundaries', () => {
  const DIR = join(__dirname, '..', '..', 'supabase', 'functions', 'disputes')
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
  it('keeps byte-identical copies of the hash spec and chain append', () => {
    expect(readFileSync(join(DIR, 'hash.ts'), 'utf8')).toBe(readFileSync(join(DIR, '..', '_shared', 'hash.ts'), 'utf8'))
    expect(readFileSync(join(DIR, 'chain.ts'), 'utf8')).toBe(readFileSync(join(DIR, '..', 'auditor', 'chain.ts'), 'utf8'))
  })
  it('never reads chat, sessions beyond the gap check, or other merchants; reads the model key by name only', () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.ts'))) {
      const text = strip(readFileSync(join(DIR, f), 'utf8'))
      expect(text, f).not.toMatch(/private_chat|session_events|shopper-agent|reasoning/i)
      expect(text, f).not.toMatch(/from\s+['"]\.\.\//)
    }
    const index = readFileSync(join(DIR, 'index.ts'), 'utf8')
    expect(index).toContain("Deno.env.get('MODEL_API_KEY')")
    expect(index).not.toMatch(/MODEL_API_KEY\s*=|sb_secret|service_role.*=/)
    expect([...readFileSync(join(DIR, 'store.ts'), 'utf8').matchAll(/from\('chain_entries'\)\.select\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['entry_hash'])
  })
  it('has no recommendation, classifier or score in the pack builder or the write path', () => {
    for (const f of ['pack.ts', 'run.ts']) {
      const code = strip(readFileSync(join(DIR, f), 'utf8')).replace(/const FORBIDDEN = .*$/m, '').replace(/'recommendation'/g, '')
      expect(code, f).not.toMatch(/recommend|classif|win_prob|probability|score/i)
    }
  })
})

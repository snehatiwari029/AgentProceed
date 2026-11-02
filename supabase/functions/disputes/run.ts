// Dispute Agent write path, one request at a time. Pure TypeScript: the database, the model and the clock are injected,
// so tests run it. Runs in the `disputes` edge function with the service role. The browser never writes.
//
// Actions (and nothing else; this is not a general write API):
//   record_dispute  a dispute the merchant received, as filed. Builds nothing for an order that is not an Agent Receipt order.
//   record_review   Layer 2: what the merchant did after a Review Required / Hold for Suspicion flag. Appended, never edited.
//   record_event    merchant tracking: pack downloaded, fought (submitted), conceded, investigating, outcome, dispute-time note.
//   format_pack     Spark plain-language texts for one dispute's pack, validated; rules-fallback when Spark is unavailable.
//   record_pack     records that a pack was generated: processor format, pack hash, text source.
//
// MERCHANT ISOLATION: every action names a merchant_id, and every record it reads or writes must belong to that merchant
// (receipt.merchant_id). Reads are by id for that one order: its grant, proposal, checkout action, shipment, merchant
// reviews and dispute. From the rest of the chain it reads the newest hash only, to link the next entry.
// No chat, no shopper reasoning, no other order, no other merchant. No recommendation, classifier or score.
import { appendChained, type ChainDb } from './chain.ts'
import { CLAIM_TYPES, PROCESSORS, buildPack, sparkInput, validateSparkTexts, type PackInput, type Processor, type Texts } from './pack.ts'
import type { PackTextWriter } from './spark.ts'

type Row = Record<string, unknown>

export interface DisputesDb extends ChainDb {
  merchant(id: string): Promise<{ id: string; name: string } | null>
  receiptByOrderRef(merchantId: string, orderRef: string): Promise<Row | null>
  gapSessionForOrder(merchantId: string, orderRef: string): Promise<boolean>
  receiptById(merchantId: string, id: string): Promise<Row | null>
  disputeForReceipt(receiptId: string): Promise<Row | null>
  disputeById(id: string): Promise<Row | null>
  events(disputeId: string): Promise<Row[]>
  grant(id: string): Promise<Row | null>
  proposal(id: string): Promise<Row | null>
  checkout(grantId: string): Promise<Row | null>
  shipment(receiptId: string): Promise<Row | null>
  reviews(receiptId: string): Promise<Row[]>
  insertPlain(table: 'disputes', row: Row): Promise<void>
}

export type DisputesDeps = { db: DisputesDb; writer: PackTextWriter; now: () => Date; newId: () => string }

export type Reply =
  | { type: 'not_agent_order'; message: string; gap: boolean }
  | { type: 'out_of_scope'; message: string; dispute_id: string }
  | { type: 'dispute_recorded'; dispute_id: string }
  | { type: 'review_recorded'; review: Row }
  | { type: 'event_recorded'; event: Row }
  | { type: 'texts'; texts: Texts | null; text_source: 'muse-spark' | 'rules-fallback'; reason: string | null }
  | { type: 'pack_recorded'; event: Row; already: boolean }
  | { type: 'error'; message: string }

export const NOT_AGENT_ORDER = 'Not an Agent Receipt order — no evidence package built.'
export const ONE_DISPUTE = 'This order already has a dispute. One dispute per order is in scope for this build: the first dispute is kept unchanged and nothing was written.'

const err = (message: string): Reply => ({ type: 'error', message })
const UUID = /^[0-9a-f-]{36}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.length <= max ? t : null
}
const optText = (v: unknown, max: number): string | null | false => {
  if (v === undefined || v === null || v === '') return null
  const t = text(v, max)
  return t === null ? false : t
}
const validDay = (v: unknown) => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

async function merchantOf(body: Row, db: DisputesDb) {
  const id = body.merchant_id
  if (typeof id !== 'string' || !UUID.test(id)) return null
  return db.merchant(id)
}

// One dispute's own records, read for that merchant only.
async function recordFor(db: DisputesDb, merchantId: string, disputeId: unknown) {
  if (typeof disputeId !== 'string' || !UUID.test(disputeId)) return null
  const dispute = await db.disputeById(disputeId)
  if (!dispute || typeof dispute.receipt_id !== 'string') return null
  const receipt = await db.receiptById(merchantId, dispute.receipt_id)
  if (!receipt) return null
  const grant = typeof receipt.grant_id === 'string' ? await db.grant(receipt.grant_id) : null
  const proposal = typeof receipt.proposal_id === 'string' ? await db.proposal(receipt.proposal_id) : null
  const action = typeof receipt.grant_id === 'string' ? await db.checkout(receipt.grant_id) : null
  const shipment = await db.shipment(receipt.id as string)
  const reviews = await db.reviews(receipt.id as string)
  return { dispute, receipt, grant, proposal, action, shipment, reviews }
}

// The pack as the server sees it, for Spark's input and for checking texts. The tamper gate runs in the dashboard on the
// order's own chain before the pack is shown; it is not part of what Spark receives.
async function serverPack(rec: NonNullable<Awaited<ReturnType<typeof recordFor>>>, merchant: { id: string; name: string }, processor: Processor) {
  const input: PackInput = { processor, merchant, ...rec, gate: { status: 'not_run', message: 'Runs in the dashboard before the pack is shown.' } }
  return buildPack(input)
}

export async function recordDispute(body: Row, deps: DisputesDeps): Promise<Reply> {
  const { db } = deps
  const merchant = await merchantOf(body, db)
  if (!merchant) return err('Unknown merchant.')
  const orderRef = text(body.order_ref, 40)
  if (!orderRef) return err('Order id is required.')
  const processor = body.processor
  if (!(PROCESSORS as unknown[]).includes(processor)) return err('Processor must be Visa or Mastercard.')
  const claim = text(body.claim, 500)
  if (!claim) return err('Dispute claim as filed is required.')
  const claimType = body.claim_type
  if (!(CLAIM_TYPES as unknown[]).includes(claimType)) return err('Claim type is required.')
  const reasonCode = text(body.reason_code, 120)
  if (!reasonCode) return err('Reason code / condition as filed is required.')
  if (!validDay(body.dispute_date)) return err('Dispute date is required (YYYY-MM-DD).')
  const amount = body.dispute_amount_cents
  if (amount !== null && amount !== undefined && !(typeof amount === 'number' && Number.isInteger(amount) && amount >= 0)) return err('Dispute amount must be a positive amount.')
  const reference = optText(body.processor_reference, 120)
  const channel = optText(body.channel, 120)
  if (reference === false || channel === false) return err('Reference or channel is too long.')

  // Step 2: did this order go through the Agent Receipt agentic order pipeline? No receipt = no pack, nothing written.
  const receipt = await db.receiptByOrderRef(merchant.id, orderRef)
  if (!receipt) return { type: 'not_agent_order', message: NOT_AGENT_ORDER, gap: await db.gapSessionForOrder(merchant.id, orderRef) }
  const existing = await db.disputeForReceipt(receipt.id as string)
  if (existing) return { type: 'out_of_scope', message: ONE_DISPUTE, dispute_id: existing.id as string }

  const id = deps.newId()
  const at = deps.now().toISOString()
  const filed = {
    processor, channel, claim_type: claimType, reason_code: reasonCode, dispute_date: body.dispute_date,
    dispute_amount_cents: amount ?? null, processor_reference: reference,
  }
  await db.insertPlain('disputes', { id, receipt_id: receipt.id, merchant_id: merchant.id, reason: claim, opened_at: at, ...filed })
  // The filed fields are sealed in the chain with the 'opened' entry.
  await appendChained(db, 'dispute_events', {
    id: deps.newId(), dispute_id: id, event_type: 'opened', decided_by: merchant.name, basis: { ...filed, claim, order_ref: orderRef, entered_by: 'merchant (Record a dispute form)' },
  })
  return { type: 'dispute_recorded', dispute_id: id }
}

const ACTIONS = ['called_confirmed', 'emailed_confirmed', 'investigated_cleared', 'override_documented', 'kept_on_hold', 'cancelled']
const METHODS = ['phone', 'email', 'chat', 'in_person', 'other']

export async function recordReview(body: Row, deps: DisputesDeps): Promise<Reply> {
  const { db } = deps
  const merchant = await merchantOf(body, db)
  if (!merchant) return err('Unknown merchant.')
  if (typeof body.receipt_id !== 'string' || !UUID.test(body.receipt_id)) return err('receipt_id is required.')
  const receipt = await db.receiptById(merchant.id, body.receipt_id)
  if (!receipt) return err('Order not found for this merchant.')
  if (receipt.decision !== 'review_required' && receipt.decision !== 'hold_suspicion') return err('A merchant action is recorded only for Review Required or Hold for Suspicion orders.')
  if (!ACTIONS.includes(body.action_taken as string)) return err('Action taken is required.')
  if (!METHODS.includes(body.method as string)) return err('Method is required.')
  const notes = text(body.notes, 2000)
  if (!notes) return err('Reason / notes are required, in your own words.')
  const confirming = body.action_taken === 'called_confirmed' || body.action_taken === 'emailed_confirmed'
  const total = optText(body.confirmed_total, 200)
  const terms = optText(body.confirmed_terms, 400)
  if (total === false || terms === false) return err('Confirmed total or terms is too long.')
  if (!confirming && (total || terms)) return err('Confirmed total and terms are recorded only for a confirmation.')
  if (body.release_decision !== 'released' && body.release_decision !== 'not_released') return err('Release decision is required.')
  const row = {
    id: deps.newId(), receipt_id: receipt.id, merchant_id: merchant.id, action_taken: body.action_taken, method: body.method, notes,
    confirmed_total: total, confirmed_terms: terms, release_decision: body.release_decision, recorded_by: merchant.name,
    recorded_at: deps.now().toISOString(), // set here, never by the merchant
  }
  return { type: 'review_recorded', review: await appendChained(db, 'merchant_reviews', row) }
}

const EVENTS = ['pack_downloaded', 'represented', 'conceded', 'investigating', 'outcome_won', 'outcome_lost', 'outcome_conceded', 'outcome_pending', 'merchant_note']

export async function recordEvent(body: Row, deps: DisputesDeps): Promise<Reply> {
  const { db } = deps
  const merchant = await merchantOf(body, db)
  if (!merchant) return err('Unknown merchant.')
  const rec = await recordFor(db, merchant.id, body.dispute_id)
  if (!rec) return err('Dispute not found for this merchant.')
  const type = body.event_type
  if (!EVENTS.includes(type as string)) return err('Unknown merchant action.')
  const dateGiven = body.date !== undefined && body.date !== null && body.date !== ''
  if (dateGiven && !validDay(body.date)) return err('Date must be YYYY-MM-DD.')
  if (type === 'represented' && !dateGiven) return err('Enter the date you submitted the pack to your acquirer.')
  const reason = optText(body.reason, 2000)
  if (reason === false) return err('Reason is too long.')
  if (type === 'merchant_note' && !reason) return err('Enter the note.')
  const basis: Row = { date: dateGiven ? body.date : null, reason, recorded_at: deps.now().toISOString() }
  if (type === 'merchant_note') basis.label = 'Dispute-time merchant note'
  const event = await appendChained(db, 'dispute_events', { id: deps.newId(), dispute_id: rec.dispute.id, event_type: type, decided_by: merchant.name, basis })
  return { type: 'event_recorded', event }
}

export async function formatPack(body: Row, deps: DisputesDeps): Promise<Reply> {
  const { db } = deps
  const merchant = await merchantOf(body, db)
  if (!merchant) return err('Unknown merchant.')
  if (!(PROCESSORS as unknown[]).includes(body.processor)) return err('Processor must be Visa or Mastercard.')
  const rec = await recordFor(db, merchant.id, body.dispute_id)
  if (!rec) return err('Dispute not found for this merchant.')
  const pack = await serverPack(rec, merchant, body.processor as Processor)
  const out = await deps.writer.write(sparkInput(pack))
  return { type: 'texts', ...out }
}

export async function recordPack(body: Row, deps: DisputesDeps): Promise<Reply> {
  const { db } = deps
  const merchant = await merchantOf(body, db)
  if (!merchant) return err('Unknown merchant.')
  const processor = body.processor
  if (!(PROCESSORS as unknown[]).includes(processor)) return err('Processor must be Visa or Mastercard.')
  if (typeof body.pack_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(body.pack_hash)) return err('pack_hash is required.')
  const rec = await recordFor(db, merchant.id, body.dispute_id)
  if (!rec) return err('Dispute not found for this merchant.')
  const source = body.text_source === 'muse-spark' ? 'muse-spark' : 'rules-fallback'
  let texts: Texts | null = null
  if (source === 'muse-spark') {
    // Texts are checked again here, against this server's own read of the record.
    const v = validateSparkTexts(body.texts, sparkInput(await serverPack(rec, merchant, processor as Processor)))
    if (!v.ok) return err(`Spark texts rejected: ${v.reason}`)
    texts = v.texts
  }
  const events = await db.events(rec.dispute.id as string)
  const last = [...events].reverse().find((e) => e.event_type === 'pack_generated' && (e.basis as Row | null)?.processor === processor)
  if (last && (last.basis as Row).pack_hash === body.pack_hash) return { type: 'pack_recorded', event: last, already: true }
  const event = await appendChained(db, 'dispute_events', {
    id: deps.newId(), dispute_id: rec.dispute.id, event_type: 'pack_generated', decided_by: 'Evidence Packet (pack builder)',
    basis: { processor, pack_hash: body.pack_hash, text_source: source, texts, generated_at: deps.now().toISOString() },
  })
  return { type: 'pack_recorded', event, already: false }
}

export const ROUTES: Record<string, (body: Row, deps: DisputesDeps) => Promise<Reply>> = {
  record_dispute: recordDispute, record_review: recordReview, record_event: recordEvent, format_pack: formatPack, record_pack: recordPack,
}

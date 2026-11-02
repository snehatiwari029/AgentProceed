// Generates supabase/seed_dashboard_demo.sql. Deterministic: same input, same output, byte for byte.
//   npm run seed:generate
// Every hash comes from supabase/functions/_shared/hash.ts (the same code the receipt function will use).
// Nothing here is hand-written hash data.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GENESIS_HASH, computeEntryHash, canonicalJson } from '../supabase/functions/_shared/hash'
import { audit } from '../supabase/functions/_shared/audit'
import { auditInputFromRecords } from '../supabase/functions/_shared/audit-input'
import { parseExactDeliveryPhrase } from '../supabase/functions/auditor/spark'
import { buildPack } from '../supabase/functions/disputes/pack'
import { verifyOrderChain, type ChainRecord } from '../src/shared/chain'

// Ids of this Supabase project's existing rows (read once from the database). The seed SQL checks
// them before inserting and stops with a clear error if they differ.
export const MERCHANT_ID = '32b14be6-26e6-49df-a7af-79532f910510'
export const BURTON_ID = '40c70768-77ac-4953-8bae-c75c8319fcf4'
export const ORCA_ID = 'd53088eb-40e0-4fa5-b2f8-1b81e9c7c37e'
export const NITRO_ID = '9a3f8acb-8e2f-4ffe-b83c-085d54b96765'

type Kind = 'uuid' | 'text' | 'int' | 'bool' | 'date' | 'ts' | 'json' | 'texts'
type Cols = [string, Kind][]

export const TABLES: Record<string, Cols> = {
  sessions: [['id', 'uuid'], ['merchant_id', 'uuid'], ['detection_source', 'text'], ['agent_id', 'text'], ['agent_verified', 'bool'], ['agent_verified_simulated', 'bool'], ['gap_note', 'text'], ['opened_at', 'ts']],
  grants: [['id', 'uuid'], ['session_id', 'uuid'], ['version', 'int'], ['supersedes_grant_id', 'uuid'], ['shopper_ref', 'text'], ['agent_id', 'text'], ['agent_verified', 'bool'], ['merchant_id', 'uuid'], ['product_scope', 'text'], ['size_min_cm', 'int'], ['size_max_cm', 'int'], ['colour_preference', 'text'], ['currency', 'text'], ['amount_max_cents', 'int'], ['budget_limit_cents', 'int'], ['payment_method_ref', 'text'], ['shipping_method', 'text'], ['shipping_max_cost_cents', 'int'], ['delivery_by', 'date'], ['return_policy_required', 'bool'], ['confirmed_at', 'ts'], ['expires_at', 'ts'], ['private_chat_hash', 'text'], ['grant_json', 'json'], ['system_metadata', 'json'], ['schema_label', 'text'], ['created_at', 'ts'], ['chain_seq', 'int'], ['prev_hash', 'text'], ['entry_hash', 'text']],
  proposals: [['id', 'uuid'], ['grant_id', 'uuid'], ['product_id', 'uuid'], ['shown_item_price_cents', 'int'], ['shown_total_cents', 'int'], ['shown_returns_summary', 'text'], ['shown_delivery', 'text'], ['shown_at', 'ts'], ['confirmation_ref', 'text'], ['confirmed_at', 'ts'], ['created_at', 'ts'], ['chain_seq', 'int'], ['prev_hash', 'text'], ['entry_hash', 'text']],
  actions: [['id', 'uuid'], ['grant_id', 'uuid'], ['seq', 'int'], ['type', 'text'], ['detail', 'json'], ['agent_believed_terms', 'json'], ['image_evidence_ref', 'json'], ['created_at', 'ts'], ['chain_seq', 'int'], ['prev_hash', 'text'], ['entry_hash', 'text']],
  receipts: [['id', 'uuid'], ['receipt_ref', 'text'], ['order_ref', 'text'], ['grant_id', 'uuid'], ['proposal_id', 'uuid'], ['merchant_id', 'uuid'], ['terms_snapshot', 'json'], ['action_summary', 'json'], ['mismatch_results', 'json'], ['problems_found', 'int'], ['recommendation', 'text'], ['missing_components', 'texts'], ['image_evidence_ref', 'json'], ['schema_label', 'text'], ['sealed_at', 'ts'], ['decision', 'text'], ['audit', 'json'], ['fulfillment', 'text'], ['created_at', 'ts'], ['chain_seq', 'int'], ['prev_hash', 'text'], ['entry_hash', 'text']],
  shipments: [['id', 'uuid'], ['receipt_id', 'uuid'], ['merchant_id', 'uuid'], ['shipped_on', 'date'], ['delivered_on', 'date'], ['carrier', 'text'], ['tracking_ref', 'text'], ['delivery_proof_ref', 'text'], ['source', 'text'], ['created_at', 'ts'], ['chain_seq', 'int'], ['prev_hash', 'text'], ['entry_hash', 'text']],
  disputes: [['id', 'uuid'], ['receipt_id', 'uuid'], ['merchant_id', 'uuid'], ['reason', 'text'], ['processor', 'text'], ['channel', 'text'], ['claim_type', 'text'], ['reason_code', 'text'], ['dispute_date', 'date'], ['dispute_amount_cents', 'int'], ['processor_reference', 'text'], ['opened_at', 'ts'], ['created_at', 'ts']],
  dispute_events: [['id', 'uuid'], ['dispute_id', 'uuid'], ['event_type', 'text'], ['decided_by', 'text'], ['basis', 'json'], ['created_at', 'ts'], ['chain_seq', 'int'], ['prev_hash', 'text'], ['entry_hash', 'text']],
}

type Row = Record<string, unknown>
export type SeedRecord = { table: string; entry_type: string | null; row: Row }

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
// Deterministic uuid from a label.
export function uid(label: string): string {
  const h = sha(`agentreceipt-seed:${label}`)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
const chatHash = (order: string) => `sha256:${sha(`seeded-demo:no-private-chat-text:${order}`)}`
const LABEL = 'VI-aligned demo representation'

const records: SeedRecord[] = []
let seq = 0
let lastHash = GENESIS_HASH

// Adds a chained row: assigns the next chain_seq, links it to the previous entry and hashes it.
async function chain(table: string, entryType: string, row: Row): Promise<Row> {
  seq += 1
  const full: Row = { ...row, chain_seq: seq, prev_hash: lastHash }
  const entry_hash = await computeEntryHash(lastHash, full)
  const done = { ...full, entry_hash }
  lastHash = entry_hash
  records.push({ table, entry_type: entryType, row: done })
  return done
}
function plain(table: string, row: Row) {
  records.push({ table, entry_type: null, row })
}

const at = (hhmm: string) => `2026-10-26T${hhmm}:00.000Z`
const on = (day: string, hhmm: string) => `2026-${day}T${hhmm}:00.000Z`

type Scenario = {
  key: string
  order_ref: string | null
  receipt_ref: string
  shopper: string
  agent: string
  at: { grant: string; proposal: string; action: string; receipt: string }
  grant: { product_scope: string | null; colour: string | null; return_required: boolean | null; delivery_by: string | null }
  proposal: { product: string; item: number; total: number | null; returns: string; delivery: string }
  action: Row & { detail: Row; believed: Row }
  terms: Row
  summary: Row
  fulfillment: 'proceed' | 'held' | 'shipped_override'
  payment_detail: string // payment method detail recorded on the grant JSON, the action and the receipt
  recommendation: 'represent' | 'concede' | null // post-dispute only; null when no dispute exists
}


async function build(s: Scenario) {
  const sid = uid(`${s.key}:session`)
  plain('sessions', {
    id: sid, merchant_id: MERCHANT_ID, detection_source: 'self_declared_simulated', agent_id: s.agent,
    agent_verified: true, agent_verified_simulated: true, gap_note: null, opened_at: at(s.at.grant),
  })
  const gid = uid(`${s.key}:grant`)
  const confirmed = at(s.at.grant)
  const expires = new Date(Date.parse(confirmed) + 24 * 3600 * 1000).toISOString()
  const sealed = {
    shopper_ref: s.shopper, agent_id: s.agent, agent_verified: true, merchant_id: MERCHANT_ID,
    product_scope: s.grant.product_scope, size_min_cm: 150, size_max_cm: 165, colour_preference: s.grant.colour,
    currency: 'USD', amount_max_cents: 50000, budget_limit_cents: 50000, payment_method_ref: 'Demo Checkout',
    shipping_method: null, shipping_max_cost_cents: null, delivery_by: s.grant.delivery_by,
    return_policy_required: s.grant.return_required, confirmed_at: confirmed, expires_at: expires,
  }
  const grantRow = await chain('grants', 'grant', {
    id: gid, session_id: sid, version: 1, supersedes_grant_id: null, ...sealed,
    private_chat_hash: chatHash(s.key), grant_json: JSON.parse(canonicalJson({ ...sealed, payment_method_detail: s.payment_detail, payment_simulated: true })),
    system_metadata: {
      data_sharing_limits: 'grant fields only, this purchase only', checked: false, priority: 'P1',
      seeded_demo: true, private_chat_hash_note: 'Seeded demo row: no private chat exists, the hash is of a fixed label.',
    },
    schema_label: LABEL, created_at: confirmed,
  })
  const pid = uid(`${s.key}:proposal`)
  const proposalRow = await chain('proposals', 'proposal', {
    id: pid, grant_id: gid, product_id: s.proposal.product, shown_item_price_cents: s.proposal.item,
    shown_total_cents: s.proposal.total, shown_returns_summary: s.proposal.returns, shown_delivery: s.proposal.delivery,
    shown_at: at(s.at.proposal), confirmation_ref: `PC-${s.key}`, confirmed_at: at(s.at.proposal), created_at: at(s.at.proposal),
  })
  const actionRow = await chain('actions', 'action', {
    id: uid(`${s.key}:action`), grant_id: gid, seq: 1, type: 'checkout', detail: { ...s.action.detail, sealed_at: at(s.at.action) },
    agent_believed_terms: s.action.believed, image_evidence_ref: null, created_at: at(s.at.action),
  })
  const rid = uid(`${s.key}:receipt`)
  // The verdict comes from the same engine the live auditor runs. Nothing here is hand-written.
  const verdict = audit(auditInputFromRecords({
    session_opened: true, grant: grantRow, proposal: proposalRow, action: actionRow,
    product: { category: s.terms.category as string, formal_returns: s.terms.formal_returns as string, formal_terms_text: s.terms.formal_terms_text as string, merchant_name: s.terms.merchant as string },
    merchant_name: 'Northwind Outfitters',
    hash: { grant_ok: true, proposal_ok: true, action_ok: true, links_ok: true },
    semantic_delivery: { claimed_date: parseExactDeliveryPhrase(s.proposal.delivery, '2026-10-26'), source: 'rules-fallback' },
  }))
  const receipt = await chain('receipts', 'receipt', {
    id: rid, receipt_ref: s.receipt_ref, order_ref: s.order_ref, grant_id: gid, proposal_id: pid, merchant_id: MERCHANT_ID,
    terms_snapshot: s.terms, action_summary: s.summary, mismatch_results: verdict.checks, problems_found: verdict.problems,
    recommendation: s.recommendation, missing_components: verdict.missing_components, image_evidence_ref: null, schema_label: LABEL,
    sealed_at: at(s.at.receipt), decision: verdict.decision, audit: verdict, fulfillment: s.fulfillment, created_at: at(s.at.receipt),
  })
  return { gid, rid, receipt }
}

export async function buildSeed(): Promise<{ sql: string; records: SeedRecord[] }> {
  records.length = 0
  seq = 0
  lastHash = GENESIS_HASH

  const burtonTerms = {
    merchant: 'Northwind Outfitters', category: 'snowboard', product_id: BURTON_ID, product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton',
    size_cm: 156, colour: 'Serpent', price_cents: 44995, formal_returns: 'final_sale', formal_terms_text: 'Final Sale',
    terms_version: 'v1', standard_shipping_cents: 0, standard_delivery_days: 5, expedited_shipping_cents: 6000, expedited_delivery_days: 2,
  }
  const orcaTerms = {
    merchant: 'Northwind Outfitters', category: 'snowboard', product_id: ORCA_ID, product_name: 'T. Rice Orca Snowboard 2025/2026', brand: 'Lib Tech',
    size_cm: 156, colour: null, price_cents: 48983, formal_returns: 'free', formal_terms_text: 'Free returns within 30 days',
    terms_version: 'v1', standard_shipping_cents: 0, standard_delivery_days: 3, expedited_shipping_cents: null, expedited_delivery_days: null,
  }

  // 1) Tamper example: earlier, compliant order of $449.95. Filler customer/agent: only used to make a valid chain.
  const t = await build({
    key: '0041', order_ref: null, receipt_ref: 'AR-2026-0041', shopper: 'Ivan Dijkstra', agent: 'instinct-kk14680',
    at: { grant: '13:00', proposal: '13:04', action: '13:06', receipt: '13:07' },
    grant: { product_scope: 'snowboard', colour: null, return_required: null, delivery_by: null },
    proposal: { product: BURTON_ID, item: 44995, total: 44995, returns: 'Final sale', delivery: 'Sat Oct 31' },
    action: {
      detail: { product_id: BURTON_ID, product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', item_price_cents: 44995, shipping_method: 'standard', shipping_cents: 0, total_cents: 44995, delivery_date: '2026-10-31', payment_method: 'Demo Checkout', payment_method_detail: 'PayPal', payment_simulated: true, agent_summary: { returns: 'Final sale' } },
      believed: { returns: 'Final sale' },
    },
    terms: burtonTerms,
    summary: { order_status: 'Confirmed', product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', item_price_cents: 44995, shipping_method: 'standard', shipping_cents: 0, total_cents: 44995, delivery_date: '2026-10-31', payment_method: 'Demo Checkout — PayPal' },
    fulfillment: 'proceed',
    payment_detail: 'PayPal',
    recommendation: 'represent',
  })

  // 2) Hero order 12322 / AR-2026-0042: the 2-day prompt. Burton + expedited = $509.95, Final Sale. Review Required, 2 problems.
  //    NO dispute: review before fulfillment prevents it. The order is held, not shipped.
  await build({
    key: '12322', order_ref: '12322', receipt_ref: 'AR-2026-0042', shopper: 'Jemaih Soresky', agent: 'meta-muse-j0376672',
    at: { grant: '17:05', proposal: '17:09', action: '17:11', receipt: '17:12' },
    grant: { product_scope: 'snowboard', colour: null, return_required: true, delivery_by: '2026-10-28' },
    proposal: { product: BURTON_ID, item: 44995, total: null, returns: 'Easy returns per product page', delivery: 'Wed Oct 28' },
    action: {
      detail: { product_id: BURTON_ID, product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', item_price_cents: 44995, shipping_method: 'expedited', shipping_cents: 6000, total_cents: 50995, delivery_date: '2026-10-28', payment_method: 'Demo Checkout', payment_method_detail: 'PayPal', payment_simulated: true, agent_summary: { returns: 'Easy returns per product page' } },
      believed: { returns: 'Easy returns per product page' },
    },
    terms: burtonTerms,
    summary: { order_status: 'Confirmed', product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', item_price_cents: 44995, shipping_method: 'expedited', shipping_cents: 6000, total_cents: 50995, delivery_date: '2026-10-28', payment_method: 'Demo Checkout', payment_method_detail: 'PayPal', payment_simulated: true, agent_summary_returns: 'Easy returns per product page' },
    fulfillment: 'held',
    payment_detail: 'PayPal',
    recommendation: null,
  })

  // 3) Scenario B order 13422: agent complies, 0 problems (Pass). A SEPARATE order that shipped, was delivered, and was
  //    then disputed. Filed under Visa, condition 10.4, as filed by the processor. The merchant fought it and reported Won:
  //    that is the merchant's decision and the merchant-reported outcome, not an AgentReceipt recommendation.
  //    Seed correction approved Oct 29, 2026: shipment record added; dispute timeline after delivery; paid with a Visa card
  //    through Demo Checkout (payment detail only; grant fields, action, verdict, total and product are unchanged).
  const VISA = 'Visa card (simulated, via Demo Checkout)'
  const b = await build({
    key: '13422', order_ref: '13422', receipt_ref: 'AR-2026-0043', shopper: 'Ivan Dijkstra', agent: 'instinct-kk14680',
    at: { grant: '18:00', proposal: '18:04', action: '18:06', receipt: '18:07' },
    grant: { product_scope: null, colour: null, return_required: true, delivery_by: '2026-10-30' },
    proposal: { product: ORCA_ID, item: 48983, total: 48983, returns: 'Free returns', delivery: 'Thu Oct 29' },
    action: {
      detail: { product_id: ORCA_ID, product_name: 'T. Rice Orca Snowboard 2025/2026', brand: 'Lib Tech', size_cm: 156, colour: null, item_price_cents: 48983, shipping_method: 'standard', shipping_cents: 0, total_cents: 48983, delivery_date: '2026-10-29', payment_method: 'Demo Checkout', payment_method_detail: VISA, payment_simulated: true, agent_summary: { returns: 'Free returns' } },
      believed: { returns: 'Free returns' },
    },
    terms: orcaTerms,
    summary: { order_status: 'Confirmed', product_name: 'T. Rice Orca Snowboard 2025/2026', brand: 'Lib Tech', size_cm: 156, colour: null, item_price_cents: 48983, shipping_method: 'standard', shipping_cents: 0, total_cents: 48983, delivery_date: '2026-10-29', payment_method: 'Demo Checkout', payment_method_detail: VISA, payment_simulated: true, agent_summary_returns: 'Free returns' },
    fulfillment: 'proceed',
    payment_detail: VISA,
    recommendation: 'represent',
  })
  // Layer 1 shipment record: shipped Tue Oct 27, delivered Thu Oct 29. No carrier, tracking or delivery proof is in the
  // record, so they stay null and the pack lists them as missing.
  const shipment = await chain('shipments', 'shipment', {
    id: uid('13422:shipment'), receipt_id: b.rid, merchant_id: MERCHANT_ID, shipped_on: '2026-10-27', delivered_on: '2026-10-29',
    carrier: null, tracking_ref: null, delivery_proof_ref: null, source: 'Merchant order system (seeded demo record)', created_at: on('10-27', '15:00'),
  })
  // Layer 3, as filed. Amount, channel and processor reference were not given, so they stay null (obtain from acquirer).
  const d2 = uid('13422:dispute')
  const filed = {
    processor: 'visa', channel: null, claim_type: 'agent_outside_grant', reason_code: '10.4 — Other Fraud, Card-Absent Environment',
    dispute_date: '2026-10-30', dispute_amount_cents: null, processor_reference: null,
  }
  const claim = 'Agent overstep — agent exceeded budget / bought outside grant'
  const disputeRow = { id: d2, receipt_id: b.rid, merchant_id: MERCHANT_ID, reason: claim, ...filed, opened_at: on('10-30', '16:00'), created_at: on('10-30', '16:00') }
  plain('disputes', disputeRow)
  await chain('dispute_events', 'dispute_event', {
    id: uid('13422:ev1'), dispute_id: d2, event_type: 'opened', decided_by: 'Northwind Outfitters',
    basis: { ...filed, claim, order_ref: '13422', entered_by: 'seeded demo dispute' }, created_at: on('10-30', '16:00'),
  })
  // The pack built automatically when the dispute arrived (Visa format, template texts: Spark does not run in the seed).
  // Its hash comes from the same pack builder the dashboard runs, over this order's own records.
  const own = records.filter((r) => r.entry_type && [b.gid, b.rid, d2].some((id) =>
    r.row.id === id || r.row.grant_id === id || r.row.receipt_id === id || r.row.dispute_id === id || r.row.id === b.receipt.proposal_id))
  const chainRecs: ChainRecord[] = own.map((r) => ({ chain_seq: r.row.chain_seq as number, entry_type: r.entry_type as ChainRecord['entry_type'], row: r.row as ChainRecord['row'] }))
  const gate = await verifyOrderChain(chainRecs, (s) => records.find((r) => r.row.chain_seq === s)?.row.entry_hash as string | undefined)
  if (!gate.ok || !gate.receipt_hash) throw new Error('Seed chain for 13422 does not verify.')
  const row = (table: string, id: unknown) => records.find((r) => r.table === table && r.row.id === id)!.row
  const pack = await buildPack({
    processor: 'visa', merchant: { id: MERCHANT_ID, name: 'Northwind Outfitters' }, receipt: b.receipt,
    grant: row('grants', b.gid), proposal: row('proposals', b.receipt.proposal_id), action: records.find((r) => r.table === 'actions' && r.row.grant_id === b.gid)!.row,
    shipment, reviews: [], dispute: disputeRow, gate: { status: 'passed', receipt_hash: gate.receipt_hash }, texts: null, text_source: 'rules-fallback',
  })
  await chain('dispute_events', 'dispute_event', {
    id: uid('13422:ev2'), dispute_id: d2, event_type: 'pack_generated', decided_by: 'AgentReceipt (pack builder)',
    basis: { processor: 'visa', pack_hash: pack.pack_hash, text_source: 'rules-fallback', texts: null, generated_at: on('10-30', '16:01') }, created_at: on('10-30', '16:01'),
  })
  await chain('dispute_events', 'dispute_event', {
    id: uid('13422:ev3'), dispute_id: d2, event_type: 'represented', decided_by: 'Northwind Outfitters',
    basis: { date: '2026-11-01', reason: null, recorded_at: on('11-01', '15:00') }, created_at: on('11-01', '15:00'),
  })
  await chain('dispute_events', 'dispute_event', {
    id: uid('13422:ev4'), dispute_id: d2, event_type: 'outcome_won', decided_by: 'Northwind Outfitters',
    basis: { date: '2026-11-02', reason: null, recorded_at: on('11-02', '15:00') }, created_at: on('11-02', '15:00'),
  })

  // 4) Order 14522: gap. No receipt, no grant. A session row records the gap.
  plain('sessions', {
    id: uid('14522:session'), merchant_id: MERCHANT_ID, detection_source: 'none', agent_id: null, agent_verified: false,
    agent_verified_simulated: true,
    gap_note: 'Order 14522: Unverified agent, no Agent Receipt session opened, no receipt (gap recorded)',
    opened_at: at('19:00'),
  })
  void t

  return { sql: emitSql(), records: [...records] }
}

// ---------- SQL output ----------
const q = (s: string) => `'${s.replace(/'/g, "''")}'`
function lit(v: unknown, kind: Kind): string {
  if (v === null || v === undefined) return 'null'
  switch (kind) {
    case 'uuid': return `${q(v as string)}::uuid`
    case 'text': return q(v as string)
    case 'int': return String(v)
    case 'bool': return v ? 'true' : 'false'
    case 'date': return `${q(v as string)}::date`
    case 'ts': return `${q(v as string)}::timestamptz`
    case 'json': return `${q(canonicalJson(v))}::jsonb`
    case 'texts': return `array[${(v as string[]).map(q).join(', ')}]::text[]`
  }
}

function insert(table: string, row: Row): string {
  const cols = TABLES[table]
  const names = cols.map(([n]) => n)
  const keys = Object.keys(row).sort().join(',')
  if (keys !== [...names].sort().join(',')) throw new Error(`Row for ${table} has the wrong columns: ${keys}`)
  return `insert into ${table} (${names.join(', ')}) values (\n  ${cols.map(([n, k]) => lit(row[n], k)).join(',\n  ')}\n);`
}

function emitSql(): string {
  const order = ['sessions', 'grants', 'proposals', 'actions', 'receipts', 'shipments', 'disputes', 'dispute_events']
  const body = order
    .flatMap((t) => records.filter((r) => r.table === t).map((r) => insert(t, r.row)))
    .join('\n\n')
  const last = records.filter((r) => r.entry_type).length
  return `-- =====================================================================
-- AgentReceipt dashboard demo seed. GENERATED FILE: do not edit by hand.
-- Regenerate with: npm run seed:generate   (script: scripts/seed-dashboard-demo.ts)
--
-- Run ONCE in Supabase > SQL Editor, after 001 to 014. It does not change the schema.
-- It stops with an error, and writes nothing, if the ids below do not match this project,
-- if the seed was already applied, or if the chain already has entries.
--
-- Rows: orders 12322 (AR-2026-0042, hero, Review Required, NO dispute), 13422 (AR-2026-0043, Scenario B, Pass,
-- shipped Oct 27, delivered Oct 29, disputed Oct 30 under Visa 10.4, merchant fought it and reported Won Nov 2),
-- 14522 (gap, no receipt), and the tamper example receipt AR-2026-0041 ($449.95). Customers are demo names only.
-- Payment: Demo Checkout (simulated): PayPal for 0041 and 12322, a Visa card for 13422.
-- Hashes: supabase/functions/_shared/hash.ts, chained from the origin hash. Seeded demo data:
-- no real chat exists, so private_chat_hash is a hash of a fixed label.
-- To re-seed: select demo_reset();  (this clears ALL sessions, grants, receipts and disputes)
-- =====================================================================
begin;

do $$
begin
  if (select id from merchants where name = 'Northwind Outfitters') is distinct from ${q(MERCHANT_ID)}::uuid then
    raise exception 'Seed stopped: merchant id does not match this project.';
  end if;
  if not exists (select 1 from products where id = ${q(BURTON_ID)}::uuid and image_file = 'burton-spellbinder.png')
     or not exists (select 1 from products where id = ${q(ORCA_ID)}::uuid and image_file = 'lib-tech-orca.png')
     or not exists (select 1 from products where id = ${q(NITRO_ID)}::uuid and image_file = 'nitro-alternator.png') then
    raise exception 'Seed stopped: product ids do not match this project.';
  end if;
  if exists (select 1 from receipts) or exists (select 1 from grants) or exists (select 1 from sessions) then
    raise exception 'Seed stopped: sessions, grants or receipts already exist. Run select demo_reset(); first to re-seed.';
  end if;
end;
$$;

-- Catalog facts the seeded orders depend on (data only, not schema):
--  * Burton Spellbinder colourway is Serpent.
--  * Expedited delivery takes 2 days (Mon 26 Oct + 2 = Wed 28 Oct); free standard takes 5-7 days, except the Orca at 3 days (Amendment 6).
--    Nitro Alternator has the same expedited terms.
update products set colour = 'Serpent', expedited_delivery_days = 2 where id = ${q(BURTON_ID)}::uuid;
update products set expedited_delivery_days = 2 where id = ${q(NITRO_ID)}::uuid;
update products set standard_delivery_days = v.d from (values
  ('T. Rice Orca Snowboard 2025/2026', 3), ('Outerspace Living Snowboard 2025/2026', 6), ('Assassin Snowboard 2025/2026', 7),
  ('Airheart 2.0 Snowboard Women''s 2025/2026', 6), ('Bent 85 Skis with Bindings 2026/2027', 6),
  ('QST 92 Skis with Bindings 2025/2026', 7), ('Sender Soul 92 Skis with Bindings 2025/2026', 5)
) as v(n, d) where products.name = v.n;

${body}

-- The next chained entry gets chain_seq ${last + 1}.
select setval('chain_seq_gen', ${last}, true);

commit;
`
}

if (process.argv[1] && process.argv[1].endsWith('seed-dashboard-demo.ts')) {
  buildSeed().then(({ sql }) => {
    writeFileSync(fileURLToPath(new URL('../supabase/seed_dashboard_demo.sql', import.meta.url)), sql)
    console.log(`Wrote supabase/seed_dashboard_demo.sql (${records.length} rows)`)
  })
}

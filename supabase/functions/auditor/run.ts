// The auditor, one order at a time. Pure TypeScript: the database, the model and the clock are injected so tests run it.
//
// PER-ORDER ISOLATION: each call reads ONLY the records of the one order it is asked about: its grant, its proposal,
// its checkout action and the formal terms of the product in that action. Proposal fields are read as STRUCTURED fields only. From the rest of the chain it reads hashes
// and nothing else (to check the links). No chat, no shopper reasoning, no other order's grant, no disputes.
//
// AgentReceipt does not block checkout, payment or shipment. This returns a recommendation; the merchant's order
// system holds shipment/capture.
import { audit, requiresAttention, type AuditResult, type HashIn } from './audit.ts'
import { auditInputFromRecords } from './audit-input.ts'
import { appendChained, type ChainDb } from './chain.ts'
import { computeEntryHash } from './hash.ts'
import type { SemanticReader } from './spark.ts'

type Row = Record<string, unknown>

export interface AuditorDb extends ChainDb {
  sessionExists(sessionId: string): Promise<boolean>
  grantForSession(sessionId: string): Promise<Row | null>
  proposalForGrant(grantId: string): Promise<Row | null>
  checkoutForGrant(grantId: string): Promise<Row | null>
  product(productId: string): Promise<{ category: string; formal_returns: string; formal_terms_text: string; merchant_name: string; row: Row } | null>
  merchantName(merchantId: string): Promise<string | null>
  entryHashAt(chainSeq: number): Promise<string | null> // hash only, from the chain view
  receiptForGrant(grantId: string): Promise<Row | null>
  refs(): Promise<{ receipt_ref: string; order_ref: string | null }[]>
  logStep(sessionId: string, step: 'receipt_issued', detail: Row): Promise<void>
}

export type AuditorDeps = { db: AuditorDb; reader: SemanticReader; now: () => Date; newId: () => string; today?: () => string }

export type AuditorReply =
  | { type: 'audit'; receipt_ref: string | null; order_ref: string | null; audit: AuditResult; attention: boolean; issued: boolean }
  | { type: 'error'; message: string }

const nextNumber = (refs: (string | null)[], re: RegExp, floor: number): number => {
  const nums = refs.map((r) => (r ? re.exec(r) : null)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]))
  return Math.max(floor - 1, ...nums) + 1
}

// Recompute the hash of one stored record and check where it points.
async function checkRecord(row: Row | null, db: AuditorDb): Promise<{ content: boolean | null; link: boolean | null }> {
  if (!row || typeof row.prev_hash !== 'string' || typeof row.entry_hash !== 'string' || typeof row.chain_seq !== 'number') return { content: null, link: null }
  const recomputed = await computeEntryHash(row.prev_hash, row)
  const before = row.chain_seq > 1 ? await db.entryHashAt(row.chain_seq - 1) : `sha256:${'0'.repeat(64)}`
  return { content: recomputed === row.entry_hash, link: before === null ? null : before === row.prev_hash }
}

export async function runAuditor(raw: unknown, deps: AuditorDeps): Promise<AuditorReply> {
  const sessionId = (raw as { session_id?: unknown } | null)?.session_id
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) return { type: 'error', message: 'session_id is required.' }
  const { db } = deps

  const sessionOpened = await db.sessionExists(sessionId)
  const grant = sessionOpened ? await db.grantForSession(sessionId) : null
  const proposal = grant ? await db.proposalForGrant(grant.id as string) : null
  const action = grant ? await db.checkoutForGrant(grant.id as string) : null

  // One receipt per order. Asking again returns the verdict already on record, so a repeat can never change it.
  if (grant) {
    const existing = await db.receiptForGrant(grant.id as string)
    if (existing && existing.audit) {
      const stored = existing.audit as AuditResult
      return { type: 'audit', receipt_ref: existing.receipt_ref as string, order_ref: (existing.order_ref as string | null) ?? null, audit: stored, attention: requiresAttention(stored.decision), issued: false }
    }
  }

  const detail = (action?.detail as Row | undefined) ?? {}
  const productId = typeof detail.product_id === 'string' ? detail.product_id : null
  const product = productId ? await db.product(productId) : null
  const merchantName = grant && typeof grant.merchant_id === 'string' ? await db.merchantName(grant.merchant_id) : null

  // Hash records: recompute the grant, proposal and action from their own stored fields and check every link.
  const g = await checkRecord(grant, db)
  const p = await checkRecord(proposal, db)
  const a = await checkRecord(action, db)
  const links = [g.link, p.link, a.link]
  const hash: HashIn | null = grant && proposal && action
    ? { grant_ok: g.content, proposal_ok: p.content, action_ok: a.content, links_ok: links.includes(false) ? false : links.includes(null) ? null : true }
    : null

  // Spark reads STRUCTURED fields only (never chat, never proposal free text): the agent's returns summary and believed
  // terms against the formal terms, and the agent's delivery phrase as a date. Rules then do the matching.
  const summaryReturns = (proposal?.shown_returns_summary ?? (detail.agent_summary as Row | undefined)?.returns ?? null) as string | null
  const believed = ((action?.agent_believed_terms as Row | null | undefined)?.returns ?? null) as string | null
  const claimText = typeof summaryReturns === 'string' && summaryReturns ? summaryReturns : believed
  const deliveryPhrase = typeof proposal?.shown_delivery === 'string' ? (proposal.shown_delivery as string) : null
  const todayDate = deps.today ? deps.today() : deps.now().toISOString().slice(0, 10)
  // The two reads are independent (different fields, different prompts), so they run at the same time.
  const [semantic, semantic_delivery] = await Promise.all([
    grant?.return_policy_required === true && product?.formal_terms_text && typeof claimText === 'string' && claimText
      ? deps.reader.readReturns({ agent_summary_returns: claimText, agent_believed_terms: believed, formal_returns: product.formal_returns, formal_terms_text: product.formal_terms_text })
      : Promise.resolve(null),
    deliveryPhrase ? deps.reader.readDelivery(deliveryPhrase, todayDate) : Promise.resolve(null),
  ])

  const result = audit(auditInputFromRecords({
    session_opened: sessionOpened, grant, proposal, action,
    product: product ? { category: product.category, formal_returns: product.formal_returns, formal_terms_text: product.formal_terms_text, merchant_name: product.merchant_name } : null,
    merchant_name: merchantName, hash, semantic_returns: semantic, semantic_delivery,
  }))

  // A receipt needs a grant to hang on. Without one, return the Hold for Suspicion (gap) result and write nothing.
  if (!grant) return { type: 'audit', receipt_ref: null, order_ref: null, audit: result, attention: requiresAttention(result.decision), issued: false }

  const refs = await db.refs()
  const receipt_ref = `AR-2026-${String(nextNumber(refs.map((r) => r.receipt_ref), /^AR-2026-(\d+)$/, 1)).padStart(4, '0')}`
  const order_ref = String(nextNumber(refs.map((r) => r.order_ref), /^(1[5-9]\d{3})$/, 15001))
  const sealed_at = deps.now().toISOString()
  const pr = product?.row ?? {}
  const row = {
    id: deps.newId(), receipt_ref, order_ref, grant_id: grant.id, proposal_id: proposal?.id ?? null, merchant_id: grant.merchant_id,
    terms_snapshot: product
      ? {
        merchant: product.merchant_name, category: product.category, product_id: productId, product_name: pr.name ?? null, brand: pr.brand ?? null,
        size_cm: pr.size_cm ?? null, colour: pr.colour ?? null, price_cents: pr.price_cents ?? null, formal_returns: product.formal_returns,
        formal_terms_text: product.formal_terms_text, terms_version: pr.terms_version ?? 'v1', standard_shipping_cents: pr.standard_shipping_cents ?? null,
        standard_delivery_days: pr.standard_delivery_days ?? null, expedited_shipping_cents: pr.expedited_shipping_cents ?? null,
        expedited_delivery_days: pr.expedited_delivery_days ?? null,
      }
      : {},
    action_summary: {
      order_status: 'Received', product_name: detail.product_name ?? null, brand: detail.brand ?? null, size_cm: detail.size_cm ?? null,
      colour: detail.colour ?? null, item_price_cents: detail.item_price_cents ?? null, shipping_method: detail.shipping_method ?? null,
      shipping_cents: detail.shipping_cents ?? null, total_cents: detail.total_cents ?? null, delivery_date: detail.delivery_date ?? null,
      payment_method: detail.payment_method ?? null, payment_method_detail: detail.payment_method_detail ?? null, payment_simulated: detail.payment_simulated ?? null,
      agent_summary_returns: ((detail.agent_summary as Row | undefined)?.returns as string | undefined) ?? null,
    },
    mismatch_results: result.checks, problems_found: result.problems,
    recommendation: null, // the post-dispute verdict, only once a dispute exists
    missing_components: result.missing_components, image_evidence_ref: null,
    schema_label: 'VI-aligned demo representation', sealed_at, decision: result.decision, audit: result,
    fulfillment: result.decision === 'pass' ? 'proceed' : 'held',
  }
  await appendChained(db, 'receipts', row)
  await db.logStep(sessionId, 'receipt_issued', { receipt_ref, order_ref, decision: result.decision, problems: result.problems })

  return { type: 'audit', receipt_ref, order_ref, audit: result, attention: requiresAttention(result.decision), issued: true }
}

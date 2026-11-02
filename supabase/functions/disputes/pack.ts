// Evidence pack builder (Dispute Agent, Product 2). Pure TypeScript: no network, no model, no database, no clock.
// The same file runs in the `disputes` edge function, in the dashboard and in the seed script, so the pack the merchant
// sees, the JSON they download and the printable view all come from one object.
//
// What it does: lays out ONE disputed order's verified record (Layer 1 original record, Layer 2 merchant review record,
// Layer 3 dispute claim) in the field order and wording of the processor the dispute was filed under, and lists every
// item the processor's evidence needs that the record does not hold, with where to obtain it.
//
// What it never does: decide fight / concede, liability, a reason code or an outcome; score a dispute; fill a missing
// item; compute a deadline. The reason code / condition is shown exactly as filed. The Agent Receipt verdict is shown as
// part of Layer 1 evidence, nothing more.
//
// Muse Spark writes two texts only (a plain-language reading of the claim, and a short explanation of the pack). They
// are checked by validateSparkTexts: any number, date, hash or code that is not in the input is rejected and the
// template text is used instead, labelled rules-fallback.
import { canonicalJson, sha256Hex } from './hash.ts'

type Row = Record<string, unknown>

export type Processor = 'visa' | 'mastercard'
export const PROCESSORS: Processor[] = ['visa', 'mastercard'] // PayPal is the Nov 5-12 sprint: not built, not shown.
export const PROCESSOR_LABEL: Record<Processor, string> = { visa: 'Visa', mastercard: 'Mastercard' }
const GUIDE: Record<Processor, string> = {
  visa: 'Visa Dispute Management Guide for Merchants (based on Visa Core Rules and Visa Product and Service Rules, October 2026). Visa Rules prevail over the guide in every instance.',
  mastercard: 'Mastercard Chargeback Guide, Merchant Edition, 13 May 2025. Mastercard Rules prevail over the guide.',
}

export type ClaimType = 'agent_outside_grant' | 'not_authorised' | 'not_as_described' | 'misrepresentation' | 'other'
export const CLAIM_TYPES: ClaimType[] = ['agent_outside_grant', 'not_authorised', 'not_as_described', 'misrepresentation', 'other']
export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  agent_outside_grant: 'Agent bought outside what was authorised',
  not_authorised: 'Customer did not authorise the purchase',
  not_as_described: 'Item not as described',
  misrepresentation: 'Customer misled about terms',
  other: 'Other / not listed',
}
const CLAIM_PLAIN: Record<ClaimType, string> = {
  agent_outside_grant: 'Customer says the agent bought outside what they authorised.',
  not_authorised: 'Customer says they did not authorise this purchase.',
  not_as_described: 'Customer says the item is not what was described.',
  misrepresentation: 'Customer says they were misled about the terms of the purchase.',
  other: 'See the claim as filed; Agent Proceed has no plain-language reading for this claim type.',
}
// A dispute recorded before claim types existed has no claim type. Its claim text is still read, narrowly: only the
// agent-overstep wording gets the plain reading. Anything else says the claim type was not filed.
const OVERSTEP = /agent overstep|outside (the )?grant|exceeded (the )?budget|outside what (they|the customer) authori[sz]ed/i
export function claimPlain(claimType: ClaimType | null, asFiled: string): string {
  if (claimType) return CLAIM_PLAIN[claimType]
  if (OVERSTEP.test(asFiled)) return CLAIM_PLAIN.agent_outside_grant
  return 'Claim type not filed; see the claim as filed.'
}

// Reason codes / conditions: a plain-language translation of the code AS FILED. Nothing here selects, suggests or
// corrects a code. `fits` lists the claim types this code describes; when a claim type is outside it, the pack shows
// "Code does not match claim — confirm with acquirer" and keeps the code as filed. No `fits` = no claim-type check.
type Condition = { name: string; plain: string; fits?: ClaimType[] }
const CONDITIONS: Record<Processor, Record<string, Condition>> = {
  visa: {
    '10.4': { name: 'Other Fraud — Card-Absent Environment', plain: 'Customer says they did not authorise or take part in this card-absent (online) transaction.', fits: ['not_authorised', 'agent_outside_grant'] },
    '11.1': { name: 'Card Recovery Bulletin', plain: 'The issuer says the card was listed on a card recovery bulletin at the time.' },
    '11.2': { name: 'Declined Authorization', plain: 'The issuer says the authorisation request was declined.' },
    '11.3': { name: 'No Authorization', plain: 'The issuer says no authorisation was obtained for this transaction.' },
    '12.2': { name: 'Incorrect Transaction Code', plain: 'The issuer says the transaction was processed with the wrong transaction code.' },
    '12.3': { name: 'Incorrect Currency', plain: 'The issuer says the transaction was processed in the wrong currency.' },
    '12.4': { name: 'Incorrect Account Number', plain: 'The issuer says the transaction was processed to the wrong account number.' },
    '12.5': { name: 'Incorrect Amount', plain: 'The issuer says the amount processed is not the amount agreed.' },
    '12.6': { name: 'Duplicate Processing / Paid by Other Means', plain: 'The issuer says the transaction was processed twice, or paid another way.' },
    '12.7': { name: 'Invalid Data', plain: 'The issuer says the authorisation carried invalid data.' },
    '13.2': { name: 'Cancelled Recurring Transaction', plain: 'Customer says a recurring charge continued after it was cancelled.' },
    '13.3': { name: 'Not as Described or Defective Merchandise / Services', plain: 'Customer says what arrived is materially different from what was described, or is defective.', fits: ['not_as_described'] },
    '13.4': { name: 'Counterfeit Merchandise', plain: 'Customer says the item is counterfeit.' },
    '13.5': { name: 'Misrepresentation', plain: 'Customer says they were misled about the nature or terms of the purchase.', fits: ['misrepresentation'] },
    '13.6': { name: 'Credit Not Processed', plain: 'Customer says a promised refund or credit was not processed.' },
    '13.7': { name: 'Cancelled Merchandise / Services', plain: 'Customer says they cancelled or returned the order and were still charged.' },
    '13.8': { name: 'Original Credit Transaction Not Accepted', plain: 'Customer says they did not accept an original credit transaction.' },
    '13.9': { name: 'Non-Receipt of Cash or Load Transaction Value', plain: 'Customer says cash or load value was not received.' },
  },
  mastercard: {
    '4837': { name: 'No Cardholder Authorization', plain: 'Customer says they did not authorise this card-not-present transaction.', fits: ['not_authorised', 'agent_outside_grant'] },
    '4853': { name: 'Cardholder Dispute', plain: 'Customer disputes the purchase itself, for example goods not as described.', fits: ['not_as_described', 'misrepresentation'] },
    '4808': { name: 'Authorization-related Chargeback', plain: 'The issuer says there was a problem with the authorisation of this transaction.' },
    '4834': { name: 'Point-of-Interaction Error', plain: 'The issuer says there was a processing error at the point of interaction.' },
  },
}
const MC_SHORT: Record<string, string> = { '37': '4837', '53': '4853', '08': '4808', '34': '4834' }

// The code as filed, read for lookup only ("10.4 — Other Fraud" -> "10.4", "MC 37" -> "4837"). The stored value never changes.
export function conditionKey(processor: Processor, filed: string | null): string | null {
  if (!filed) return null
  if (processor === 'visa') return /(\d{2}\.\d)/.exec(filed)?.[1] ?? null
  const m = /\b(\d{4}|\d{2})\b/.exec(filed)?.[1] ?? null
  return m && m.length === 2 ? MC_SHORT[m] ?? null : m
}

export type Gate =
  | { status: 'passed'; receipt_hash: string }
  | { status: 'failed'; message: string; failing_link: string | null }
  | { status: 'not_run'; message: string }

export type Texts = { claim_plain: string; explanation: string }
export type TextSource = 'muse-spark' | 'rules-fallback'

export type PackInput = {
  processor: Processor // the format being built; defaults to the processor as filed
  merchant: { id: string; name: string }
  receipt: Row
  grant: Row | null
  proposal: Row | null
  action: Row | null // the checkout action
  shipment: Row | null
  reviews: Row[] // Layer 2, in recorded order
  dispute: Row
  gate: Gate
  texts?: Texts | null
  text_source?: TextSource
}

export type ItemStatus = 'present' | 'missing' | 'unspecified'
// origin 'sample': a dispute-notice value shown in the sample example (never stored, never filed). Absent = the value
// comes from the Agent Receipt record or the dispute as recorded.
export type Item = { label: string; value: string | null; status: ItemStatus; obtain_from?: string; note?: string; origin?: 'sample' }
export type VerdictRow = { field: string; grant: string | null; merchant_terms: string | null; actual: string | null; result: string; cause: string | null; next_action_who: string | null; key?: string }
// tone 'sample': the section holds sample notice values (shown once, as an orange section accent). Otherwise 'record'.
export type Section = { key: string; title: string; tone?: 'record' | 'sample'; items: Item[]; verdict?: VerdictRow[]; footer?: string }
export type Need = { item: string; why: string; obtain_from: string; merchant_input: boolean }
export type ElementResult = 'match' | 'mismatch' | 'unspecified' | 'not_in_record' | 'in_record'
export type Element = { element: string; claim: string; record: string; result: ElementResult }

export type Pack = {
  schema: 'agentreceipt.evidence-pack/v1'
  processor: Processor
  processor_label: string
  filed_processor: Processor | null
  guide: string
  order_ref: string | null
  receipt_ref: string
  merchant: string
  sample: boolean // the sample example: a demo view over a real order's record, never a filed dispute
  trusted: boolean
  claim: {
    as_filed: string
    claim_type: ClaimType | null
    claim_type_label: string
    condition_as_filed: string | null
    condition_name: string | null
    condition_plain: string
    code_flag: string | null
  }
  claim_vs_record: Element[]
  sections: Section[]
  merchant_review_statement: string
  needs: Need[]
  notes: string[] // remedy / deadline / rule lines, each grounded in the record or the guide
  tamper_line: string
  texts: Texts
  text_source: TextSource
  text_label: string
  disclaimer: string
  pack_hash: string
}

export const DISCLAIMER =
  'Generated from Agent Receipt verified record only. Does not replace Visa / Mastercard Rules. Does not guarantee outcome. Confirm eligibility with your acquirer before submitting. Agent Proceed does not submit this pack on your behalf, and does not decide liability.'
export const FALLBACK_LABEL = 'rules-fallback — deterministic check only, Spark formatting unavailable'
export const SPARK_LABEL = 'Plain-language text by Muse Spark, checked against this record: no number, date, hash or code that is not in the record.'
export const VERDICT_FOOTER = 'Agent Receipt shows mismatch facts only; it does not decide liability and no network rule moves liability on this screen.'
export const DEADLINE_LINE = 'Deadline: confirm with acquirer — settlement date not in record.'
export const CE3_LINE = 'CE3.0 eligibility cannot be determined from Agent Receipt record — prior transactions / device data not in record, obtain from acquirer.'
export const MC_REGISTRATION_LINE = 'Registration status not in record — confirm with acquirer.'
export const CODE_FLAG = 'Code does not match claim — confirm with acquirer.'
export const NO_REVIEW = 'No merchant review record.'
export const LEGEND = 'Blue = real data from the transaction record. Orange = sample data — what we would receive from merchant dispute records when the store is connected.'
export const SAMPLE_LABEL = 'Sample example — not a filed dispute. Built on order 13422\'s real record with sample dispute notice data. Never submit this pack to an acquirer.'

const ACQUIRER = 'Obtain from acquirer'
const FULFILMENT = 'Obtain from fulfilment system'
const MERCHANT = 'Obtain from merchant input'

// ---------- readers ----------
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v !== 'null' ? v : null)
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const money = (c: number | null) => (c === null ? null : `$${(c / 100).toFixed(2)}`)
const date = (v: unknown) => {
  const t = s(v)
  return t ? t.slice(0, 10) : null
}
const when = (v: unknown) => {
  const t = s(v)
  if (!t) return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? t : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
const present = (label: string, value: string | null, missing?: { obtain_from: string; note?: string }): Item =>
  value !== null ? { label, value, status: 'present' } : { label, value: null, status: 'missing', obtain_from: missing?.obtain_from ?? ACQUIRER, ...(missing?.note ? { note: missing.note } : {}) }
const unspecified = (label: string, value: string): Item => ({ label, value, status: 'unspecified' })

export const ACTION_TAKEN_LABEL: Record<string, string> = {
  called_confirmed: 'Called customer and confirmed',
  emailed_confirmed: 'Emailed customer and confirmed',
  investigated_cleared: 'Investigated and cleared',
  override_documented: 'Overrode with documented reason',
  kept_on_hold: 'Kept on hold',
  cancelled: 'Cancelled',
}
export const METHOD_LABEL: Record<string, string> = { phone: 'Phone call', email: 'Email', chat: 'Chat', in_person: 'In-person', other: 'Other' }
export const RELEASE_LABEL: Record<string, string> = { released: 'Released for shipment', not_released: 'Not released' }
const CONFIRMING = new Set(['called_confirmed', 'emailed_confirmed'])
const DECISION_LABEL: Record<string, string> = { pass: 'Pass', review_required: 'Review Required', hold_suspicion: 'Hold for Suspicion' }

// ---------- Layer 1 ----------
function grantItems(g: Row | null, merchantName: string): Item[] {
  if (!g) return [present('Grant record', null, { obtain_from: 'Not in Agent Receipt record' })]
  const lo = n(g.size_min_cm)
  const hi = n(g.size_max_cm)
  const ret = g.return_policy_required
  const budget = money(n(g.amount_max_cents) ?? n(g.budget_limit_cents))
  return [
    present('Budget (maximum total)', budget ? `${budget} max` : null, { obtain_from: 'Not in Agent Receipt record' }),
    s(g.product_scope) ? present('Product scope', s(g.product_scope)) : unspecified('Product scope', 'Not specified by the customer — no product scope check'),
    lo !== null || hi !== null ? present('Size range', `${lo ?? '?'}–${hi ?? '?'} cm`) : unspecified('Size range', 'Not specified by the customer — no size check'),
    s(g.colour_preference) ? present('Colour', s(g.colour_preference)) : unspecified('Colour', 'Not specified by the customer — no colour check'),
    s(g.delivery_by) ? present('Delivery by', date(g.delivery_by)) : unspecified('Delivery by', 'Not specified by the customer — no delivery check'),
    ret === true ? present('Returnable required', 'Yes, returnable required') : ret === false ? present('Returnable required', 'Not required') : unspecified('Returnable required', 'Not specified by the customer — no returns check'),
    present('Payment method ref', s(g.payment_method_ref), { obtain_from: 'Not in Agent Receipt record' }),
    present('Merchant', merchantName),
    present('Grant expiry', when(g.expires_at), { obtain_from: 'Not in Agent Receipt record' }),
    present('Grant confirmed at', when(g.confirmed_at), { obtain_from: 'Not in Agent Receipt record' }),
    present('Customer (as recorded on the grant)', s(g.shopper_ref), { obtain_from: 'Not in Agent Receipt record' }),
    present('Agent', s(g.agent_id) ? `${s(g.agent_id)}${g.agent_verified === true ? ' (verified-agent signal, simulated)' : ' (unverified)'}` : null, { obtain_from: 'Not in Agent Receipt record' }),
    present('Grant seal (entry hash)', s(g.entry_hash), { obtain_from: 'Not in Agent Receipt record' }),
  ]
}

function actionItems(receipt: Row, action: Row | null, proposal: Row | null): Item[] {
  const sum = (receipt.action_summary as Row | undefined) ?? {}
  const det = (action?.detail as Row | undefined) ?? {}
  const pick = (k: string) => (det[k] !== undefined && det[k] !== null ? det[k] : sum[k])
  const brand = s(pick('brand'))
  const name = s(pick('product_name'))
  const product = name ? (brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${name}` : name) : null
  const ship = n(pick('shipping_cents'))
  const method = s(pick('shipping_method'))
  const believed = s((action?.agent_believed_terms as Row | null | undefined)?.returns) ?? s(sum.agent_summary_returns) ?? s((det.agent_summary as Row | undefined)?.returns)
  const pmDetail = s(pick('payment_method_detail'))
  const items: Item[] = [
    present('Product', product, { obtain_from: 'Not in Agent Receipt record' }),
    present('Size', n(pick('size_cm')) !== null ? `${n(pick('size_cm'))} cm` : null, { obtain_from: 'Not in Agent Receipt record' }),
    s(pick('colour')) ? present('Colour', s(pick('colour'))) : unspecified('Colour', 'Not recorded on the action'),
    present('Item price', money(n(pick('item_price_cents'))), { obtain_from: 'Not in Agent Receipt record' }),
    present('Shipping price', ship === null ? null : `${money(ship)}${method ? ` (${method})` : ''}`, { obtain_from: 'Not in Agent Receipt record' }),
    present('Total price', money(n(pick('total_cents'))), { obtain_from: 'Not in Agent Receipt record' }),
    present('Delivery date', date(pick('delivery_date')), { obtain_from: 'Not in Agent Receipt record' }),
    present('Payment method', s(pick('payment_method')), { obtain_from: 'Not in Agent Receipt record' }),
    present('Payment method detail', pmDetail, { obtain_from: ACQUIRER }),
    present('Agent summary / agent believed terms', believed, { obtain_from: 'Not in Agent Receipt record' }),
  ]
  if (proposal) {
    const shownTotal = n(proposal.shown_total_cents)
    items.push(
      { label: 'Total shown to the customer before confirmation', value: shownTotal === null ? 'Not shown (no total on the proposal)' : money(shownTotal), status: 'present' },
      present('Returns shown to the customer', s(proposal.shown_returns_summary)),
      present('Delivery shown to the customer', s(proposal.shown_delivery)),
      present('Customer confirmed the proposal at', when(proposal.confirmed_at), { obtain_from: 'Not in Agent Receipt record' }),
    )
  }
  return items
}

function termsItems(receipt: Row): Item[] {
  const t = (receipt.terms_snapshot as Row | undefined) ?? {}
  const std = n(t.standard_shipping_cents)
  const exp = n(t.expedited_shipping_cents)
  return [
    present('Formal terms (at order time)', s(t.formal_terms_text), { obtain_from: MERCHANT }),
    present('Terms version', s(t.terms_version), { obtain_from: MERCHANT }),
    present('Standard shipping', std === null ? null : `${money(std)}${n(t.standard_delivery_days) !== null ? `, ${n(t.standard_delivery_days)} days` : ''}`, { obtain_from: MERCHANT }),
    { label: 'Expedited shipping', value: exp === null ? 'Not offered' : `${money(exp)}${n(t.expedited_delivery_days) !== null ? `, ${n(t.expedited_delivery_days)} days` : ''}`, status: 'present' },
    { label: 'Snapshot taken', value: `With receipt ${s(receipt.receipt_ref) ?? ''}, at order time (current terms are not used)`, status: 'present' },
  ]
}

function verdictRows(receipt: Row): VerdictRow[] {
  const rows = Array.isArray(receipt.mismatch_results) ? (receipt.mismatch_results as Row[]) : []
  return rows.map((r) => ({
    field: String(r.field ?? ''), grant: s(r.grant), merchant_terms: s(r.merchant_terms), actual: s(r.actual), result: String(r.result ?? ''),
    cause: s(r.cause), next_action_who: s(r.next_action_who), ...(typeof r.key === 'string' ? { key: r.key } : {}),
  }))
}

const TAMPER_LABEL = 'Tamper check'
function tamperLine(gate: Gate): string {
  if (gate.status === 'passed') return `Receipt chain verified — tamper check passed · ${gate.receipt_hash}`
  if (gate.status === 'failed') return `Receipt chain failed verification — tamper check failed. Untrusted record. ${gate.message}${gate.failing_link ? ` Failing link: ${gate.failing_link}` : ''}`
  return `Tamper check not run: ${gate.message}`
}

function receiptItems(receipt: Row, gate: Gate): Item[] {
  return [
    present('Receipt ID', s(receipt.receipt_ref), { obtain_from: 'Not in Agent Receipt record' }),
    present('Receipt hash', s(receipt.entry_hash), { obtain_from: 'Not in Agent Receipt record' }),
    present('Receipt sealed at', when(receipt.sealed_at), { obtain_from: 'Not in Agent Receipt record' }),
    present('Agent Receipt verdict (evidence only)', DECISION_LABEL[String(receipt.decision)] ? `${DECISION_LABEL[String(receipt.decision)]}, ${n(receipt.problems_found) ?? 0} problems` : null, { obtain_from: 'Not in Agent Receipt record' }),
    { label: TAMPER_LABEL, value: tamperLine(gate), status: gate.status === 'passed' ? 'present' : 'missing', ...(gate.status === 'passed' ? {} : { obtain_from: 'Investigate the receipt chain' }) },
  ]
}

function shipmentItems(sh: Row | null, podWord: string): Item[] {
  if (!sh) {
    return [
      present('Shipment record', null, { obtain_from: FULFILMENT, note: 'Shipment date not in record.' }),
      present(podWord, null, { obtain_from: FULFILMENT }),
    ]
  }
  return [
    present('Shipped on', date(sh.shipped_on), { obtain_from: FULFILMENT }),
    present('Delivered on', date(sh.delivered_on), { obtain_from: FULFILMENT }),
    present('Carrier', s(sh.carrier), { obtain_from: FULFILMENT }),
    present('Tracking reference', s(sh.tracking_ref), { obtain_from: FULFILMENT }),
    present(podWord, s(sh.delivery_proof_ref), { obtain_from: FULFILMENT }),
    present('Shipment record source', s(sh.source)),
  ]
}

// ---------- Layer 2 ----------
function reviewItems(receipt: Row, reviews: Row[]): { items: Item[]; statement: string; gaps: Need[] } {
  const decision = String(receipt.decision ?? '')
  const flagged = decision === 'review_required' || decision === 'hold_suspicion'
  if (reviews.length === 0) {
    return {
      items: [],
      statement: flagged
        ? `${NO_REVIEW} This order was ${DECISION_LABEL[decision]} at Agent Receipt check and no merchant action was recorded at review time.`
        : `${NO_REVIEW} The order was ${DECISION_LABEL[decision] ?? 'not flagged'} at Agent Receipt check, so no review was flagged.`,
      gaps: [],
    }
  }
  const problemFields = verdictRows(receipt).filter((r) => r.result === 'mismatch').map((r) => r.key ?? r.field.toLowerCase())
  const items: Item[] = []
  const gaps: Need[] = []
  reviews.forEach((r, i) => {
    const tag = reviews.length > 1 ? ` (${i + 1})` : ''
    const action = String(r.action_taken ?? '')
    items.push(
      present(`Action taken${tag}`, ACTION_TAKEN_LABEL[action] ?? s(r.action_taken)),
      present(`Method${tag}`, METHOD_LABEL[String(r.method)] ?? s(r.method)),
      present(`Recorded at${tag}`, when(r.recorded_at)),
      present(`Recorded by${tag}`, s(r.recorded_by)),
      present(`Reason / notes${tag}`, s(r.notes)),
    )
    if (CONFIRMING.has(action)) {
      items.push(
        present(`Confirmed total${tag}`, s(r.confirmed_total), { obtain_from: MERCHANT, note: 'Not recorded in this merchant review record.' }),
        present(`Confirmed terms${tag}`, s(r.confirmed_terms), { obtain_from: MERCHANT, note: 'Not recorded in this merchant review record.' }),
      )
    }
    items.push(present(`Release decision${tag}`, RELEASE_LABEL[String(r.release_decision)] ?? s(r.release_decision)))
  })
  // Gaps against the flagged fields: shown as-is, never resolved. A later record does not overwrite an earlier one.
  const confirmations = reviews.filter((r) => CONFIRMING.has(String(r.action_taken)))
  if (confirmations.length > 0) {
    if (problemFields.includes('budget') && !confirmations.some((r) => s(r.confirmed_total))) {
      gaps.push({ item: 'Confirmed total in the merchant review record', why: 'Budget was a mismatch at Agent Receipt check; the review record confirms no total.', obtain_from: 'Not in merchant review record — a dispute-time note is labelled separately', merchant_input: true })
    }
    if (problemFields.includes('returns') && !confirmations.some((r) => s(r.confirmed_terms))) {
      gaps.push({ item: 'Confirmed terms in the merchant review record', why: 'Returns was a mismatch at Agent Receipt check; the review record confirms no terms.', obtain_from: 'Not in merchant review record — a dispute-time note is labelled separately', merchant_input: true })
    }
  }
  return { items, statement: `${reviews.length} merchant review ${reviews.length === 1 ? 'record' : 'records'}, recorded at review time, in order.`, gaps }
}

// ---------- claim vs record ----------
const CLAIM_ELEMENT: Record<string, string> = {
  budget: 'Agent spent more than the authorised budget',
  product: 'Agent bought a product outside the authorised scope',
  size: 'Agent bought a size outside the authorised range',
  colour: 'Agent bought a colour that was not authorised',
  delivery: 'Delivery later than authorised',
  merchant: 'Agent bought from a merchant that was not authorised',
  payment: 'Agent used a payment method that was not authorised',
  validity: 'Agent acted after the authorisation expired',
  returns: 'Returns terms differ from what the customer was told',
}
// When the customer never specified a field, nothing was authorised or restricted for it: the claim side says so,
// instead of describing an unauthorised purchase.
const NEVER_SPECIFIED: Record<string, string> = {
  budget: 'a budget', product: 'a product scope', size: 'a size range', colour: 'a colour', delivery: 'a delivery date',
  merchant: 'a merchant', payment: 'a payment method', validity: 'an expiry', returns: 'a returns requirement',
}
const ELEMENTS: Record<ClaimType, string[]> = {
  agent_outside_grant: ['budget', 'product', 'size', 'colour', 'delivery', 'merchant', 'payment', 'validity'],
  not_authorised: ['merchant', 'payment', 'validity', 'budget'],
  not_as_described: ['product', 'size', 'colour', 'returns'],
  misrepresentation: ['returns', 'budget', 'delivery'],
  other: [],
}

function claimVsRecord(claimType: ClaimType | null, receipt: Row, reviews: Row[]): Element[] {
  const rows = verdictRows(receipt)
  const keys = claimType && ELEMENTS[claimType].length ? ELEMENTS[claimType] : rows.map((r) => r.key ?? r.field.toLowerCase())
  const out: Element[] = []
  for (const k of keys) {
    const r = rows.find((x) => (x.key ?? x.field.toLowerCase()) === k)
    const claim = CLAIM_ELEMENT[k] ?? r?.field ?? k
    if (!r) {
      out.push({ element: k, claim, record: 'Not in Agent Receipt record', result: 'not_in_record' })
      continue
    }
    if (r.result === 'unspecified') {
      const what = NEVER_SPECIFIED[k] ?? r.field.toLowerCase()
      out.push({
        element: r.field,
        claim: `Customer never specified ${what}, so no ${r.field.toLowerCase()} was authorised or restricted`,
        record: `Grant: not specified by the customer · Actual: ${r.actual ?? `no ${r.field.toLowerCase()} recorded for this order`}`,
        result: 'unspecified',
      })
      continue
    }
    const parts = [`Grant: ${r.grant ?? 'not specified by the customer'}`]
    if (r.merchant_terms) parts.push(`Merchant terms: ${r.merchant_terms}`)
    parts.push(`Actual: ${r.actual ?? 'not recorded'}`)
    const confirm = reviews.filter((v) => CONFIRMING.has(String(v.action_taken)))
    if (k === 'budget' && confirm.some((v) => s(v.confirmed_total))) parts.push(`Merchant review: confirmed total "${s(confirm.find((v) => s(v.confirmed_total))!.confirmed_total)}"`)
    if (k === 'returns' && confirm.some((v) => s(v.confirmed_terms))) parts.push(`Merchant review: confirmed terms "${s(confirm.find((v) => s(v.confirmed_terms))!.confirmed_terms)}"`)
    const result: ElementResult = r.result === 'match' ? 'match' : r.result === 'mismatch' ? 'mismatch' : r.result === 'unspecified' ? 'unspecified' : 'not_in_record'
    out.push({ element: r.field, claim, record: parts.join(' · '), result })
  }
  if (claimType === 'not_authorised') out.push({ element: 'Cardholder identity verification', claim: 'Cardholder did not take part', record: 'Not in Agent Receipt record', result: 'not_in_record' })
  if (claimType === 'not_as_described') out.push({ element: 'Item condition on delivery', claim: 'Item arrived different or defective', record: 'Not in Agent Receipt record', result: 'not_in_record' })
  if (claimType === 'misrepresentation') {
    const ack = reviews.find((v) => CONFIRMING.has(String(v.action_taken)) && s(v.confirmed_terms))
    out.push(ack
      ? { element: 'Terms acknowledged by the customer', claim: 'Customer was not told the real terms', record: `Merchant review record: confirmed terms "${s(ack.confirmed_terms)}" (${ACTION_TAKEN_LABEL[String(ack.action_taken)]})`, result: 'in_record' }
      : { element: 'Terms acknowledged by the customer', claim: 'Customer was not told the real terms', record: 'Not in Agent Receipt record', result: 'not_in_record' })
  }
  return out
}

// ---------- processor templates: field order, wording and checklist ----------
type Ctx = {
  input: PackInput
  key: string | null
  grant: Item[]
  action: Item[]
  terms: Item[]
  receipt: Item[]
  verdict: VerdictRow[]
  merchantReview: Item[]
  claimItems: Item[]
}

const isSample = (d: Row) => d.sample === true
// A notice value: marked sample when the sample example supplies it; a missing value stays missing either way.
const notice = (d: Row, item: Item): Item => (isSample(d) && item.status === 'present' ? { ...item, origin: 'sample' } : item)

function claimItems(input: PackInput): Item[] {
  const d = input.dispute
  const filed = s(d.processor) as Processor | null
  return [
    present('Dispute claim as filed', s(d.reason)),
    notice(d, present('Processor as filed', filed ? PROCESSOR_LABEL[filed] : null)),
    notice(d, present('Acquirer / channel', s(d.channel), { obtain_from: ACQUIRER })),
    notice(d, present('Reason code / condition as filed', s(d.reason_code), { obtain_from: ACQUIRER })),
    notice(d, present('Dispute date', date(d.dispute_date), { obtain_from: ACQUIRER, ...(date(d.opened_at) ? { note: `Not filed. The dispute was recorded in Agent Proceed on ${date(d.opened_at)}.` } : {}) })),
    notice(d, present('Dispute amount', money(n(d.dispute_amount_cents)), { obtain_from: ACQUIRER })),
    notice(d, present('Processor reference', s(d.processor_reference), { obtain_from: ACQUIRER, note: 'Not in Agent Receipt record — obtain from acquirer.' })),
  ]
}
// Cardholder details come from the grant (real record), not from the notice.
const cardholderItem = (g: Row | null): Item => present('Cardholder details (as recorded on the grant)', s(g?.shopper_ref), { obtain_from: ACQUIRER })
const credentialItem = (d: Row, label: string): Item =>
  notice(d, present(label, s(d.card_last4_or_token), { obtain_from: ACQUIRER, note: 'Agent Receipt records the payment method, not the credential.' }))
const withTone = (sections: Section[]): Section[] =>
  sections.map((x) => ({ ...x, tone: x.items.some((i) => i.origin === 'sample') ? 'sample' : 'record' }))

function visa(c: Ctx): { sections: Section[]; notes: string[] } {
  const total = c.action.find((i) => i.label === 'Total price')
  const is104 = c.key === '10.4'
  const is13 = c.key === '13.3' || c.key === '13.5'
  const sections: Section[] = [
    { key: 'dispute', title: 'Dispute condition and transaction', items: [
      ...c.claimItems,
      { label: 'Transaction amount', value: total?.value ?? null, status: total?.value ? 'present' : 'missing', obtain_from: ACQUIRER },
      credentialItem(c.input.dispute, 'Payment credential (last 4 / token only)'),
      cardholderItem(c.input.grant),
    ] },
    { key: 'grant', title: 'Cardholder authorisation — the grant the customer gave the agent', items: c.grant },
    { key: 'action', title: 'Transaction — what the agent did', items: c.action },
    { key: 'terms', title: is13 ? 'Description and terms presented at purchase (formal terms snapshot)' : 'Formal terms at order time', items: [
      ...c.terms,
      ...(is13 ? [present('Product page / checkout as presented (screenshots)', null, { obtain_from: MERCHANT, note: 'Agent Proceed stores formal terms and the agent summary, not the page as displayed.' })] : []),
    ] },
    { key: 'verdict', title: 'Agent Receipt — line-by-line verdict', items: [], verdict: c.verdict, footer: VERDICT_FOOTER },
    { key: 'receipt', title: 'Record integrity — hash-chained receipt', items: c.receipt },
    { key: 'merchant_review', title: 'Merchant review record', items: c.merchantReview },
    { key: 'delivery', title: is104 ? 'Proof of delivery / access' : 'Shipment and delivery', items: shipmentItems(c.input.shipment, 'Proof of delivery') },
  ]
  const notes = [
    'Visa Rules prevail over the Visa Dispute Management Guide; the guide does not create rights or obligations. Confirm eligibility with your acquirer.',
    ...(is104 ? [CE3_LINE, 'Visa guide, condition 10.4: compelling evidence must include the payment credential (last 4 / token only), the transaction amount and cardholder information. Compelling evidence is not a guaranteed remedy.'] : []),
    ...(c.key === '13.3' ? ['Visa guide, condition 13.3: statements like "the item is as described" are not sufficient without documentation; evidence must address the specific claim.'] : []),
    ...(c.key === '13.5' ? ['Visa guide, condition 13.5: assessed on what was communicated at the time of purchase; internal policies do not replace customer-facing disclosures.'] : []),
    DEADLINE_LINE,
  ]
  return { sections: withTone(sections), notes }
}

function mastercard(c: Ctx): { sections: Section[]; notes: string[] } {
  const sections: Section[] = [
    { key: 'dispute', title: 'Chargeback details', items: [
      ...c.claimItems,
      ...(s(c.input.dispute.card_last4_or_token) ? [credentialItem(c.input.dispute, 'Card last 4 / token')] : []),
      present('Authorisation code / initial authorisation date', null, { obtain_from: ACQUIRER }),
      present('Settlement Date (DE 15) / Central Site Business Date', null, { obtain_from: ACQUIRER, note: 'Needed for the second presentment time frame.' }),
      present('Message text (DE 72) and message reason code', null, { obtain_from: ACQUIRER, note: 'Entered by the acquirer; Agent Proceed does not set DE values.' }),
    ] },
    { key: 'action', title: 'Transaction details — what the agent did', items: c.action },
    { key: 'grant', title: 'Cardholder participation — the grant the customer gave the agent', items: c.grant },
    { key: 'terms', title: 'Merchant terms at order time', items: c.terms },
    { key: 'delivery', title: 'Signed proof of delivery and shipment', items: shipmentItems(c.input.shipment, 'Signed proof of delivery') },
    { key: 'merchant_review', title: 'Correspondence documenting cardholder participation (merchant review record)', items: c.merchantReview },
    { key: 'verdict', title: 'Agent Receipt — line-by-line verdict', items: [], verdict: c.verdict, footer: VERDICT_FOOTER },
    { key: 'receipt', title: 'Record integrity — hash-chained receipt', items: c.receipt },
    { key: 'eligibility', title: 'Second presentment conditions', items: [
      present('Cardholder registration status (registered or guest checkout)', null, { obtain_from: ACQUIRER, note: MC_REGISTRATION_LINE }),
    ] },
  ]
  const notes = [
    'Mastercard guide: compelling evidence second presentment applies to specified non-face-to-face / e-commerce transactions, not Maestro, and needs at least one supporting document plus explanation when necessary. Confirm eligibility with your acquirer.',
    MC_REGISTRATION_LINE,
    'Mastercard guide: second presentment documentation received on or after a pre-arbitration or arbitration case filing is not considered.',
    DEADLINE_LINE,
  ]
  return { sections: withTone(sections), notes }
}

// ---------- needs (missing-documents checklist) ----------
const WHY: Record<Processor, Record<string, string>> = {
  visa: {
    'Payment credential (last 4 / token only)': 'Visa 10.4 compelling evidence must include the payment credential (last 4 / token only).',
    'Cardholder details (as recorded on the grant)': 'Visa 10.4 compelling evidence must include cardholder information.',
    'Proof of delivery': 'Proof of delivery / access is a strong response listed in the Visa guide.',
    'Product page / checkout as presented (screenshots)': 'Visa 13.3 / 13.5 responses need the description and terms exactly as presented at purchase.',
  },
  mastercard: {
    'Authorisation code / initial authorisation date': 'Listed among the Mastercard second presentment details (initial authorisation date / code).',
    'Settlement Date (DE 15) / Central Site Business Date': 'The Mastercard time frame is counted from this date.',
    'Message text (DE 72) and message reason code': 'Set by the acquirer for the second presentment.',
    'Signed proof of delivery': 'Listed in the Mastercard guide as second presentment documentation.',
    'Cardholder registration status (registered or guest checkout)': 'The Mastercard compelling evidence right does not apply when the cardholder purchased as a guest.',
  },
}
const COMMON_WHY: Record<string, string> = {
  'Processor reference': 'Ties this response to the dispute case at your acquirer.',
  'Shipment record': 'The pack is for a shipped order; Agent Proceed has no shipment record for it.',
  'Delivered on': 'Shows when the goods reached the customer.',
  Carrier: 'Identifies who delivered the goods.',
  'Tracking reference': 'Lets the acquirer check delivery.',
  'Dispute amount': 'The amount under dispute, as filed.',
  'Acquirer / channel': 'Where the dispute was filed.',
  'Payment method detail': 'Links the payment to the order.',
}

function collectNeeds(processor: Processor, sections: Section[]): Need[] {
  const seen = new Set<string>()
  const needs: Need[] = []
  for (const sec of sections) {
    for (const it of sec.items) {
      // The tamper check is a gate, shown as one line, not a document to obtain.
      if (it.status !== 'missing' || seen.has(it.label) || it.label === TAMPER_LABEL) continue
      seen.add(it.label)
      const from = it.obtain_from ?? ACQUIRER
      needs.push({
        item: it.label,
        why: WHY[processor][it.label] ?? COMMON_WHY[it.label] ?? (it.note ?? 'Required for this pack and not in the Agent Receipt record.'),
        obtain_from: from,
        merchant_input: from !== ACQUIRER,
      })
    }
  }
  return needs
}

// ---------- texts ----------
export function templateTexts(p: { processor_label: string; filed_label: string | null; order_ref: string | null; receipt_ref: string; claim: Pack['claim']; needs: Need[] }): Texts {
  const code = p.claim.condition_as_filed ? ` ${p.claim.condition_as_filed}` : ' (reason code not filed)'
  // The format being viewed is never presented as the processor the dispute was filed under.
  const filed = p.filed_label
    ? `The dispute was filed under ${p.filed_label}${code}.`
    : `Processor and reason code are not filed; ${p.processor_label} is only the format you are viewing.`
  const m = p.needs.length
  return {
    claim_plain: claimPlain(p.claim.claim_type, p.claim.as_filed),
    explanation:
      `This pack lays out the Agent Receipt record for order ${p.order_ref ?? p.receipt_ref} (${p.receipt_ref}), shown in ${p.processor_label} field order. ${filed} ` +
      (m ? `${m} ${m === 1 ? 'item is' : 'items are'} not in the record; each one names where to obtain it. ` : 'Every item this format lists is in the record. ') +
      'You decide with your acquirer whether to fight or concede.',
  }
}

// The only facts Spark receives: this dispute's own claim and the labels of what the pack holds and lacks.
// No grant values, no chat, no other order, no other merchant.
export function sparkInput(p: { processor_label: string; order_ref: string | null; receipt_ref: string; claim: Pack['claim']; sections: Section[]; needs: Need[] }) {
  return {
    processor: p.processor_label,
    order_ref: p.order_ref,
    receipt_ref: p.receipt_ref,
    claim_as_filed: p.claim.as_filed,
    claim_type: p.claim.claim_type_label,
    condition_as_filed: p.claim.condition_as_filed,
    condition_name: p.claim.condition_name,
    in_record: p.sections.flatMap((x) => x.items.filter((i) => i.status === 'present' && i.label !== TAMPER_LABEL).map((i) => i.label)),
    needed: p.needs.map((x) => x.item),
  }
}
export type SparkInput = ReturnType<typeof sparkInput>

// Words a pack text may not use: a recommendation, a prediction, a liability call or a score, in any wording.
const FORBIDDEN = /\b(recommend\w*|advis\w*|suggest\w*|should|ought|likel\w*|unlikel\w*|probab\w*|chance\w*|odds|score\w*|liab\w*|win|wins|winning|won|lose|loses|losing|lost|strong case|weak case|guarantee\w*|fault|blame\w*)\b/i
// Anything that looks like a fact: a token holding a digit, a hash, or an upper-case code.
const FACTISH = /sha256:[0-9a-f]+|\$?[A-Za-z]*\d[\w.$,%:/-]*|\b[A-Z]{2,}[A-Z0-9_.-]*\b/g

export function validateSparkTexts(raw: unknown, input: SparkInput): { ok: true; texts: Texts } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'No JSON object.' }
  const o = raw as Record<string, unknown>
  const claim = typeof o.claim_plain === 'string' ? o.claim_plain.trim() : ''
  const expl = typeof o.explanation === 'string' ? o.explanation.trim() : ''
  if (!claim || !expl) return { ok: false, reason: 'Missing claim_plain or explanation.' }
  if (claim.length > 300 || expl.length > 900) return { ok: false, reason: 'Text too long.' }
  const source = canonicalJson(input)
  for (const text of [claim, expl]) {
    if (FORBIDDEN.test(text)) return { ok: false, reason: 'Uses fight / concede advice, outcome or liability wording.' }
    for (const tok of text.match(FACTISH) ?? []) {
      const t = tok.replace(/[.,;:)]+$/, '')
      if (t && !source.includes(t)) return { ok: false, reason: `"${t}" is not in the record.` }
    }
  }
  return { ok: true, texts: { claim_plain: claim, explanation: expl } }
}

// ---------- build ----------
export function packHashOf(p: Omit<Pack, 'pack_hash'> | Pack): Promise<string> {
  const { pack_hash: _drop, ...rest } = p as Pack
  void _drop
  return sha256Hex(canonicalJson(rest)).then((h) => `sha256:${h}`)
}

export async function buildPack(input: PackInput): Promise<Pack> {
  const { receipt, dispute, processor } = input
  const filed = (s(dispute.processor) as Processor | null) ?? null
  const asFiled = s(dispute.reason_code)
  // The condition is looked up in the format being built, so a code filed under one network is never translated with
  // the other network's table. A Visa code shown in a Mastercard format has no translation.
  const key = filed === processor ? conditionKey(processor, asFiled) : null
  const cond = key ? CONDITIONS[processor][key] ?? null : null
  const claimType = (CLAIM_TYPES as string[]).includes(String(dispute.claim_type)) ? (dispute.claim_type as ClaimType) : null
  const codeFlag = cond?.fits && claimType && claimType !== 'other' && !cond.fits.includes(claimType) ? CODE_FLAG : null
  const claim: Pack['claim'] = {
    as_filed: s(dispute.reason) ?? '',
    claim_type: claimType,
    claim_type_label: claimType ? CLAIM_TYPE_LABEL[claimType] : 'Not filed',
    condition_as_filed: asFiled,
    condition_name: cond?.name ?? null,
    condition_plain: cond
      ? cond.plain
      : asFiled && filed && filed !== processor
        ? `Filed under ${PROCESSOR_LABEL[filed]} as "${asFiled}". This ${PROCESSOR_LABEL[processor]} format has no translation for it — confirm with acquirer.`
        : asFiled ? 'No plain-language translation in Agent Proceed for this code — confirm with acquirer.' : 'Reason code / condition not filed — obtain from acquirer.',
    code_flag: codeFlag,
  }
  const l2 = reviewItems(receipt, input.reviews)
  const ctx: Ctx = {
    input, key,
    grant: grantItems(input.grant, input.merchant.name),
    action: actionItems(receipt, input.action, input.proposal),
    terms: termsItems(receipt),
    receipt: receiptItems(receipt, input.gate),
    verdict: verdictRows(receipt),
    merchantReview: l2.items,
    claimItems: claimItems(input),
  }
  const t = processor === 'visa' ? visa(ctx) : mastercard(ctx)
  const needs = [...collectNeeds(processor, t.sections), ...l2.gaps]
  // A held order with no shipment record and no release: the merchant must say whether it shipped. Nothing is assumed.
  const released = input.reviews.some((r) => r.release_decision === 'released')
  if (!input.shipment && receipt.fulfillment === 'held' && !released) {
    needs.push({ item: 'Confirmation that this order shipped', why: 'Agent Receipt recorded this order as held for review, with no release record and no shipment record.', obtain_from: MERCHANT, merchant_input: true })
  }
  const base = {
    processor_label: PROCESSOR_LABEL[processor], filed_label: filed ? PROCESSOR_LABEL[filed] : null, order_ref: s(receipt.order_ref), receipt_ref: s(receipt.receipt_ref) ?? '', claim, sections: t.sections, needs,
  }
  let texts = templateTexts(base)
  let textSource: TextSource = 'rules-fallback'
  if (input.text_source === 'muse-spark' && input.texts) {
    const v = validateSparkTexts(input.texts, sparkInput(base))
    if (v.ok) {
      texts = v.texts
      textSource = 'muse-spark'
    }
  }
  const pack: Omit<Pack, 'pack_hash'> = {
    schema: 'agentreceipt.evidence-pack/v1',
    processor, processor_label: base.processor_label, filed_processor: filed, guide: GUIDE[processor],
    order_ref: base.order_ref, receipt_ref: base.receipt_ref, merchant: input.merchant.name,
    sample: isSample(dispute),
    trusted: input.gate.status === 'passed',
    claim,
    claim_vs_record: claimVsRecord(claimType, receipt, input.reviews),
    sections: t.sections,
    merchant_review_statement: l2.statement,
    needs,
    notes: t.notes,
    tamper_line: tamperLine(input.gate),
    texts,
    text_source: textSource,
    text_label: textSource === 'muse-spark' ? SPARK_LABEL : FALLBACK_LABEL,
    disclaimer: DISCLAIMER,
  }
  return { ...pack, pack_hash: await packHashOf(pack) }
}

export const merchantInputNeeds = (p: Pack) => p.needs.filter((x) => x.merchant_input)

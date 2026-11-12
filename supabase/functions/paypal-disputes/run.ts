// PayPal Sandbox dispute evidence, one request at a time. Pure TypeScript: the database and the PayPal client are
// injected, so tests run it without the network. Runs in the `paypal-disputes` edge function with the service role.
//
// Actions (and nothing else):
//   dispute_status   read-only: the PayPal dispute on this order's transaction, as PayPal reports it now.
//   submit_evidence  for ONE order of ONE merchant: reads its captured PayPal Sandbox payment (order id + capture id),
//                    finds the PayPal dispute on that transaction and, when PayPal offers the provide_evidence action,
//                    submits the order's evidence: receipt hash, PayPal order and transaction ids, reason code and the
//                    pre-fulfillment verdict (plus tracking when the order's shipment record has it). Only when PayPal
//                    accepts the evidence is one paypal_evidence_submissions row appended; the evidence packet is not changed.
//
// MERCHANT ISOLATION: the order must belong to merchant_id (receipt.merchant_id); a named dispute must belong to it.
import { PayPalError, type Attempt, type DisputeSummary, type EvidenceCandidate, type EvidenceInput, type PayPalDisputesClient, type StatusResult, type SubmitResult } from './paypal.ts'

type Row = Record<string, unknown>

export interface PayPalDisputesDb {
  merchant(id: string): Promise<{ id: string; name: string } | null>
  receiptById(merchantId: string, id: string): Promise<Row | null>
  disputeById(id: string): Promise<Row | null>
  paymentEvents(grantId: string): Promise<Row[]>
  shipment(receiptId: string): Promise<Row | null>
  // Appends one paypal_evidence_submissions row (only after PayPal accepted the evidence). Returns the stored row.
  recordSubmission(row: Row): Promise<{ id: string; submitted_at: string }>
}

// paypal: null when PAYPAL_CLIENT_ID / PAYPAL_SECRET are not set.
export type PayPalDisputesDeps = { db: PayPalDisputesDb; paypal: PayPalDisputesClient | null }

export type Reply =
  | {
    type: 'paypal_evidence'; environment: 'sandbox'; order_ref: string | null; paypal_order_id: string | null; result: SubmitResult
    // Set only for an accepted submission: the stored record, or why it could not be stored (PayPal still accepted it).
    recorded?: { id: string; submitted_at: string } | null; record_error?: string | null
  }
  | { type: 'paypal_status'; environment: 'sandbox'; order_ref: string | null; paypal_order_id: string | null; result: StatusResult }
  | { type: 'error'; message: string; paypal?: { status: number; issue: string | null; detail: string | null; dispute: DisputeSummary | null; attempts: Attempt[] } }

export const PAYPAL_NOT_SET_UP = 'PayPal Sandbox is not set up on the server (PAYPAL_CLIENT_ID / PAYPAL_SECRET).'
export const NO_CAPTURE = 'This order has no captured PayPal Sandbox payment, so there is no PayPal transaction to dispute.'
export const VERDICT_LABEL: Record<string, string> = { pass: 'Pass', review_required: 'Review Required', hold_suspicion: 'Hold for Suspicion' }

const UUID = /^[0-9a-f-]{36}$/i
const err = (message: string): Reply => ({ type: 'error', message })

// The evidence sent to PayPal: the order's own Agent Receipt record, as in the evidence packet. Nothing is inferred.
export function paypalEvidence(
  receipt: Row, payment: { paypal_order_id: string | null; capture_id: string }, dispute: Row | null, shipment: Row | null, pp: DisputeSummary,
): EvidenceInput {
  const plan = evidencePlan(pp.reason, shipment)
  if ('blocked' in plan) return plan
  const decision = typeof receipt.decision === 'string' ? VERDICT_LABEL[receipt.decision] ?? receipt.decision : 'No decision'
  const filed = typeof dispute?.reason_code === 'string' && dispute.reason_code
    ? `${typeof dispute.processor === 'string' ? `${dispute.processor} ` : ''}${dispute.reason_code} (as recorded in Agent Proceed)`
    : 'not recorded in Agent Proceed'
  const notes = [
    'Agent Proceed evidence packet (Agent Receipt record for an AI-agent purchase).',
    `Receipt ${String(receipt.receipt_ref ?? '')}, order ${String(receipt.order_ref ?? '-')}.`,
    `Receipt hash: ${String(receipt.entry_hash ?? '')}.`,
    `PayPal order ID: ${payment.paypal_order_id ?? 'not in record'}. PayPal transaction (capture) ID: ${payment.capture_id}.`,
    `Reason code: PayPal ${pp.reason ?? 'reason not given'}; card network code ${filed}.`,
    `Pre-fulfillment verdict: ${decision} (${Number(receipt.problems_found ?? 0)} problems found), sealed ${String(receipt.sealed_at ?? '').slice(0, 10)}.`,
    'The receipt is part of a hash-chained, append-only record. The full evidence packet is available on request.',
  ].join('\n')
  const ship = shipment
    ? `Shipment: ${String(shipment.carrier ?? 'carrier not in record')} ${String(shipment.tracking_ref ?? '')}, shipped ${String(shipment.shipped_on ?? 'date not in record')}${shipment.delivered_on ? `, delivered ${String(shipment.delivered_on)}` : ''}.`
    : 'Shipment: none in the Agent Receipt record.'
  return { candidates: plan.candidates, notes: [notes, ship].join('\n') }
}

export const NOT_RECEIVED_NO_SHIPMENT =
  'For an item-not-received dispute PayPal expects proof of fulfillment (shipment tracking) or proof of refund, and this order has no shipment in the Agent Receipt record. Nothing was sent: the record is not presented as proof of fulfillment.'

// Which PayPal evidence entries fit this dispute, from the order's own record. PayPal decides which types a dispute
// accepts, so record-type entries are tried in order (most fitting first); see paypal.ts. Tracking is sent only when the
// order's shipment record holds it.
export function evidencePlan(reason: string | null, shipment: Row | null): { candidates: EvidenceCandidate[] } | { blocked: string } {
  const tracking = shipment && typeof shipment.tracking_ref === 'string' && shipment.tracking_ref
    ? { tracking_info: [{ carrier_name: 'OTHER', carrier_name_other: String(shipment.carrier ?? 'Not in record'), tracking_number: shipment.tracking_ref }] }
    : null
  if (reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') {
    return tracking ? { candidates: [{ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: tracking }] } : { blocked: NOT_RECEIVED_NO_SHIPMENT }
  }
  const record = ['PROOF_OF_RECEIPT_COPY', 'DETAILS_OF_PURCHASE', 'MERCHANT_RESPONSE', 'VALID_SUPPORTING_DOCUMENT', 'COPY_OF_CONTRACT', 'AFFIDAVIT']
  const types = reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' ? ['ITEM_DESCRIPTION', ...record] : [...record, 'ITEM_DESCRIPTION']
  return { candidates: types.map((evidence_type) => ({ evidence_type })) }
}

// The order, its optional recorded dispute and its captured PayPal payment, for this merchant only.
async function orderFor(body: Row, deps: PayPalDisputesDeps) {
  const { db } = deps
  if (typeof body.merchant_id !== 'string' || !UUID.test(body.merchant_id)) return err('Unknown merchant.')
  const merchant = await db.merchant(body.merchant_id)
  if (!merchant) return err('Unknown merchant.')
  if (typeof body.receipt_id !== 'string' || !UUID.test(body.receipt_id)) return err('receipt_id is required.')
  const receipt = await db.receiptById(merchant.id, body.receipt_id)
  if (!receipt) return err('Order not found for this merchant.')
  let dispute: Row | null = null
  if (body.dispute_id !== undefined && body.dispute_id !== null) {
    if (typeof body.dispute_id !== 'string' || !UUID.test(body.dispute_id)) return err('Bad dispute_id.')
    dispute = await db.disputeById(body.dispute_id)
    if (!dispute || dispute.receipt_id !== receipt.id) return err('Dispute not found for this order.')
  }
  if (typeof receipt.grant_id !== 'string') return err(NO_CAPTURE)
  const captured = [...await db.paymentEvents(receipt.grant_id)].reverse().find((e) => e.event === 'captured' && typeof e.capture_id === 'string')
  if (!captured) return err(NO_CAPTURE)
  if (!deps.paypal) return err(PAYPAL_NOT_SET_UP)
  const payment = { paypal_order_id: typeof captured.paypal_order_id === 'string' ? captured.paypal_order_id : null, capture_id: captured.capture_id as string }
  return { merchant, receipt, dispute, payment, paypal: deps.paypal }
}

const paypalErr = (e: unknown): Reply =>
  e instanceof PayPalError
    ? { type: 'error', message: `${e.message}${e.issue ? ` (${e.issue})` : ''}.`, paypal: { status: e.status, issue: e.issue, detail: e.detail, dispute: e.dispute, attempts: e.attempts } }
    : err(`PayPal Sandbox could not be reached: ${e instanceof Error ? e.message : 'unknown error'}.`)

export async function submitEvidence(body: Row, deps: PayPalDisputesDeps): Promise<Reply> {
  const o = await orderFor(body, deps)
  if ('type' in o) return o
  const { db } = deps
  const { merchant, receipt, dispute, payment } = o
  const shipment = await db.shipment(receipt.id as string)
  try {
    const result = await o.paypal.submitEvidence(
      payment.capture_id,
      (pp) => paypalEvidence(receipt, payment, dispute, shipment, pp),
      `ap-evidence-${String(receipt.id)}`,
    )
    const reply: Extract<Reply, { type: 'paypal_evidence' }> = { type: 'paypal_evidence', environment: 'sandbox', order_ref: typeof receipt.order_ref === 'string' ? receipt.order_ref : null, paypal_order_id: payment.paypal_order_id, result }
    if (result.outcome !== 'submitted') return reply
    // Accepted by PayPal: record it. A storage failure is reported, never turned into a PayPal failure.
    try {
      reply.recorded = await db.recordSubmission(submissionRow(receipt, merchant.id, payment, result))
      reply.record_error = null
    } catch (e) {
      console.error('record submission failed', e instanceof Error ? e.message : e)
      reply.recorded = null
      reply.record_error = 'PayPal accepted the evidence, but Agent Proceed could not store the submission record.'
    }
    return reply
  } catch (e) {
    return paypalErr(e)
  }
}

export function submissionRow(
  receipt: Row, merchantId: string, payment: { paypal_order_id: string | null; capture_id: string }, r: Extract<SubmitResult, { outcome: 'submitted' }>,
): Row {
  const sent = (r.request as { evidences?: { evidence_type?: unknown; notes?: unknown }[] } | null)?.evidences?.[0]
  return {
    receipt_id: receipt.id, merchant_id: merchantId, order_ref: typeof receipt.order_ref === 'string' ? receipt.order_ref : null,
    environment: 'sandbox', paypal_dispute_id: r.dispute.dispute_id, paypal_order_id: payment.paypal_order_id, capture_id: payment.capture_id,
    evidence_type: typeof sent?.evidence_type === 'string' ? sent.evidence_type : r.attempts[r.attempts.length - 1]?.evidence_type ?? 'unknown',
    receipt_hash: String(receipt.entry_hash ?? ''), dispute_reason: r.dispute_before.reason,
    stage_before: r.dispute_before.stage, status_before: r.dispute_before.status,
    stage_after: r.dispute.stage, status_after: r.dispute.status, dispute_state_after: r.dispute.dispute_state,
    notes: typeof sent?.notes === 'string' ? sent.notes : null, source: 'paypal-disputes',
  }
}

// Read-only: the PayPal dispute on this order's transaction as PayPal reports it now. Sends nothing, writes nothing.
export async function disputeStatus(body: Row, deps: PayPalDisputesDeps): Promise<Reply> {
  const o = await orderFor(body, deps)
  if ('type' in o) return o
  try {
    const result = await o.paypal.disputeStatus(o.payment.capture_id)
    return { type: 'paypal_status', environment: 'sandbox', order_ref: typeof o.receipt.order_ref === 'string' ? o.receipt.order_ref : null, paypal_order_id: o.payment.paypal_order_id, result }
  } catch (e) {
    return paypalErr(e)
  }
}

export const ROUTES: Record<string, (body: Row, deps: PayPalDisputesDeps) => Promise<Reply>> = { submit_evidence: submitEvidence, dispute_status: disputeStatus }

// PayPal Sandbox webhook dispute intake. Pure TypeScript: signature verification, the database and the clock are
// injected, so tests run it without the network. Runs in the `paypal-webhook` edge function with the service role.
//
// Every request is logged (paypal_webhook_events: event type, dispute id, verification result, outcome; no secrets).
// Only a webhook that PayPal's verify-webhook-signature API answers SUCCESS for is acted on:
//   CUSTOMER.DISPUTE.CREATED   create the dispute record (paypal_dispute_records), matched to a recorded PayPal payment
//                              by the disputed transaction (capture) id, or kept and marked unmatched.
//   CUSTOMER.DISPUTE.UPDATED   update the record's status fields (created first if PayPal's CREATED never arrived).
//   CUSTOMER.DISPUTE.RESOLVED  same, with the outcome.
// Anything else verified is logged as ignored. A redelivered event (same event id, already processed) is logged as a
// duplicate and changes nothing. Rejected requests get 401, so PayPal can retry a genuine one; processed ones get 200.

type Row = Record<string, unknown>

export const DISPUTE_EVENTS = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'] as const
export const SIGNATURE_HEADERS = ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo'] as const

export type Verification = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'MISSING_HEADERS' | 'NOT_CONFIGURED'
export type SignatureHeaders = Record<(typeof SIGNATURE_HEADERS)[number], string>

export type Match = { receipt_id: string; merchant_id: string | null; order_ref: string | null; paypal_order_id: string | null }

export interface WebhookDb {
  logEvent(row: Row): Promise<void>
  eventProcessed(eventId: string): Promise<boolean>
  matchTransaction(transactionIds: string[]): Promise<Match | null>
  disputeRecord(disputeId: string): Promise<Row | null>
  insertDispute(row: Row): Promise<void>
  updateDispute(disputeId: string, patch: Row): Promise<void>
}

export type WebhookDeps = {
  db: WebhookDb
  // null when PAYPAL_WEBHOOK_ID (or the PayPal Sandbox credentials) are not set: nothing can be verified, so nothing is acted on.
  verify: ((headers: SignatureHeaders, rawBody: string) => Promise<'SUCCESS' | 'FAILURE'>) | null
  now: () => Date
}

export type WebhookResult = { status: number; body: { ok: boolean; outcome: string; verification: Verification; event_type: string | null; dispute_id: string | null; matched?: boolean } }

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const cents = (v: unknown): number | null => (typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null)
const ts = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null)

// The dispute fields Agent Proceed keeps, read from the webhook's resource (a PayPal dispute object).
export function disputeFields(resource: Row | null) {
  const r = resource ?? {}
  const amount = (r.dispute_amount ?? null) as { value?: unknown; currency_code?: unknown } | null
  const txs = Array.isArray(r.disputed_transactions) ? (r.disputed_transactions as Row[]) : []
  const transactionIds = txs.flatMap((t) => [str(t.seller_transaction_id), str(t.buyer_transaction_id)]).filter((x): x is string => !!x)
  return {
    dispute_id: str(r.dispute_id),
    reason: str(r.reason),
    status: str(r.status),
    stage: str(r.dispute_life_cycle_stage),
    outcome: str((r.dispute_outcome as Row | undefined)?.outcome_code),
    amount_cents: cents(amount?.value),
    currency: str(amount?.currency_code),
    seller_response_due_date: ts(r.seller_response_due_date),
    paypal_create_time: ts(r.create_time),
    paypal_update_time: ts(r.update_time),
    transaction_id: str(txs[0]?.seller_transaction_id) ?? str(txs[0]?.buyer_transaction_id),
    transaction_ids: transactionIds,
  }
}

export async function handleWebhook(rawBody: string, headers: Partial<SignatureHeaders>, deps: WebhookDeps): Promise<WebhookResult> {
  const { db } = deps
  let event: Row | null = null
  try { event = JSON.parse(rawBody) as Row } catch { event = null }
  const eventId = str(event?.id)
  const eventType = str(event?.event_type)
  const resourceType = str(event?.resource_type)
  const fields = disputeFields((event?.resource ?? null) as Row | null)
  const disputeId = fields.dispute_id

  const reply = async (status: number, verification: Verification, outcome: string, detail: string | null, matched?: boolean): Promise<WebhookResult> => {
    await db.logEvent({
      event_id: eventId, event_type: eventType, resource_type: resourceType, paypal_dispute_id: disputeId,
      verification, outcome, detail: detail ? detail.slice(0, 300) : null, environment: 'sandbox', received_at: deps.now().toISOString(),
    })
    return { status, body: { ok: status < 300, outcome, verification, event_type: eventType, dispute_id: disputeId, ...(matched === undefined ? {} : { matched }) } }
  }

  if (!event || !eventId || !eventType) return reply(400, 'ERROR', 'rejected', 'Body is not a PayPal webhook event.')
  const missing = SIGNATURE_HEADERS.filter((h) => !headers[h])
  if (missing.length) return reply(401, 'MISSING_HEADERS', 'rejected', `Missing PayPal signature headers: ${missing.join(', ')}.`)
  if (!deps.verify) return reply(503, 'NOT_CONFIGURED', 'rejected', 'PAYPAL_WEBHOOK_ID or PayPal Sandbox credentials are not set; nothing can be verified.')

  let verification: 'SUCCESS' | 'FAILURE'
  try {
    verification = await deps.verify(headers as SignatureHeaders, rawBody)
  } catch (e) {
    return reply(503, 'ERROR', 'rejected', `Could not verify with PayPal: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
  if (verification !== 'SUCCESS') return reply(401, 'FAILURE', 'rejected', 'PayPal verify-webhook-signature did not return SUCCESS.')

  if (!(DISPUTE_EVENTS as readonly string[]).includes(eventType)) return reply(200, 'SUCCESS', 'ignored', `Not a dispute event (${eventType}).`)
  if (!disputeId) return reply(200, 'SUCCESS', 'ignored', 'Dispute event without a dispute id.')
  if (await db.eventProcessed(eventId)) return reply(200, 'SUCCESS', 'duplicate', 'Already processed; nothing changed.')

  try {
    const now = deps.now().toISOString()
    const status = { reason: fields.reason, status: fields.status, stage: fields.stage, outcome: fields.outcome, seller_response_due_date: fields.seller_response_due_date, paypal_update_time: fields.paypal_update_time }
    const existing = await db.disputeRecord(disputeId)
    if (existing) {
      // Only fields PayPal actually sent are changed; a missing field never blanks a stored one.
      const patch: Row = Object.fromEntries(Object.entries(status).filter(([, v]) => v !== null))
      if (fields.amount_cents !== null) Object.assign(patch, { amount_cents: fields.amount_cents, currency: fields.currency })
      await db.updateDispute(disputeId, { ...patch, last_event_type: eventType, last_event_id: eventId, updated_at: now })
      return reply(200, 'SUCCESS', 'updated', `${eventType}: status ${fields.status ?? 'unchanged'}.`, existing.matched === true)
    }
    const match = await db.matchTransaction(fields.transaction_ids)
    await db.insertDispute({
      paypal_dispute_id: disputeId, environment: 'sandbox', matched: !!match,
      receipt_id: match?.receipt_id ?? null, merchant_id: match?.merchant_id ?? null, order_ref: match?.order_ref ?? null,
      paypal_order_id: match?.paypal_order_id ?? null, transaction_id: fields.transaction_id,
      ...status, amount_cents: fields.amount_cents, currency: fields.currency, paypal_create_time: fields.paypal_create_time,
      source: 'paypal_webhook', last_event_type: eventType, last_event_id: eventId, created_at: now, updated_at: now,
    })
    const how = match ? `matched order ${match.order_ref ?? '–'} by transaction ${fields.transaction_id}` : `unmatched: no recorded PayPal payment for transaction ${fields.transaction_id ?? '(none in the event)'}`
    return reply(200, 'SUCCESS', 'created', `${eventType}: ${how}.`, !!match)
  } catch (e) {
    // 500 so PayPal redelivers; the event is not marked processed.
    return reply(500, 'SUCCESS', 'error', `Could not store the dispute: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
}

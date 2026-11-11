// Row shapes for the AgentReceipt tables (supabase/001_schema_v0.2.sql). Shared by any view that
// reads them. Labelled "VI-aligned demo representation": fields follow Mastercard Verifiable Intent
// concepts (who, what, scope/constraints, expiry) without claiming compliance.
export type Sha256Hash = `sha256:${string}`

export type ChainFields = {
  chain_seq: number
  prev_hash: Sha256Hash
  entry_hash: Sha256Hash
}

// A null checkable field means "not specified, no check".
export type Grant = ChainFields & {
  id: string
  session_id: string
  version: number
  shopper_ref: string
  agent_id: string
  agent_verified: boolean
  merchant_id: string | null
  product_scope: string | null
  size_min_cm: number | null
  size_max_cm: number | null
  colour_preference: string | null
  currency: string
  amount_max_cents: number | null
  budget_limit_cents: number | null
  payment_method_ref: string | null
  shipping_method: string | null
  shipping_max_cost_cents: number | null
  delivery_by: string | null
  return_policy_required: boolean | null
  confirmed_at: string
  expires_at: string
  private_chat_hash: Sha256Hash
  grant_json: Record<string, unknown>
  schema_label: string
}

export type Proposal = ChainFields & {
  id: string
  grant_id: string
  product_id: string | null
  shown_item_price_cents: number
  shown_total_cents: number | null
  shown_returns_summary: string
  shown_delivery: string
  shown_at: string
  confirmation_ref: string
  confirmed_at: string
}

export type ActionType = 'view' | 'terms_read' | 'select' | 'shipping' | 'checkout' | 'data_share'

export type AgentAction = ChainFields & {
  id: string
  grant_id: string
  seq: number
  type: ActionType
  detail: Record<string, unknown>
  agent_believed_terms: Record<string, unknown> | null
  image_evidence_ref: Record<string, unknown> | null
}

export type MismatchResult = {
  field: string
  grant: string | null
  merchant_terms: string | null
  actual: string | null
  result: 'match' | 'mismatch' | 'unspecified' | 'missing' | 'cannot_determine' // cannot_determine: Returns only, never a problem by itself
  cause: string | null
  next_action_who: string | null
  cited_fields: string[]
  key?: string
  next_action?: string | null
  who?: 'Merchant' | null
}

// Post-dispute verdict. Null until a dispute exists.
// Post-dispute outcome only, and only for a separate disputed order. Never the pre-fulfillment decision.
export type Recommendation = 'represent' | 'concede'

// Pre-fulfillment decision from the auditor (supabase/functions/_shared/audit.ts). Separate from the post-dispute verdict.
export type Decision = 'pass' | 'review_required' | 'hold_suspicion'
export const DECISION_LABEL: Record<Decision, string> = { pass: 'Pass', review_required: 'Review Required', hold_suspicion: 'Hold for Suspicion' }
export type Fulfillment = 'proceed' | 'held' | 'shipped_override'

export type Receipt = ChainFields & {
  id: string
  receipt_ref: string
  order_ref: string | null
  grant_id: string
  proposal_id: string | null
  merchant_id: string
  terms_snapshot: Record<string, unknown>
  action_summary: Record<string, unknown>
  mismatch_results: MismatchResult[]
  problems_found: number
  recommendation: Recommendation | null
  missing_components: string[]
  image_evidence_ref: Record<string, unknown> | null
  schema_label: string
  sealed_at: string | null
  created_at?: string
  decision: Decision | null
  audit: Record<string, unknown> | null
  fulfillment: Fulfillment | null
}

// Layer 3, as filed by the processor. Fields not filed stay null (014_dispute_agent.sql). The reason code is stored as
// filed: no code selects or corrects it.
export type Dispute = {
  id: string
  receipt_id: string
  reason: string // the dispute claim as filed
  opened_at: string
  merchant_id?: string | null
  processor?: 'visa' | 'mastercard' | null
  channel?: string | null
  claim_type?: string | null
  reason_code?: string | null
  dispute_date?: string | null
  dispute_amount_cents?: number | null
  processor_reference?: string | null
  // Only on the in-memory sample example (src/dashboard/sampleDispute.ts); never a stored column.
  sample?: boolean
  card_last4_or_token?: string | null
}

// Layer 1 shipment / delivery record. Carrier, tracking and delivery proof stay null when not in the order system.
export type Shipment = ChainFields & {
  id: string
  receipt_id: string
  merchant_id: string
  shipped_on: string
  delivered_on: string | null
  carrier: string | null
  tracking_ref: string | null
  delivery_proof_ref: string | null
  source: string
  created_at?: string
}

// Layer 2: what the merchant did after a Review Required / Hold for Suspicion flag. Appended, never edited.
export type MerchantReview = ChainFields & {
  id: string
  receipt_id: string
  merchant_id: string
  action_taken: 'called_confirmed' | 'emailed_confirmed' | 'investigated_cleared' | 'override_documented' | 'kept_on_hold' | 'cancelled'
  method: 'phone' | 'email' | 'chat' | 'in_person' | 'other'
  notes: string
  confirmed_total: string | null
  confirmed_terms: string | null
  release_decision: 'released' | 'not_released'
  recorded_by: string
  recorded_at: string
}

// Merchant tracking events. 'recommendation' exists only on rows written before the Dispute Agent build; nothing writes
// it and no page shows it. 'represented' is the merchant's own "Fought (submitted to acquirer)".
export type DisputeEventType =
  | 'opened'
  | 'recommendation'
  | 'conceded'
  | 'represented'
  | 'pack_generated'
  | 'outcome_won'
  | 'outcome_lost'
  | 'pack_downloaded'
  | 'investigating'
  | 'outcome_pending'
  | 'outcome_conceded'
  | 'merchant_note'

export type DisputeEvent = ChainFields & {
  id: string
  dispute_id: string
  event_type: DisputeEventType
  decided_by: string | null
  basis: Record<string, unknown>
  created_at?: string
}

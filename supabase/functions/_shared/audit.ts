// AgentReceipt detection engine. Pure TypeScript, no Deno or browser APIs, so the edge function, the seed script,
// the tests and (later) the dashboard can all run the same rules.
//
// It decides PASS / REVIEW REQUIRED / HOLD FOR SUSPICION at order received, before fulfillment. It is the ONLY place these rules live.
//   Review Required   = "I trust the record, I don't trust the match."  (>= 1 field mismatch; hashes verify; all components present)
//   Hold for Suspicion = "I don't trust the record itself yet."        (hash fails, component missing, grant expired before the action, agent unverified)
//
// HONEST SCOPE: AgentReceipt does not block checkout, payment or shipment. It returns a recommendation (a signal).
// The merchant's order system holds shipment/capture; AgentReceipt only recommends.
//
// INPUTS (and nothing else): grant fields, the merchant's formal terms, the action record, the agent's STRUCTURED
// summary fields (agent_summary_returns, agent_summary_delivery, agent_believed_terms) and hash-check results with
// timestamps. Never the customer chat, never proposal free text, never shopper reasoning, never dispute or
// tamper-page data, never another order's grant.
// OUTPUT: structured JSON only (AuditResult). The dashboard renders it. There is no free-text verdict.
//
// A model never takes part in this file: no model call, no hash generated here.

export const MERCHANT_FOOTER =
  'AgentReceipt shows mismatch facts only; it does not decide liability and no network rule moves liability on this screen.'
export const RECOMMENDS_NOTE = 'AgentReceipt recommends review before shipping; your order system holds shipment/capture.'
export const SUSPICION_NOTE = 'AgentReceipt recommends holding for investigation; your order system holds shipment/capture.'
export const GAP_NOTE = 'Unverified agent, no AgentReceipt session opened, no receipt (gap recorded)'
export const PAYMENT_REF = 'Demo Checkout'

export type Decision = 'pass' | 'review_required' | 'hold_suspicion'
export const DECISION_LABEL: Record<Decision, string> = { pass: 'Pass', review_required: 'Review Required', hold_suspicion: 'Hold for Suspicion' }
// cannot_determine: only on Returns, when Spark (or the keyword fallback) cannot tell what the agent's summary, as presented,
// says about returns. It is never a match and never, by itself, a mismatch: it is not counted as a problem.
export type CheckResult = 'match' | 'mismatch' | 'unspecified' | 'missing' | 'cannot_determine'

export type GrantIn = {
  merchant_allowlist: string[]
  agent_verified: boolean | null // false = unverified agent
  product_scope: string | null
  amount_max_cents: number | null
  budget_limit_cents: number | null
  size_min_cm: number | null
  size_max_cm: number | null
  colour_preference: string | null
  delivery_by: string | null // exact date YYYY-MM-DD
  return_policy_required: boolean | null
  payment_method_ref: string | null
  sealed_at: string | null // the grant's confirmed_at
  expires_at: string | null
}

export type ActionIn = {
  product_category: string | null
  merchant: string | null
  colour: string | null
  size_cm: number | null
  item_price_cents: number | null
  shipping_cents: number | null
  total_cents: number | null // item + shipping, calculated by the store, never item-only
  delivery_date: string | null // exact date YYYY-MM-DD, from the store's shipping data
  sealed_at: string | null
  payment_method_ref: string | null
  agent_summary_returns: string | null // structured field the shopper set on its proposal record
  agent_summary_delivery: string | null // structured field the shopper set on its proposal record
  agent_believed_returns: string | null // structured field from agent_believed_terms.returns
}

export type TermsIn = {
  formal_returns: 'free' | 'fee' | 'final_sale' | null
  formal_terms_text: string | null
}

// Results of hash recomputation done elsewhere (verify.ts). null = could not be checked.
export type HashIn = { grant_ok: boolean | null; proposal_ok: boolean | null; action_ok: boolean | null; links_ok: boolean | null }

// Spark call 3: do the agent's STRUCTURED returns fields and the merchant's formal terms say the same thing?
// Spark answers the language question only; the rules below make the match and decide the verdict.
// The summary may be in any language (tested: English, Spanish, Hindi); the formal terms stay in English.
// returns_comparison is the three-way answer. Without it, matches === null means "could not tell" and the plain keyword
// reading is used instead (the earlier shape, kept for callers that do not set returns_comparison).
export type ReturnsComparison = 'match' | 'mismatch' | 'cannot_determine'
export type SemanticReturns = {
  returns_summary_matches_terms: boolean | null
  returns_comparison?: ReturnsComparison
  reason: string
  source: 'muse-spark' | 'rules-fallback'
}
export const RETURNS_CANNOT_DETERMINE = 'Returns comparison cannot be determined from summary as presented — merchant review required for that field'
// Spark call 4: the agent's delivery phrase (for example "Wed Oct 28") rewritten as an exact date. Code compares dates.
export type SemanticDelivery = { claimed_date: string | null; source: 'muse-spark' | 'rules-fallback' }

export type AuditInput = {
  session_opened: boolean
  grant: GrantIn | null
  action: ActionIn | null
  terms: TermsIn | null
  proposal_present: boolean
  hash: HashIn | null
  semantic_returns?: SemanticReturns | null
  semantic_delivery?: SemanticDelivery | null
}

export type Check = {
  key: string
  field: string
  grant: string | null
  merchant_terms: string | null
  actual: string | null
  result: CheckResult
  cause: string | null
  next_action: string | null
  who: 'Merchant' | null
  next_action_who: string | null
  cited_fields: string[]
}

export type AuditResult = {
  decision: Decision // a gap (no session, no grant, no action, no receipt) is Hold for Suspicion with `gap` set
  problems: number
  problem_fields: string[]
  missing_components: string[]
  tamper_failed: boolean
  checks: Check[]
  merchant_action: string | null
  flag: string | null
  note: string | null
  gap: string | null
  semantic_source: 'muse-spark' | 'rules-fallback' | null
  suspicion_reasons: string[] // why the record itself is not trusted (empty for Pass / Review Required)
  // The only agent-written fields the auditor saw, plus what Spark said about them. No chat, no proposal text.
  agent_summary: {
    agent_summary_returns: string | null
    agent_summary_delivery: string | null
    agent_believed_terms: string | null
    returns_summary_matches_terms: boolean | null
    returns_comparison?: ReturnsComparison
    returns_reason: string | null
    delivery_claimed_date: string | null
    delivery_source: 'muse-spark' | 'rules-fallback' | null
  } | null
  footer: string
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EXACT_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function dateLabel(d: string): string {
  const t = new Date(`${d}T00:00:00Z`)
  return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`
}

export const isExactTimestamp = (s: unknown): s is string => typeof s === 'string' && EXACT_TS.test(s) && !Number.isNaN(Date.parse(s))
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

type Kind = 'final_sale' | 'returnable' | null

// Reads the structured believed-returns text. Anything that is not clearly final sale or returnable is unknown.
export function kindOfText(s: string | null): Kind {
  if (!s) return null
  if (/final\s*sale|no\s+returns?|non-?returnable|not\s+returnable/i.test(s)) return 'final_sale'
  if (/return/i.test(s)) return 'returnable'
  return null
}

const kindOfFormal = (f: TermsIn['formal_returns']): Kind => (f === 'final_sale' ? 'final_sale' : f ? 'returnable' : null)

function check(
  key: string, field: string, result: CheckResult, parts: { grant: string | null; terms: string | null; actual: string | null },
  cited: string[], problem?: { cause: string; next_action: string },
): Check {
  return {
    key, field, grant: parts.grant, merchant_terms: parts.terms, actual: parts.actual, result,
    cause: problem?.cause ?? null,
    next_action: problem?.next_action ?? null,
    who: problem ? 'Merchant' : null,
    next_action_who: problem ? `${problem.next_action} — Who: Merchant` : null,
    cited_fields: cited,
  }
}

const unspecified = (key: string, field: string, terms: string | null, actual: string | null, cited: string[]) =>
  check(key, field, 'unspecified', { grant: null, terms, actual }, cited)

export function audit(input: AuditInput): AuditResult {
  const { grant, action, terms } = input

  // A gap: nothing was recorded at all. No decision is invented for it.
  if (!input.session_opened && !grant && !action && !input.hash) {
    return {
      decision: 'hold_suspicion', problems: 0, problem_fields: [], missing_components: [], tamper_failed: false, checks: [],
      merchant_action: 'Do not proceed. Investigate the agent first.', flag: 'Hold for Suspicion — unverified agent, no record',
      note: SUSPICION_NOTE, gap: GAP_NOTE, semantic_source: null, suspicion_reasons: ['unverified agent, no AgentReceipt session'],
      agent_summary: null, footer: MERCHANT_FOOTER,
    }
  }

  // ----- 10. Missing components (decided first because REVIEW overrides, but reported last) -----
  const missing: string[] = []
  if (!grant) missing.push('grant record')
  if (!action) missing.push('action record')
  if (!terms || !terms.formal_returns || !terms.formal_terms_text) missing.push('formal terms')
  if (!input.proposal_present) missing.push('proposal record')
  if (!input.hash) missing.push('hash record')
  else if ([input.hash.grant_ok, input.hash.proposal_ok, input.hash.action_ok, input.hash.links_ok].some((v) => v === null)) missing.push('hash record')
  // 9. exact timestamps
  if (grant && !isExactTimestamp(grant.sealed_at)) missing.push('grant sealed_at')
  if (action && !isExactTimestamp(action.sealed_at)) missing.push('action sealed_at')

  const checks: Check[] = []
  const g = grant
  const a = action

  if (g && a) {
    // 1. Product
    if (!g.product_scope) checks.push(unspecified('product', 'Product', a.product_category, a.product_category, ['product_scope']))
    else if (!a.product_category) {
      missing.push('action product')
      checks.push(check('product', 'Product', 'missing', { grant: g.product_scope, terms: null, actual: null }, ['product_scope']))
    } else if (a.product_category.toLowerCase() === g.product_scope.toLowerCase()) {
      checks.push(check('product', 'Product', 'match', { grant: g.product_scope, terms: a.product_category, actual: a.product_category }, ['product_scope']))
    } else {
      checks.push(check('product', 'Product', 'mismatch', { grant: g.product_scope, terms: a.product_category, actual: a.product_category }, ['product_scope'], {
        cause: `Grant covers ${g.product_scope}; the order is a ${a.product_category}`,
        next_action: 'Merchant reviews — confirm the item with the customer, or cancel / adjust order',
      }))
    }

    // 2. Price / budget: the TOTAL (item + shipping). amount.max and budget.limit collapse into ONE check.
    const caps = [g.amount_max_cents, g.budget_limit_cents].filter((n): n is number => typeof n === 'number')
    if (caps.length === 0) checks.push(unspecified('budget', 'Budget', a.item_price_cents === null ? null : `Item ${usd(a.item_price_cents)} + shipping ${usd(a.shipping_cents ?? 0)}`, a.total_cents === null ? null : `${usd(a.total_cents)} total`, ['amount_max_cents', 'budget_limit_cents']))
    else if (a.total_cents === null) {
      missing.push('action total')
      checks.push(check('budget', 'Budget', 'missing', { grant: `${usd(Math.min(...caps))} max`, terms: null, actual: null }, ['amount_max_cents', 'budget_limit_cents']))
    } else {
      const cap = Math.min(...caps)
      const detail = `Item ${usd(a.item_price_cents ?? 0)} + shipping ${usd(a.shipping_cents ?? 0)}`
      const parts = { grant: `${usd(cap)} max`, terms: detail, actual: `${usd(a.total_cents)} total` }
      if (a.total_cents <= cap) checks.push(check('budget', 'Budget', 'match', parts, ['amount_max_cents', 'budget_limit_cents']))
      else {
        checks.push(check('budget', 'Budget', 'mismatch', parts, ['amount_max_cents', 'budget_limit_cents'], {
          cause: `Total ${usd(a.total_cents)} (item + shipping) is over the ${usd(cap)} budget`,
          next_action: `Merchant reviews — ask customer to confirm ${usd(a.total_cents)} total, or cancel / adjust order`,
        }))
      }
    }

    // 3. Delivery: exact dates, taken from the store's shipping data. Also: the arrival the agent TOLD the customer
    //    (its structured delivery field, rewritten as a date by Spark or the fallback) must equal the real arrival.
    {
      const claimed = input.semantic_delivery?.claimed_date ?? null
      const claimWrong = !!claimed && isDate(claimed) && isDate(a.delivery_date) && claimed !== a.delivery_date
      const claimCause = claimWrong ? `Agent told the customer arrival ${dateLabel(claimed as string)}; the order arrives ${dateLabel(a.delivery_date as string)}` : null
      const claimNext = 'Merchant reviews — confirm the arrival date with the customer, or cancel / adjust order'
      if (!g.delivery_by) {
        checks.push(claimWrong
          ? check('delivery', 'Delivery', 'mismatch', { grant: null, terms: null, actual: dateLabel(a.delivery_date as string) }, ['delivery_by'], { cause: claimCause as string, next_action: claimNext })
          : unspecified('delivery', 'Delivery', null, a.delivery_date && isDate(a.delivery_date) ? dateLabel(a.delivery_date) : null, ['delivery_by']))
      } else if (!isDate(a.delivery_date)) {
        missing.push('action delivery_date')
        checks.push(check('delivery', 'Delivery', 'missing', { grant: `By ${dateLabel(g.delivery_by)}`, terms: null, actual: null }, ['delivery_by']))
      } else {
        const parts = { grant: `By ${dateLabel(g.delivery_by)}`, terms: null, actual: dateLabel(a.delivery_date) }
        if (a.delivery_date > g.delivery_by) {
          checks.push(check('delivery', 'Delivery', 'mismatch', parts, ['delivery_by'], {
            cause: `Delivery ${dateLabel(a.delivery_date)} is after the ${dateLabel(g.delivery_by)} deadline`,
            next_action: 'Merchant reviews — confirm later delivery date with customer, or choose faster shipping',
          }))
        } else if (claimWrong) {
          checks.push(check('delivery', 'Delivery', 'mismatch', parts, ['delivery_by'], { cause: claimCause as string, next_action: claimNext }))
        } else checks.push(check('delivery', 'Delivery', 'match', parts, ['delivery_by']))
      }
    }

    // 4. Colour: no preference = no check (never pass, never fail). Otherwise exact match.
    if (!g.colour_preference) checks.push(unspecified('colour', 'Colour', null, a.colour, ['colour_preference']))
    else {
      const parts = { grant: g.colour_preference, terms: a.colour, actual: a.colour }
      if (a.colour === g.colour_preference) checks.push(check('colour', 'Colour', 'match', parts, ['colour_preference']))
      else {
        checks.push(check('colour', 'Colour', 'mismatch', parts, ['colour_preference'], {
          cause: `Customer asked for ${g.colour_preference}; the order is ${a.colour ?? 'a colour that is not listed'}`,
          next_action: 'Merchant reviews — confirm the colour with the customer, or cancel / adjust order',
        }))
      }
    }

    // 5. Size: inside the range. No range = no check.
    if (g.size_min_cm === null && g.size_max_cm === null) checks.push(unspecified('size', 'Size', null, a.size_cm === null ? null : `${a.size_cm}cm`, ['size_min_cm', 'size_max_cm']))
    else {
      const range = `${g.size_min_cm ?? 'any'}-${g.size_max_cm ?? 'any'}cm`
      if (a.size_cm === null) {
        missing.push('action size')
        checks.push(check('size', 'Size', 'missing', { grant: range, terms: null, actual: null }, ['size_min_cm', 'size_max_cm']))
      } else {
        const parts = { grant: range, terms: `${a.size_cm}cm`, actual: `${a.size_cm}cm` }
        const inside = (g.size_min_cm === null || a.size_cm >= g.size_min_cm) && (g.size_max_cm === null || a.size_cm <= g.size_max_cm)
        if (inside) checks.push(check('size', 'Size', 'match', parts, ['size_min_cm', 'size_max_cm']))
        else {
          checks.push(check('size', 'Size', 'mismatch', parts, ['size_min_cm', 'size_max_cm'], {
            cause: `Size ${a.size_cm}cm is outside the ${range} range`,
            next_action: 'Merchant reviews — confirm the size with the customer, or cancel / adjust order',
          }))
        }
      }
    }

    // 6. Merchant allowlist.
    {
      const allow = g.merchant_allowlist
      const parts = { grant: `${allow.join(', ')} only`, terms: a.merchant, actual: a.merchant }
      if (a.merchant && allow.includes(a.merchant)) checks.push(check('merchant', 'Merchant', 'match', parts, ['merchant_id']))
      else {
        checks.push(check('merchant', 'Merchant', 'mismatch', parts, ['merchant_id'], {
          cause: `${a.merchant ?? 'The merchant'} is not on the grant's merchant allowlist`,
          next_action: 'Merchant reviews — confirm the merchant with the customer, or cancel / adjust order',
        }))
      }
    }

    // 7. Payment: present vs missing only. Which payment was chosen never changes the result.
    {
      const present = a.payment_method_ref === PAYMENT_REF
      const parts = { grant: g.payment_method_ref, terms: PAYMENT_REF, actual: a.payment_method_ref }
      if (present) checks.push(check('payment', 'Payment method', 'match', parts, ['payment_method_ref']))
      else {
        checks.push(check('payment', 'Payment method', 'mismatch', parts, ['payment_method_ref'], {
          cause: a.payment_method_ref ? `Payment is recorded as "${a.payment_method_ref}", not as a demo checkout` : 'No payment method is recorded on the order',
          next_action: 'Merchant reviews — confirm the payment with the customer, or cancel / adjust order',
        }))
      }
    }

    // 8. Return / exchange: grant vs formal terms vs the agent's STRUCTURED summary fields.
    if (g.return_policy_required !== true) {
      checks.push(unspecified('returns', 'Returns', terms?.formal_terms_text ?? null, a.agent_believed_returns ?? a.agent_summary_returns, ['return_policy_required']))
    } else if (!terms || !terms.formal_returns || !terms.formal_terms_text) {
      // Terms are missing: this is a missing component, never a pass or a fail on Returns.
      checks.push(check('returns', 'Returns', 'missing', { grant: 'Returnable required', terms: null, actual: a.agent_summary_returns ?? a.agent_believed_returns }, ['return_policy_required']))
    } else {
      const said = a.agent_summary_returns ?? a.agent_believed_returns
      const formal = kindOfFormal(terms.formal_returns)
      const sem = input.semantic_returns
      // Does the agent's claim say what the formal terms say? Spark's answer when it gave one; otherwise the keyword reading.
      // "Cannot determine" (only ever about a summary that is present) is kept as such: never a match, never a mismatch.
      const undetermined = !!said && sem?.returns_comparison === 'cannot_determine'
      const sameAsTerms: boolean | null = undetermined ? null
        : sem?.returns_comparison === 'match' ? true
          : sem?.returns_comparison === 'mismatch' ? false
            : sem && sem.returns_summary_matches_terms !== null
              ? sem.returns_summary_matches_terms
              : (() => { const k = kindOfText(said); return k === null ? null : k === formal })()
      const parts = { grant: 'Returnable required', terms: terms.formal_terms_text, actual: said ? `Agent summary "${said}"` : null }
      const next = `Merchant reviews — confirm ${terms.formal_terms_text} terms with customer, or cancel / offer returnable alternative`
      if (formal === 'final_sale') {
        // Final sale fails, even when the agent told the customer "Easy returns".
        checks.push(check('returns', 'Returns', 'mismatch', parts, ['return_policy_required'], {
          cause: sameAsTerms === false && said
            ? `Agent summary "${said}" misrepresented the formal terms ("${terms.formal_terms_text}")`
            : `Grant requires returnable; formal terms are "${terms.formal_terms_text}"`,
          next_action: next,
        }))
      } else if (sameAsTerms === false) {
        checks.push(check('returns', 'Returns', 'mismatch', parts, ['return_policy_required'], {
          cause: `Agent summary "${said}" misrepresented the formal terms ("${terms.formal_terms_text}")`,
          next_action: next,
        }))
      } else if (undetermined) {
        // Recorded for the merchant, but not a problem: the other checks decide the verdict, as they always do.
        checks.push(check('returns', 'Returns', 'cannot_determine', parts, ['return_policy_required'], {
          cause: RETURNS_CANNOT_DETERMINE,
          next_action: `Merchant reviews the Returns field — confirm ${terms.formal_terms_text} terms with customer`,
        }))
      } else {
        checks.push(check('returns', 'Returns', 'match', parts, ['return_policy_required']))
      }
    }

    // 9. Timestamp / validity.
    if (isExactTimestamp(a.sealed_at) && g.expires_at !== null) {
      if (!isExactTimestamp(g.expires_at)) {
        missing.push('grant expires_at')
        checks.push(check('validity', 'Grant validity', 'missing', { grant: null, terms: null, actual: a.sealed_at }, ['expires_at']))
      } else {
        const parts = { grant: `Valid until ${g.expires_at}`, terms: null, actual: `Order sealed ${a.sealed_at}` }
        if (Date.parse(a.sealed_at) <= Date.parse(g.expires_at)) checks.push(check('validity', 'Grant validity', 'match', parts, ['expires_at']))
        else {
          checks.push(check('validity', 'Grant validity', 'mismatch', parts, ['expires_at'], {
            cause: 'Action after grant validity expired',
            next_action: 'Merchant reviews — the grant had expired when the order was sealed; confirm with customer, or cancel / adjust order',
          }))
        }
      }
    } else if (isExactTimestamp(a.sealed_at)) {
      checks.push(unspecified('validity', 'Grant validity', null, `Order sealed ${a.sealed_at}`, ['expires_at']))
    } else {
      checks.push(check('validity', 'Grant validity', 'missing', { grant: g.expires_at, terms: null, actual: null }, ['expires_at']))
    }
  }

  // ----- hash verification -----
  const tamper_failed = !!input.hash && [input.hash.grant_ok, input.hash.proposal_ok, input.hash.action_ok, input.hash.links_ok].some((v) => v === false)

  const problem_fields = checks.filter((c) => c.result === 'mismatch').map((c) => c.field)
  const missing_components = [...new Set(missing)]
  const problems = problem_fields.length

  // Hold for Suspicion = the RECORD is not trusted: hash fails, a component is missing, the grant had expired before
  // the action, or the agent is unverified. Review Required = the record is trusted but the MATCH is not.
  const suspicion_reasons: string[] = []
  if (tamper_failed) suspicion_reasons.push('hash verification failed')
  if (missing_components.length > 0) suspicion_reasons.push(`missing record: ${missing_components.join(', ')}`)
  if (checks.some((c) => c.key === 'validity' && c.result === 'mismatch')) suspicion_reasons.push('grant expired before the action')
  if (grant && grant.agent_verified === false) suspicion_reasons.push('unverified agent')

  // ----- decision: exactly these three outcomes -----
  let decision: Decision
  if (suspicion_reasons.length > 0) decision = 'hold_suspicion'
  else if (problems >= 1) decision = 'review_required'
  else decision = 'pass'

  const sr = input.semantic_returns
  const sd = input.semantic_delivery
  const agent_summary = a
    ? {
      agent_summary_returns: a.agent_summary_returns, agent_summary_delivery: a.agent_summary_delivery, agent_believed_terms: a.agent_believed_returns,
      returns_summary_matches_terms: sr ? sr.returns_summary_matches_terms : null,
      // only when the three-way reader answered, so receipts sealed before this field existed hash exactly as before
      ...(sr?.returns_comparison ? { returns_comparison: sr.returns_comparison } : {}),
      returns_reason: sr ? sr.reason : null,
      delivery_claimed_date: sd ? sd.claimed_date : null, delivery_source: sd ? sd.source : null,
    }
    : null

  const undeterminedFields = checks.filter((c) => c.result === 'cannot_determine').map((c) => c.field)

  return {
    decision, problems, problem_fields, missing_components, tamper_failed, checks,
    merchant_action:
      decision === 'pass' && undeterminedFields.length > 0 ? `Proceed — ship / finalize capture. Merchant review of the ${undeterminedFields.join(', ')} field: comparison cannot be determined from the summary as presented.`
      : decision === 'pass' ? 'Proceed — ship / finalize capture. No review needed.'
        : decision === 'review_required' ? 'Do not ship yet. Merchant review needed before fulfillment.'
          : 'Do not proceed. Investigate the record or the agent first.',
    flag:
      decision === 'pass' ? null
        : decision === 'review_required' ? 'Merchant review needed'
          : 'Hold for Suspicion — investigate the record or agent first',
    note: decision === 'pass' ? null : decision === 'review_required' ? RECOMMENDS_NOTE : SUSPICION_NOTE,
    gap: null,
    semantic_source: sr?.source ?? null,
    suspicion_reasons, agent_summary,
    footer: MERCHANT_FOOTER,
  }
}

// Orders requiring attention = HOLD or REVIEW. A dispute is not needed to flag an order.
export const requiresAttention = (d: Decision | null): boolean => d === 'review_required' || d === 'hold_suspicion'

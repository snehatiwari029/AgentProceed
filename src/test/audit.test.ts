import { describe, expect, it } from 'vitest'
import { audit, RETURNS_CANNOT_DETERMINE, GAP_NOTE, MERCHANT_FOOTER, RECOMMENDS_NOTE, requiresAttention, type AuditInput, type GrantIn, type ActionIn } from '../../supabase/functions/_shared/audit'

const okHash = { grant_ok: true, proposal_ok: true, action_ok: true, links_ok: true }

const grant = (over: Partial<GrantIn> = {}): GrantIn => ({
  merchant_allowlist: ['Northwind Outfitters'], product_scope: 'snowboard', amount_max_cents: 50000, budget_limit_cents: 50000,
  size_min_cm: 150, size_max_cm: 165, colour_preference: null, delivery_by: '2026-10-30', return_policy_required: true,
  payment_method_ref: 'Demo Checkout', sealed_at: '2026-10-26T17:05:00.000Z', expires_at: '2026-10-27T17:05:00.000Z', agent_verified: true, ...over,
})

const hero = (over: Partial<ActionIn> = {}): ActionIn => ({
  product_category: 'snowboard', merchant: 'Northwind Outfitters', colour: 'Serpent', size_cm: 156, item_price_cents: 44995,
  shipping_cents: 6000, total_cents: 50995, delivery_date: '2026-10-30', sealed_at: '2026-10-26T17:11:00.000Z',
  payment_method_ref: 'Demo Checkout', agent_summary_returns: 'Easy returns', agent_summary_delivery: null, agent_believed_returns: 'Easy returns', ...over,
})

const orca = (over: Partial<ActionIn> = {}): ActionIn => ({
  product_category: 'snowboard', merchant: 'Northwind Outfitters', colour: null, size_cm: 156, item_price_cents: 48983,
  shipping_cents: 0, total_cents: 48983, delivery_date: '2026-10-29', sealed_at: '2026-10-26T18:06:00.000Z',
  payment_method_ref: 'Demo Checkout', agent_summary_returns: 'Free returns', agent_summary_delivery: null, agent_believed_returns: 'Free returns', ...over,
})

const finalSale = { formal_returns: 'final_sale' as const, formal_terms_text: 'Final Sale' }
const freeReturns = { formal_returns: 'free' as const, formal_terms_text: 'Free returns within 30 days' }

const input = (over: Partial<AuditInput> = {}): AuditInput => ({
  session_opened: true, grant: grant(), action: hero(), terms: finalSale, proposal_present: true, hash: okHash, ...over,
})

const result = (r: ReturnType<typeof audit>, field: string) => r.checks.find((c) => c.field === field)!

describe('detection engine: Pass / Review Required / Hold for Suspicion', () => {
  it('hero 12322: exactly 2 problems (Budget, Returns) and Review Required', () => {
    const r = audit(input())
    expect(r.decision).toBe('review_required')
    expect(r.problems).toBe(2)
    expect(r.problem_fields).toEqual(['Budget', 'Returns'])
    expect(r.missing_components).toEqual([])
    expect(r.flag).toBe('Merchant review needed')
    expect(r.note).toBe(RECOMMENDS_NOTE)
    expect(requiresAttention(r.decision)).toBe(true)
    // the checks that should match, match
    for (const f of ['Product', 'Delivery', 'Size', 'Colour', 'Merchant', 'Payment method', 'Grant validity']) {
      expect(['match', 'unspecified']).toContain(result(r, f).result)
    }
    const budget = result(r, 'Budget')
    expect(budget).toMatchObject({ grant: '$500.00 max', actual: '$509.95 total', result: 'mismatch', who: 'Merchant' })
    expect(budget.next_action).toBe('Merchant reviews — ask customer to confirm $509.95 total, or cancel / adjust order')
    const returns = result(r, 'Returns')
    expect(returns.result).toBe('mismatch')
    expect(returns.cause).toContain('misrepresented the formal terms')
    expect(returns.next_action).toBe('Merchant reviews — confirm Final Sale terms with customer, or cancel / offer returnable alternative')
    expect(r.footer).toBe(MERCHANT_FOOTER)
  })

  it('checks the TOTAL, never the item price alone, and collapses amount.max and budget.limit into ONE budget check', () => {
    const r = audit(input())
    expect(r.checks.filter((c) => c.key === 'budget')).toHaveLength(1)
    // item alone ($449.95) is under the cap; only the total is over
    const under = audit(input({ action: hero({ shipping_cents: 0, total_cents: 44995 }) }))
    expect(result(under, 'Budget').result).toBe('match')
  })

  it('Scenario B 13422: 0 problems, colour not checked, PASS, not requiring attention', () => {
    const r = audit(input({ grant: grant({ product_scope: null }), action: orca(), terms: freeReturns }))
    expect(r.decision).toBe('pass')
    expect(r.problems).toBe(0)
    expect(result(r, 'Colour').result).toBe('unspecified')
    expect(result(r, 'Returns').result).toBe('match')
    expect(r.flag).toBeNull()
    expect(r.merchant_action).toBe('Proceed — ship / finalize capture. No review needed.')
    expect(requiresAttention(r.decision)).toBe(false)
  })

  it('unspecified colour (grant null, action Serpent) is not a problem and does not block PASS', () => {
    const r = audit(input({ action: hero({ shipping_cents: 0, total_cents: 44995, delivery_date: '2026-10-29' }), terms: freeReturns, grant: grant({ colour_preference: null }) }))
    expect(result(r, 'Colour').result).toBe('unspecified')
    expect(r.decision).toBe('pass')
  })

  it('specified colour must match exactly', () => {
    const r = audit(input({ grant: grant({ colour_preference: 'Black' }), action: orca({ colour: 'Serpent' }), terms: freeReturns }))
    expect(result(r, 'Colour').result).toBe('mismatch')
    expect(r.decision).toBe('review_required')
  })

  it('Returns: Final sale fails even when the agent said "Easy returns"; free returns with a matching summary passes', () => {
    expect(result(audit(input()), 'Returns').result).toBe('mismatch')
    const free = audit(input({ terms: freeReturns, action: orca() }))
    expect(result(free, 'Returns').result).toBe('match')
  })

  it('Returns: believed terms that contradict the formal terms fail with the misrepresented cause', () => {
    const r = audit(input({ terms: freeReturns, action: orca({ agent_believed_returns: 'Final sale', agent_summary_returns: 'Final sale' }) }))
    expect(result(r, 'Returns').result).toBe('mismatch')
    expect(result(r, 'Returns').cause).toContain('misrepresented the formal terms')
  })

  it('Returns: no returns requirement in the grant means no check', () => {
    const r = audit(input({ grant: grant({ return_policy_required: null }) }))
    expect(result(r, 'Returns').result).toBe('unspecified')
    expect(r.problem_fields).toEqual(['Budget']) // the live 2-day prompt has no returns rule: 1 problem
    expect(r.decision).toBe('review_required')
  })

  it('Returns: the semantic read from Muse Spark is used when given, and reported', () => {
    const r = audit(input({ terms: freeReturns, action: orca({ agent_believed_returns: 'ok to send back within a month' }), semantic_returns: { returns_summary_matches_terms: true, reason: 'Both claim returns.', source: 'muse-spark' } }))
    expect(result(r, 'Returns').result).toBe('match')
    expect(r.semantic_source).toBe('muse-spark')
  })

  it('Delivery: later than the deadline is a problem, with the specific next action', () => {
    const r = audit(input({ action: hero({ delivery_date: '2026-10-31' }), terms: freeReturns }))
    expect(result(r, 'Delivery')).toMatchObject({ result: 'mismatch', next_action: 'Merchant reviews — confirm later delivery date with customer, or choose faster shipping' })
  })

  it('Size outside the range, wrong product, wrong merchant: each is a problem', () => {
    const r = audit(input({ action: orca({ size_cm: 170, product_category: 'ski', merchant: 'Elsewhere Co' }), terms: freeReturns }))
    expect(r.problem_fields).toEqual(['Product', 'Size', 'Merchant'])
  })

  it('Product: quote marks, case and a plural are not a mismatch (test order 15004)', () => {
    for (const scope of ['"snowboard"', 'Snowboard', ' snowboards ', '\u201Csnowboard\u201D']) {
      const r = audit(input({ grant: grant({ product_scope: scope }), action: orca(), terms: freeReturns }))
      expect(result(r, 'Product').result, scope).toBe('match')
    }
    const ski = audit(input({ grant: grant({ product_scope: '"ski"' }), action: orca(), terms: freeReturns }))
    expect(result(ski, 'Product').result).toBe('mismatch')
  })

  it('Size: no range in the grant means no check', () => {
    const r = audit(input({ grant: grant({ size_min_cm: null, size_max_cm: null }), terms: freeReturns, action: orca({ size_cm: 200 }) }))
    expect(result(r, 'Size').result).toBe('unspecified')
  })

  it('Payment: present vs missing only. The method chosen never changes the result', () => {
    // the audit input carries only the payment reference, never the card network or checkout method
    expect(result(audit(input({ action: orca(), terms: freeReturns })), 'Payment method').result).toBe('match')
    const r = audit(input({ action: orca({ payment_method_ref: null }), terms: freeReturns }))
    expect(result(r, 'Payment method').result).toBe('mismatch')
    expect(JSON.stringify(audit(input()))).not.toMatch(/mastercard|visa|••|paypal/i)
  })

  it('expired grant: action sealed after expires_at is Hold for Suspicion with the expired cause', () => {
    const r = audit(input({ action: orca({ sealed_at: '2026-10-28T09:00:00.000Z' }), terms: freeReturns }))
    expect(r.decision).toBe('hold_suspicion')
    expect(r.suspicion_reasons).toContain('grant expired before the action')
    expect(result(r, 'Grant validity')).toMatchObject({ result: 'mismatch', cause: 'Action after grant validity expired' })
  })

  it('missing formal terms: Hold for Suspicion, terms listed as missing, Returns is neither passed nor failed', () => {
    const r = audit(input({ terms: null }))
    expect(r.decision).toBe('hold_suspicion')
    expect(r.missing_components).toContain('formal terms')
    expect(result(r, 'Returns').result).toBe('missing')
    expect(r.flag).toBe('Hold for Suspicion — investigate the record or agent first')
    expect(requiresAttention(r.decision)).toBe(true)
  })

  it('missing terms text also counts as missing', () => {
    expect(audit(input({ terms: { formal_returns: 'free', formal_terms_text: null } })).missing_components).toContain('formal terms')
  })

  it('each missing record component forces Hold for Suspicion, whatever the problem count', () => {
    expect(audit(input({ proposal_present: false })).missing_components).toContain('proposal record')
    expect(audit(input({ hash: null })).missing_components).toContain('hash record')
    expect(audit(input({ action: null })).missing_components).toContain('action record')
    expect(audit(input({ grant: null })).missing_components).toContain('grant record')
    for (const r of [audit(input({ proposal_present: false })), audit(input({ hash: null })), audit(input({ action: null }))]) expect(r.decision).toBe('hold_suspicion')
    // an order that would be Review Required with 2 problems is still Hold for Suspicion if a component is missing
    const r = audit(input({ proposal_present: false }))
    expect(r.problems).toBe(2)
    expect(r.decision).toBe('hold_suspicion')
  })

  it('a missing or inexact timestamp is a missing component, not a pass or fail', () => {
    expect(audit(input({ action: hero({ sealed_at: null }) })).missing_components).toContain('action sealed_at')
    expect(audit(input({ action: hero({ sealed_at: 'now' }) })).decision).toBe('hold_suspicion')
    expect(audit(input({ action: hero({ sealed_at: '2026-10-26' }) })).decision).toBe('hold_suspicion')
    expect(audit(input({ grant: grant({ sealed_at: null }) })).missing_components).toContain('grant sealed_at')
  })

  it('an unspecified grant field is NOT a missing component', () => {
    const r = audit(input({ grant: grant({ colour_preference: null, size_min_cm: null, size_max_cm: null, delivery_by: null, return_policy_required: null, product_scope: null, amount_max_cents: null, budget_limit_cents: null }), terms: freeReturns, action: orca() }))
    expect(r.missing_components).toEqual([])
    expect(r.decision).toBe('pass')
  })

  it('tamper: any failed hash recomputation is Hold for Suspicion, flagged, and never a pass', () => {
    const clean = audit(input({ grant: grant({ return_policy_required: null }), action: hero({ shipping_cents: 0, total_cents: 44995, delivery_date: '2026-10-29' }), terms: finalSale }))
    expect(clean.decision).toBe('pass') // original $449.95 verifies
    for (const bad of [{ ...okHash, action_ok: false }, { ...okHash, grant_ok: false }, { ...okHash, links_ok: false }, { ...okHash, proposal_ok: false }]) {
      const r = audit(input({ grant: grant({ return_policy_required: null }), action: hero({ shipping_cents: 0, total_cents: 44995, delivery_date: '2026-10-29' }), hash: bad }))
      expect(r.decision).toBe('hold_suspicion')
      expect(r.tamper_failed).toBe(true)
      expect(r.flag).toBe('Hold for Suspicion — investigate the record or agent first')
    }
  })

  it('gap 14522: no session, grant, action or receipt is Hold for Suspicion (unverified agent), with the gap note', () => {
    const r = audit({ session_opened: false, grant: null, action: null, terms: null, proposal_present: false, hash: null })
    expect(r.decision).toBe('hold_suspicion')
    expect(r.checks).toEqual([])
    expect(r.gap).toBe(GAP_NOTE)
    expect(r.suspicion_reasons).toContain('unverified agent, no Agent Receipt session')
    expect(requiresAttention(r.decision)).toBe(true)
  })

  it('output is structured JSON only: no free-text verdict field', () => {
    const r = audit(input())
    expect(Object.keys(r).sort()).toEqual(['agent_summary', 'checks', 'decision', 'flag', 'footer', 'gap', 'merchant_action', 'missing_components', 'note', 'problem_fields', 'problems', 'semantic_source', 'suspicion_reasons', 'tamper_failed'])
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
    expect(JSON.stringify(r)).not.toMatch(/liab(le|ility) (is|rests|falls)/i)
  })

  it('checks run in the specified order', () => {
    expect(audit(input()).checks.map((c) => c.field)).toEqual(['Product', 'Budget', 'Delivery', 'Colour', 'Size', 'Merchant', 'Payment method', 'Returns', 'Grant validity'])
  })

  it('unverified agent on the grant is Hold for Suspicion even with 0 problems', () => {
    const r = audit(input({ grant: grant({ agent_verified: false, return_policy_required: null }), action: hero({ shipping_cents: 0, total_cents: 44995, delivery_date: '2026-10-29' }) }))
    expect(r.problems).toBe(0)
    expect(r.decision).toBe('hold_suspicion')
    expect(r.suspicion_reasons).toEqual(['unverified agent'])
  })

  it('Review Required means the record is trusted: no suspicion reasons, no missing components', () => {
    const r = audit(input())
    expect(r.decision).toBe('review_required')
    expect(r.suspicion_reasons).toEqual([])
    expect(r.note).toBe(RECOMMENDS_NOTE)
  })

  it('Returns: Spark says the agent claim does NOT match the terms, so a free-returns product still fails', () => {
    const r = audit(input({ terms: freeReturns, action: orca({ agent_summary_returns: 'all sales final, sorry', agent_believed_returns: 'all sales final, sorry' }), semantic_returns: { returns_summary_matches_terms: false, reason: 'Agent says no returns; terms allow them.', source: 'muse-spark' } }))
    expect(result(r, 'Returns').result).toBe('mismatch')
    expect(r.agent_summary?.returns_reason).toBe('Agent says no returns; terms allow them.')
  })

  it('Returns: a claim Spark reads as matching ("no-hassle returns") passes against free returns; the keyword fallback does the same', () => {
    const sem = { returns_summary_matches_terms: true, reason: 'Both claim returns.', source: 'muse-spark' as const }
    expect(result(audit(input({ terms: freeReturns, action: orca({ agent_summary_returns: 'no-hassle returns' }), semantic_returns: sem })), 'Returns').result).toBe('match')
    expect(result(audit(input({ terms: freeReturns, action: orca({ agent_summary_returns: 'no-hassle returns' }) })), 'Returns').result).toBe('match')
  })

  it('Delivery: an arrival date the agent told the customer must equal the real arrival (agent claim vs store)', () => {
    const wrong = audit(input({ terms: freeReturns, action: orca({ agent_summary_delivery: 'Fri Oct 30' }), semantic_delivery: { claimed_date: '2026-10-30', source: 'rules-fallback' } }))
    expect(result(wrong, 'Delivery')).toMatchObject({ result: 'mismatch', cause: 'Agent told the customer arrival Fri 30 Oct 2026; the order arrives Thu 29 Oct 2026' })
    const right = audit(input({ terms: freeReturns, action: orca({ agent_summary_delivery: 'Thu Oct 29' }), semantic_delivery: { claimed_date: '2026-10-29', source: 'rules-fallback' } }))
    expect(result(right, 'Delivery').result).toBe('match')
  })

  it('the audit output carries only structured agent fields: no chat, no proposal text', () => {
    const r = audit(input({ action: orca({ agent_summary_delivery: 'Thu Oct 29' }), terms: freeReturns }))
    expect(Object.keys(r.agent_summary ?? {}).sort()).toEqual(['agent_believed_terms', 'agent_summary_delivery', 'agent_summary_returns', 'delivery_claimed_date', 'delivery_source', 'returns_reason', 'returns_summary_matches_terms'])
    expect(JSON.stringify(r)).not.toMatch(/"(chat|messages|proposal_text|transcript)"/)
  })
})

describe('detection engine: multilingual Returns comparison, Cannot determine', () => {
  const cannot = { returns_summary_matches_terms: null, returns_comparison: 'cannot_determine' as const, reason: 'Cannot tell.', source: 'muse-spark' as const }
  const es = 'Consulta la política de la tienda'

  it('is recorded as Cannot determine, not a match and not a problem; all else passing, the verdict is Pass', () => {
    const r = audit(input({ terms: freeReturns, action: orca({ agent_summary_returns: es, agent_believed_returns: es }), semantic_returns: cannot }))
    expect(result(r, 'Returns')).toMatchObject({ result: 'cannot_determine', cause: RETURNS_CANNOT_DETERMINE, who: 'Merchant' })
    expect(r).toMatchObject({ decision: 'pass', problems: 0, problem_fields: [] })
    expect(r.agent_summary?.returns_comparison).toBe('cannot_determine')
  })

  it('does not force Review Required by itself; another mismatch (late delivery) decides it', () => {
    const r = audit(input({ terms: freeReturns, grant: grant({ delivery_by: '2026-10-28' }), action: orca({ agent_summary_returns: es, agent_believed_returns: es }), semantic_returns: cannot }))
    expect(result(r, 'Returns').result).toBe('cannot_determine')
    expect(r).toMatchObject({ decision: 'review_required', problems: 1, problem_fields: ['Delivery'] })
  })

  it('does not hide a missing record: Hold for Suspicion still wins', () => {
    const r = audit(input({ terms: freeReturns, proposal_present: false, action: orca({ agent_summary_returns: es, agent_believed_returns: es }), semantic_returns: cannot }))
    expect(r.decision).toBe('hold_suspicion')
  })

  it('the earlier answer shape (no returns_comparison) behaves exactly as before, and adds no new key', () => {
    const r = audit(input({ terms: freeReturns, action: orca({ agent_believed_returns: 'ok to send back within a month' }), semantic_returns: { returns_summary_matches_terms: true, reason: 'Both claim returns.', source: 'muse-spark' } }))
    expect(result(r, 'Returns').result).toBe('match')
    expect(Object.keys(r.agent_summary ?? {})).not.toContain('returns_comparison')
  })
})

import { describe, expect, it } from 'vitest'
import { handle, type AgentReply, type ProductRow, type Step, type Store } from '../../supabase/functions/shopper-agent/agent'
import { appendChained, type ChainDb } from '../../supabase/functions/auditor/chain'
import { runAuditor, type AuditorDb } from '../../supabase/functions/auditor/run'
import { CANNOT_DETERMINE_REASON, RETURNS_HARDENING, RETURNS_SYSTEM, cleanReason, createSparkReader, parseExactDeliveryPhrase, readComparison, type SemanticReader } from '../../supabase/functions/auditor/spark'
import { RETURNS_CANNOT_DETERMINE, kindOfText } from '../../supabase/functions/auditor/audit'
import { FINAL_SALE, FREE_30, ML_CASES, UNSPECIFIED_CASES, mlCase } from './multilingualFixtures'
import type { ModelClient, ModelReply } from '../../supabase/functions/shopper-agent/model'
import { verifyChain, type ChainRecord } from '../shared/chain'

const BURTON = '40c70768-77ac-4953-8bae-c75c8319fcf4'
const ORCA = 'd53088eb-40e0-4fa5-b2f8-1b81e9c7c37e'
const MERCHANT = '32b14be6-26e6-49df-a7af-79532f910510'

const PRODUCTS: ProductRow[] = [
  { id: BURTON, name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', category: 'snowboard', size_cm: 156, colour: 'Serpent', price_cents: 44995, currency: 'USD', marketing_blurb: 'Easy returns.', standard_shipping_cents: 0, standard_delivery_days: 5, expedited_shipping_cents: 6000, expedited_delivery_days: 4 },
  { id: ORCA, name: 'T. Rice Orca Snowboard 2025/2026', brand: 'Lib Tech', category: 'snowboard', size_cm: 156, colour: null, price_cents: 48983, currency: 'USD', marketing_blurb: 'Free returns.', standard_shipping_cents: 0, standard_delivery_days: 3, expedited_shipping_cents: null, expedited_delivery_days: null },
]
const TERMS: Record<string, { formal_returns: string; formal_terms_text: string }> = {
  [BURTON]: { formal_returns: 'final_sale', formal_terms_text: 'Final Sale' },
  [ORCA]: { formal_returns: 'free', formal_terms_text: 'Free returns within 30 days' },
}

// One in-memory "database" that plays Postgres: it assigns chain_seq and created_at, like the real tables do.
function world() {
  const tables: Record<string, Record<string, unknown>[]> = { sessions: [], session_events: [], grants: [], proposals: [], actions: [], receipts: [] }
  const reads: string[] = []
  let seq = 0
  const stamp = (table: string, row: Record<string, unknown>) => {
    seq += 1
    const stored = { ...row, chain_seq: seq, created_at: '2026-10-26T18:00:00.000Z' }
    tables[table].push(stored)
    return stored
  }
  const chainRows = () => ['grants', 'proposals', 'actions', 'receipts'].flatMap((t) => tables[t]).sort((a, b) => (a.chain_seq as number) - (b.chain_seq as number))
  const chainDb: ChainDb = {
    latestHash: async () => (chainRows().at(-1)?.entry_hash as string | undefined) ?? null,
    insert: async (table, row) => void stamp(table, row),
  }
  const store: Store = {
    listProducts: async () => PRODUCTS,
    merchantId: async () => MERCHANT,
    hasStep: async (sid, step: Step) => tables.session_events.some((e) => e.session_id === sid && e.step === step),
    createSession: async (row) => void tables.sessions.push(row),
    logStep: async (session_id, step, detail, simulated) => void tables.session_events.push({ session_id, step, detail, simulated }),
    addGrant: async (row) => void (await appendChained(chainDb, 'grants', row)),
    addProposal: async (row) => void (await appendChained(chainDb, 'proposals', row)),
    addAction: async (grant_id, type, detail, believed) => {
      await appendChained(chainDb, 'actions', { id: `act-${seq}`, grant_id, seq: 1, type, detail, agent_believed_terms: believed, image_evidence_ref: null })
      return 1
    },
  }
  const auditorDb: AuditorDb = {
    ...chainDb,
    sessionExists: async (id) => tables.sessions.some((s) => s.id === id),
    grantForSession: async (id) => { reads.push(`grant:${id}`); return tables.grants.find((g) => g.session_id === id) ?? null },
    proposalForGrant: async (id) => tables.proposals.find((p) => p.grant_id === id) ?? null,
    checkoutForGrant: async (id) => tables.actions.find((a) => a.grant_id === id && a.type === 'checkout') ?? null,
    product: async (id) => {
      const p = PRODUCTS.find((x) => x.id === id)
      const t = TERMS[id]
      return p && t ? { category: p.category, ...t, merchant_name: 'Northwind Outfitters', row: { ...p } } : null
    },
    merchantName: async () => 'Northwind Outfitters',
    entryHashAt: async (s) => (chainRows().find((r) => r.chain_seq === s)?.entry_hash as string | undefined) ?? null,
    receiptForGrant: async (id) => tables.receipts.find((r) => r.grant_id === id) ?? null,
    refs: async () => tables.receipts.map((r) => ({ receipt_ref: r.receipt_ref as string, order_ref: (r.order_ref as string | null) ?? null })),
    logStep: async (session_id, step, detail) => void tables.session_events.push({ session_id, step, detail, simulated: false }),
  }
  const records = (): ChainRecord[] => chainRows().map((r) => ({ chain_seq: r.chain_seq as number, entry_type: ((['grants', 'proposals', 'actions', 'receipts'] as const).find((t) => tables[t].includes(r))!.slice(0, -1)) as ChainRecord['entry_type'], row: r as ChainRecord['row'] }))
  return { tables, store, auditorDb, reads, records, attention: () => tables.receipts.filter((r) => r.decision === 'review_required' || r.decision === 'hold_suspicion').length }
}

const call = (name: string, args: unknown, id = `c${Math.random()}`): ModelReply => ({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const fake = (script: (() => ModelReply)[]): ModelClient => {
  let i = 0
  return { complete: async () => { const f = script[i++]; if (!f) throw new Error('over-called'); return f() } }
}

let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const NOW = () => new Date('2026-10-26T18:00:00Z')
const CHAT = 'Help me place an order for a snowboard for this weekend trip with my friends. It should look cool, size 150-165 cm, I need it by Friday. Budget under $500. I should be able to return it if it doesn\'t work for me.'
const rules = { budget_max_dollars: 500, size_min_cm: 150, size_max_cm: 165, colour_preference: null, delivery_by: '2026-10-30', return_policy_required: true, product_scope: 'snowboard', why: 'Reading your request' }

// The reader the auditor uses. Records exactly what Spark would be sent: structured fields only.
// `agrees` = the agent's claim means what a returnable product's terms mean (true) or the opposite (false).
type ReturnsIn = Parameters<SemanticReader['readReturns']>[0]
function reader(agrees: boolean | null = true) {
  const sent: ReturnsIn[] = []
  const sentDelivery: string[] = []
  const r: SemanticReader = {
    readReturns: async (i) => { sent.push(i); return { returns_summary_matches_terms: agrees === null ? null : (i.formal_returns === 'final_sale' ? !agrees : agrees), reason: 'test reader', source: 'muse-spark' } },
    readDelivery: async (phrase, today) => { sentDelivery.push(phrase); return { claimed_date: parseExactDeliveryPhrase(phrase, today), source: 'rules-fallback' } },
  }
  return { r, sent, sentDelivery }
}

// A full order through the real shopper brain, with the order-received signal wired to the real auditor.
async function placeOrder(w: ReturnType<typeof world>, pick: { id: string; ship: 'standard' | 'expedited'; said: string }, r: SemanticReader, wire = true, ruleOver: Partial<typeof rules> | Record<string, unknown> = {}) {
  const first = (await handle({ messages: [{ role: 'user', text: CHAT }] }, {
    model: fake([
      () => call('set_order_rules', { ...rules, ...ruleOver }, 'a'),
      () => call('propose_products', { message: 'Looking for snowboards under $500 that arrive by Friday and that you can return. Here are two options:', payment_stated: false, why: 'Showing picks', offers: [{ product_id: pick.id, shipping_method: pick.ship, summary: pick.said }] }),
    ]),
    store: w.store, now: NOW, newId,
  })) as Extract<AgentReply, { type: 'proposals' }> & AgentReply
  expect(first.type).toBe('proposals')
  const done = await handle(
    { messages: [{ role: 'user', text: CHAT }, { role: 'assistant', text: first.text }, { role: 'user', text: 'Order it. Use my PayPal.' }], draft: first.draft, offers: first.offers },
    {
      model: fake([() => call('place_order', { product_id: pick.id, payment_method: 'PayPal', why: 'Placing your order' })]), store: w.store, now: NOW, newId,
      onOrderReceived: wire ? async (sid) => void (await runAuditor({ session_id: sid }, { db: w.auditorDb, reader: r, now: NOW, newId })) : undefined,
    },
  )
  expect(done.type).toBe('ordered')
  return done as Extract<AgentReply, { type: 'ordered' }> & AgentReply
}

describe('auditor: live runs on stored records', () => {
  it('hero: the auditor runs at order received, finds 2 problems, Review Required, and Orders requiring attention goes 0 -> 1', async () => {
    const w = world()
    const rd = reader(true)
    // Scenario B first: PASS, nothing needs attention
    await placeOrder(w, { id: ORCA, ship: 'standard', said: 'Free returns' }, rd.r)
    expect(w.tables.receipts).toHaveLength(1)
    expect(w.tables.receipts[0]).toMatchObject({ decision: 'pass', problems_found: 0, fulfillment: 'proceed', recommendation: null })
    expect(w.attention()).toBe(0)

    // the hero: Burton + expedited, told "Easy returns" while the formal terms are Final sale
    await placeOrder(w, { id: BURTON, ship: 'expedited', said: 'Easy returns' }, rd.r)
    expect(w.tables.receipts).toHaveLength(2)
    const hero = w.tables.receipts[1]
    expect(hero).toMatchObject({ decision: 'review_required', problems_found: 2, fulfillment: 'held', recommendation: null, missing_components: [] })
    expect((hero.audit as { problem_fields: string[] }).problem_fields).toEqual(['Budget', 'Returns'])
    expect(hero.receipt_ref).toBe('AR-2026-0002')
    expect(hero.order_ref).toBe('15002')
    expect(w.attention()).toBe(1) // no dispute was filed; the order is flagged immediately
    // the receipt is a real chained, sealed record that verifies
    expect(typeof hero.sealed_at).toBe('string')
    expect((await verifyChain(w.records())).ok).toBe(true)
    // receipt_issued is logged on the session
    expect(w.tables.session_events.filter((e) => e.step === 'receipt_issued')).toHaveLength(2)
    // editing the stored receipt breaks verification
    const forged = w.records().map((r) => (r.row.receipt_ref === 'AR-2026-0002' ? { ...r, row: { ...r.row, problems_found: 0 } } : r))
    expect((await verifyChain(forged)).ok).toBe(false)
  })

  it('a repeat call returns the verdict already on record and writes nothing', async () => {
    const w = world()
    const rd = reader()
    const done = await placeOrder(w, { id: BURTON, ship: 'expedited', said: 'Easy returns' }, rd.r)
    const again = await runAuditor({ session_id: done.session_id }, { db: w.auditorDb, reader: rd.r, now: NOW, newId })
    expect(again).toMatchObject({ type: 'audit', issued: false, receipt_ref: 'AR-2026-0001' })
    expect(w.tables.receipts).toHaveLength(1)
  })

  it('tamper: an action edited after it was written fails hash recomputation -> Hold for Suspicion, never pass', async () => {
    const w = world()
    const rd = reader()
    const done = await placeOrder(w, { id: ORCA, ship: 'standard', said: 'Free returns' }, rd.r, false)
    const action = w.tables.actions[0]
    ;(action.detail as Record<string, unknown>).total_cents = 4498 // $44.99
    const r = await runAuditor({ session_id: done.session_id }, { db: w.auditorDb, reader: rd.r, now: NOW, newId })
    expect(r.type).toBe('audit')
    if (r.type !== 'audit') return
    expect(r.audit.decision).toBe('hold_suspicion')
    expect(r.audit.tamper_failed).toBe(true)
    expect(r.attention).toBe(true)
    expect(w.tables.receipts[0]).toMatchObject({ decision: 'hold_suspicion' })
  })

  it('missing formal terms: Hold for Suspicion with terms listed missing, Returns neither passed nor failed', async () => {
    const w = world()
    const rd = reader()
    const done = await placeOrder(w, { id: ORCA, ship: 'standard', said: 'Free returns' }, rd.r, false)
    const db: AuditorDb = { ...w.auditorDb, product: async () => null }
    const r = await runAuditor({ session_id: done.session_id }, { db, reader: rd.r, now: NOW, newId })
    if (r.type !== 'audit') throw new Error('expected audit')
    expect(r.audit.decision).toBe('hold_suspicion')
    expect(r.audit.missing_components).toContain('formal terms')
    expect(r.audit.checks.find((c) => c.field === 'Returns')!.result).toBe('missing')
  })

  it('gap: an unknown session is Hold for Suspicion with the gap note and writes no receipt', async () => {
    const w = world()
    const r = await runAuditor({ session_id: '11111111-1111-4111-8111-111111111111' }, { db: w.auditorDb, reader: reader().r, now: NOW, newId })
    if (r.type !== 'audit') throw new Error('expected audit')
    expect(r.audit.decision).toBe('hold_suspicion')
    expect(r.attention).toBe(true)
    expect(r.audit.gap).toBe('Unverified agent, no AgentReceipt session opened, no receipt (gap recorded)')
    expect(w.tables.receipts).toHaveLength(0)
  })

  it('isolation: reads one order, sends Spark only structured fields, and the receipt holds no chat, reasoning or card details', async () => {
    const w = world()
    const rd = reader()
    await placeOrder(w, { id: ORCA, ship: 'standard', said: 'Free returns' }, rd.r) // another order already on record
    const done = await placeOrder(w, { id: BURTON, ship: 'expedited', said: 'Easy returns' }, rd.r)
    w.reads.length = 0
    rd.sent.length = 0
    await runAuditor({ session_id: done.session_id }, { db: w.auditorDb, reader: rd.r, now: NOW, newId })
    expect(w.reads).toEqual([`grant:${done.session_id}`]) // only this order's grant is ever read
    expect(rd.sent).toEqual([]) // repeat call: nothing re-sent
    // first-run input to Spark for the hero: exactly the agent's returns text and the formal terms text
    const fresh = world()
    const rd2 = reader()
    await placeOrder(fresh, { id: BURTON, ship: 'expedited', said: 'Easy returns' }, rd2.r)
    expect(rd2.sent).toEqual([{ agent_summary_returns: 'Easy returns', agent_believed_terms: 'Easy returns', formal_returns: 'final_sale', formal_terms_text: 'Final Sale' }])
    // Spark is never sent the chat or any proposal free text: structured fields and the delivery label only
    expect(JSON.stringify([rd2.sent, rd2.sentDelivery])).not.toMatch(/weekend trip|looks cool|Looking for snowboards|Use my PayPal/i)
    const stored = JSON.stringify(fresh.tables.receipts)
    expect(stored).not.toMatch(/weekend trip|looks cool|Use my PayPal/i)
    expect(stored).not.toMatch(/mastercard|visa|••|\d{4} \d{4}/i)
    expect(stored).not.toMatch(/liability column/i)
  })

  it('if Spark is unavailable the keyword reading is used and labelled, and a Final sale still fails', async () => {
    const w = world()
    const failing: SemanticReader = createSparkReader(undefined)
    await placeOrder(w, { id: BURTON, ship: 'expedited', said: 'Easy returns' }, failing)
    const a = w.tables.receipts[0].audit as { semantic_source: string; problem_fields: string[]; decision: string }
    expect(a.semantic_source).toBe('rules-fallback')
    expect(a.problem_fields).toEqual(['Budget', 'Returns'])
    expect(a.decision).toBe('review_required')
  })
})

describe('auditor: Muse Spark reader', () => {
  const ok = (content: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch
  const IN: ReturnsIn = { agent_summary_returns: 'no-hassle returns', agent_believed_terms: 'no-hassle returns', formal_returns: 'final_sale', formal_terms_text: 'Final Sale' }

  it('returns comparison sends only the structured fields and uses the answer', async () => {
    let body = ''
    const f = (async (_u: string, init: RequestInit) => { body = String(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{"returns_summary_matches_terms": false, "reason": "Agent claims returns; terms are final sale."}' } }] }), { status: 200 }) }) as unknown as typeof fetch
    const r = await createSparkReader('key', f).readReturns(IN)
    expect(r).toEqual({ returns_summary_matches_terms: false, returns_comparison: 'mismatch', reason: 'Agent claims returns; terms are final sale.', source: 'muse-spark' })
    expect(body).toContain('"model":"muse-spark-1.3"')
    expect(body).toContain('no-hassle returns')
    // exactly two fields go to Spark: the summary as presented and the English formal terms
    const user = JSON.parse(JSON.parse(body).messages[1].content)
    expect(Object.keys(user).sort()).toEqual(['agent_summary_returns', 'formal_terms_text'])
    expect(body).not.toMatch(/tool_calls|weekend|budget|chat"/i)
  })

  it('returns comparison falls back, labelled, on no key, an error, or an unreadable answer', async () => {
    const final = { ...IN, agent_summary_returns: 'Final sale', agent_believed_terms: null }
    expect(await createSparkReader(undefined).readReturns(final)).toMatchObject({ returns_summary_matches_terms: true, source: 'rules-fallback' })
    expect(await createSparkReader('k', (async () => new Response('no', { status: 500 })) as unknown as typeof fetch).readReturns(IN)).toMatchObject({ returns_summary_matches_terms: false, source: 'rules-fallback' })
    expect(await createSparkReader('k', ok('I think it is fine')).readReturns(IN)).toMatchObject({ source: 'rules-fallback' })
    expect(await createSparkReader('k', (async () => { throw new Error('net') }) as unknown as typeof fetch).readReturns({ ...IN, agent_summary_returns: 'See you soon', agent_believed_terms: null })).toMatchObject({ returns_summary_matches_terms: null, source: 'rules-fallback' })
  })

  it('delivery: exact labels are read by code; only a loose phrase goes to Spark, which returns a date', async () => {
    let calls = 0
    const f = (async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: '{"claimed_date": "2026-10-30"}' } }] }), { status: 200 }) }) as unknown as typeof fetch
    const sp = createSparkReader('key', f)
    expect(await sp.readDelivery('Wed Oct 28', '2026-10-26')).toEqual({ claimed_date: '2026-10-28', source: 'rules-fallback' })
    expect(calls).toBe(0)
    expect(await sp.readDelivery('by this Friday', '2026-10-26')).toEqual({ claimed_date: '2026-10-30', source: 'muse-spark' })
    expect(calls).toBe(1)
    expect(await createSparkReader(undefined).readDelivery('by this Friday', '2026-10-26')).toEqual({ claimed_date: null, source: 'rules-fallback' })
  })
})

describe('auditor privacy boundary (static)', () => {
  it('the input builder never touches the chat, the chat hash or proposal free text', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('supabase/functions/_shared/audit-input.ts', 'utf8').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/private_chat|messages|transcript|grant_json|reasoning|steps/i)
    const run = readFileSync('supabase/functions/auditor/run.ts', 'utf8').replace(/\/\/.*$/gm, '')
    expect(run).not.toMatch(/private_chat|\.messages|transcript|grant_json|reasoning/i)
    expect(readFileSync('supabase/functions/auditor/spark.ts', 'utf8')).not.toMatch(/from ['"]\.\.\/shopper-agent/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Multilingual Auditor Comparison (Returns field). A SCRIPTED Spark endpoint answers with the human-read meaning of each
// fixture summary, so these tests prove the full code path (what is sent, how the answer is read, how code decides).
// They do not prove what live Muse Spark answers: that needs MODEL_API_KEY and is not run here.
type Scripted = { calls: { system: string; user: Record<string, unknown> }[]; fetch: typeof fetch }
function scriptedSpark(extra: Record<string, unknown> = {}, reason = 'Scripted reading of the summary.'): Scripted {
  const meaning = new Map<string, string>([...ML_CASES.map((c) => [c.summary, c.meaning] as const), ...UNSPECIFIED_CASES.map((c) => [c.summary, 'match'] as const)])
  const calls: Scripted['calls'] = []
  const f = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] }
    const user = JSON.parse(body.messages[1].content) as Record<string, unknown>
    calls.push({ system: body.messages[0].content, user })
    const m = meaning.get(String(user.agent_summary_returns)) ?? 'cannot_determine'
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ returns_comparison: m, reason, ...extra }) } }] }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetch: f }
}
const checkOf = (w: ReturnType<typeof world>, key: string, i = 0) =>
  ((w.tables.receipts[i].audit as { checks: { key: string; result: string; grant: string | null; cause: string | null }[] }).checks).find((c) => c.key === key)!
const auditOf = (w: ReturnType<typeof world>, i = 0) => w.tables.receipts[i].audit as { decision: string; problems: number; problem_fields: string[]; merchant_action: string; agent_summary: Record<string, unknown> }
const productFor = (formal: string) => (formal === FINAL_SALE ? { id: BURTON, ship: 'expedited' as const } : { id: ORCA, ship: 'standard' as const })

describe('multilingual Returns comparison: prompt and Spark input', () => {
  it('the Returns prompt carries the hardening wording exactly and asks for Match / Mismatch / Cannot determine', () => {
    expect(RETURNS_HARDENING).toBe('Compare meaning across languages, not keywords. Do not translate formal terms. Do not assume a summary means the same as formal terms because it shares a word, a root, or a cognate. If the summary does not state a return term clearly in its own language, return Cannot determine.')
    expect(RETURNS_SYSTEM).toContain(RETURNS_HARDENING)
    expect(RETURNS_SYSTEM).toContain('"returns_comparison": "match" | "mismatch" | "cannot_determine"')
    expect(RETURNS_SYSTEM).toMatch(/reason in English/)
  })

  it('Spark is sent only the summary as presented and the English formal terms, untranslated', async () => {
    const sp = scriptedSpark()
    const w = world()
    await placeOrder(w, { ...productFor(FREE_30), said: mlCase('hi-match').summary }, createSparkReader('key', sp.fetch))
    const returnsCalls = sp.calls.filter((c) => c.system.includes('returns_comparison'))
    expect(returnsCalls).toHaveLength(1)
    expect(returnsCalls[0].user).toEqual({ agent_summary_returns: mlCase('hi-match').summary, formal_terms_text: FREE_30 })
    expect(returnsCalls[0].system).toContain(RETURNS_HARDENING)
  })
})

describe('multilingual Returns comparison: English control, Spanish, Hindi (scripted Spark)', () => {
  const rows: [string, string, string][] = [
    // id, expected Returns result, expected decision
    ['en-match', 'match', 'pass'],
    ['en-mismatch-burton', 'mismatch', 'review_required'],
    ['es-match', 'match', 'pass'],
    ['es-mismatch', 'mismatch', 'review_required'],
    ['hi-match', 'match', 'pass'],
    ['hi-mismatch', 'mismatch', 'review_required'],
    ['contrast-es-keyword-fails', 'match', 'pass'],
    ['contrast-hinglish-false-match', 'mismatch', 'review_required'],
  ]
  for (const [id, result, decision] of rows) {
    it(`${id}: "${mlCase(id).summary}" vs "${mlCase(id).formal}" -> ${result}, ${decision}`, async () => {
      const c = mlCase(id)
      const w = world()
      await placeOrder(w, { ...productFor(c.formal), said: c.summary }, createSparkReader('key', scriptedSpark().fetch))
      expect(checkOf(w, 'returns').result).toBe(result)
      expect(auditOf(w).decision).toBe(decision)
      expect(auditOf(w).agent_summary.returns_comparison).toBe(c.meaning)
      if (c.formal === FREE_30) expect(auditOf(w).problem_fields).toEqual(result === 'mismatch' ? ['Returns'] : [])
    })
  }

  it('English control without a model key (keyword reading) is unchanged: Free returns matches, Easy returns vs Final Sale mismatches', async () => {
    const w = world()
    await placeOrder(w, { id: ORCA, ship: 'standard', said: 'Free returns' }, createSparkReader(undefined))
    await placeOrder(w, { id: BURTON, ship: 'expedited', said: 'Easy returns' }, createSparkReader(undefined))
    expect(checkOf(w, 'returns', 0).result).toBe('match')
    expect(auditOf(w, 0).decision).toBe('pass')
    expect(checkOf(w, 'returns', 1).result).toBe('mismatch')
    expect(auditOf(w, 1)).toMatchObject({ decision: 'review_required', problems: 2, problem_fields: ['Budget', 'Returns'] })
  })
})

describe('multilingual Returns comparison: unspecified stays unspecified', () => {
  for (const u of UNSPECIFIED_CASES) {
    it(`${u.id}: "${u.summary}" with no colour, size or return requirement in the grant -> all three unspecified, Spark not asked`, async () => {
      const sp = scriptedSpark({ colour_preference: 'verde', size_cm: 170, return_policy_required: true })
      const w = world()
      await placeOrder(w, { id: ORCA, ship: 'standard', said: u.summary }, createSparkReader('key', sp.fetch), true, { colour_preference: null, size_min_cm: null, size_max_cm: null, return_policy_required: null })
      for (const key of ['colour', 'size', 'returns']) {
        expect(checkOf(w, key)).toMatchObject({ result: 'unspecified', grant: null, cause: null })
      }
      expect(sp.calls.filter((c) => c.system.includes('returns_comparison'))).toHaveLength(0)
      const g = w.tables.grants[0]
      expect([g.colour_preference, g.size_min_cm, g.size_max_cm, g.return_policy_required]).toEqual([null, null, null, null])
      expect(auditOf(w).decision).toBe('pass')
    })
  }

  it('a value Spark adds for a field the input left unspecified is dropped (colour, size), never recorded', async () => {
    const sp = scriptedSpark({ colour_preference: 'verde', colour: 'verde', size_cm: 170 })
    const w = world()
    await placeOrder(w, { id: ORCA, ship: 'standard', said: UNSPECIFIED_CASES[0].summary }, createSparkReader('key', sp.fetch), true, { colour_preference: null, size_min_cm: null, size_max_cm: null })
    expect(sp.calls.filter((c) => c.system.includes('returns_comparison'))).toHaveLength(1) // returns required here, so Spark compared Returns
    expect(checkOf(w, 'colour')).toMatchObject({ result: 'unspecified', grant: null })
    expect(checkOf(w, 'size')).toMatchObject({ result: 'unspecified', grant: null })
    expect(checkOf(w, 'returns').result).toBe('match')
    const stored = JSON.stringify([w.tables.receipts, w.tables.grants])
    expect(stored).not.toMatch(/verde|170/)
  })

  it('readComparison takes only the comparison: extra fields are ignored', () => {
    expect(readComparison({ returns_comparison: 'Cannot determine', colour: 'rojo', size_cm: 156 })).toBe('cannot_determine')
    expect(readComparison({ returns_comparison: 'MATCH' })).toBe('match')
    expect(readComparison({ returns_comparison: 'probably' })).toBeNull()
    expect(readComparison({ colour: 'rojo' })).toBeNull()
  })
})

describe('multilingual Returns comparison: Cannot determine', () => {
  for (const id of ['es-cannot', 'hi-cannot']) {
    it(`${id}: "${mlCase(id).summary}" -> Cannot determine, recorded for the merchant, verdict decided by the other checks (Pass)`, async () => {
      const w = world()
      await placeOrder(w, { id: ORCA, ship: 'standard', said: mlCase(id).summary }, createSparkReader('key', scriptedSpark().fetch))
      expect(checkOf(w, 'returns')).toMatchObject({ result: 'cannot_determine', cause: RETURNS_CANNOT_DETERMINE })
      expect(auditOf(w)).toMatchObject({ decision: 'pass', problems: 0, problem_fields: [] })
      expect(auditOf(w).agent_summary).toMatchObject({ returns_comparison: 'cannot_determine', returns_summary_matches_terms: null })
      expect(auditOf(w).merchant_action).toMatch(/Returns field/)
      expect(w.attention()).toBe(0)
    })
  }

  it('against Final Sale terms the grant-vs-terms mismatch still stands; the summary is not blamed', async () => {
    const w = world()
    await placeOrder(w, { id: BURTON, ship: 'expedited', said: mlCase('hi-cannot').summary }, createSparkReader('key', scriptedSpark().fetch))
    expect(checkOf(w, 'returns')).toMatchObject({ result: 'mismatch', cause: 'Grant requires returnable; formal terms are "Final Sale"' })
  })
})

describe('multilingual Returns comparison: keyword contrast (documented)', () => {
  it('the plain keyword reading fails or falsely matches where the meaning is clear', () => {
    for (const c of ML_CASES) expect([c.id, kindOfText(c.summary)]).toEqual([c.id, c.keyword])
    // keyword fails: no English "return" in a Spanish summary that means free returns
    expect(kindOfText(mlCase('contrast-es-keyword-fails').summary)).toBeNull()
    // keyword falsely matches: Hinglish "return nahi hoga" (no return) reads as returnable
    expect(kindOfText(mlCase('contrast-hinglish-false-match').summary)).toBe('returnable')
  })

  it('without Spark, the fallback says Cannot determine for non-English or negated summaries, never a guessed match', async () => {
    const noKey = createSparkReader(undefined)
    for (const id of ['es-match', 'es-mismatch', 'hi-match', 'hi-mismatch', 'contrast-es-keyword-fails', 'contrast-hinglish-false-match', 'es-cannot', 'hi-cannot']) {
      const c = mlCase(id)
      const r = await noKey.readReturns({ agent_summary_returns: c.summary, agent_believed_terms: c.summary, formal_returns: 'free', formal_terms_text: c.formal })
      expect([id, r.returns_comparison, r.source]).toEqual([id, 'cannot_determine', 'rules-fallback'])
    }
    expect((await noKey.readReturns({ agent_summary_returns: 'Returns not accepted', agent_believed_terms: null, formal_returns: 'free', formal_terms_text: FREE_30 })).returns_comparison).toBe('cannot_determine')
    expect((await noKey.readReturns({ agent_summary_returns: 'Free returns, no questions asked', agent_believed_terms: null, formal_returns: 'free', formal_terms_text: FREE_30 })).returns_comparison).toBe('match')
  })
})

describe('multilingual Returns comparison: the reason adds no facts', () => {
  const input = { agent_summary_returns: 'Devolución gratuita dentro de 30 días', formal_terms_text: FREE_30 }
  it('keeps a reason built from the two fields, rejects one with an invented number or hash', () => {
    expect(cleanReason('Both say the item can be returned free within 30 days.', input, 'match')).toBe('Both say the item can be returned free within 30 days.')
    expect(cleanReason('Free returns for 45 days.', input, 'match')).toBe('Muse Spark read the summary as meaning the same as the formal terms.')
    expect(cleanReason('Matches receipt sha256:abc.', input, 'match')).toBe('Muse Spark read the summary as meaning the same as the formal terms.')
    expect(cleanReason('', input, 'cannot_determine')).toBe(CANNOT_DETERMINE_REASON)
  })
})

// Verdict eval runner for Agent Proceed's verifying agent (the auditor).
//   npm run eval:verdict
// For every labeled case in evals/verdict_cases.json it builds that order's records (session, grant, proposal, checkout
// action) in an in-memory database, chains them with the product's own appendChained, and calls the REAL auditor
// (runAuditor -> auditInputFromRecords -> audit). Nothing here decides a verdict: the runner records what the auditor
// returns. Returns wording is read by the auditor's own rules reader (createSparkReader(null): keyword rules, no model
// call), so every run gives the same result. Receipt integrity is checked with the product's verifyOrderChain on the
// order's full chain, including the receipt the auditor sealed.
// Writes evals/verdict_eval_results.md and prints the headline numbers.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runAuditor, type AuditorDb } from '../supabase/functions/auditor/run'
import { appendChained, type ChainDb } from '../supabase/functions/auditor/chain'
import { createSparkReader } from '../supabase/functions/auditor/spark'
import { DECISION_LABEL, type Decision } from '../supabase/functions/auditor/audit'
import { verifyOrderChain, type ChainRecord } from '../src/shared/chain'

type Row = Record<string, unknown>
type Product = {
  name: string; brand: string; category: string; size_cm: number | null; colour: string | null; price_cents: number
  formal_returns: string; formal_terms_text: string; standard_shipping_cents: number; standard_delivery_days: number
  expedited_shipping_cents: number | null; expedited_delivery_days: number | null
}
export type EvalCase = {
  id: string
  expected: Decision
  reason: string
  shopper: {
    merchant: string; product?: string; budget_dollars?: number; size_min_cm?: number; size_max_cm?: number
    colour?: string; delivery_by?: string; returns_required?: boolean
  }
  order: { product_id: string; sold_by: string; shipping: 'standard' | 'expedited'; agent_returns_summary: string | null; shown_delivery?: string }
  tamper?: { record: 'action'; field: 'detail.total_cents'; new_value: number }
}
type CaseFile = { catalog: Record<string, Product>; cases: EvalCase[] }

export type CaseResult = {
  id: string; expected: Decision; actual: Decision; correct: boolean; reason: string
  problem_fields: string[]; suspicion_reasons: string[]; chain_ok: boolean; chain_problem: string | null
}

const MERCHANT_ID = '32b14be6-26e6-49df-a7af-79532f910510' // Northwind Outfitters
const NOW = new Date('2026-10-26T18:00:00.000Z')
const TODAY = '2026-10-26'
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10)

// One order, through the real auditor. Returns the verdict it issued and the order's chain check.
async function runCase(c: EvalCase, catalog: Record<string, Product>, idx: number): Promise<CaseResult> {
  const p = catalog[c.order.product_id]
  if (!p) throw new Error(`${c.id}: product ${c.order.product_id} is not in the catalog`)
  let n = 0
  const id = () => `00000000-0000-4000-a${String(idx).padStart(3, '0')}-${String(++n).padStart(12, '0')}`

  // An in-memory database playing Postgres: it assigns chain_seq and created_at, like the real tables.
  const tables: Record<string, Row[]> = { sessions: [], grants: [], proposals: [], actions: [], receipts: [] }
  let seq = 0
  const chained = ['grants', 'proposals', 'actions', 'receipts'] as const
  const chainRows = () => chained.flatMap((t) => tables[t]).sort((a, b) => (a.chain_seq as number) - (b.chain_seq as number))
  const chainDb: ChainDb = {
    latestHash: async () => (chainRows().at(-1)?.entry_hash as string | undefined) ?? null,
    insert: async (table, row) => { seq += 1; tables[table].push({ ...row, chain_seq: seq, created_at: NOW.toISOString() }) },
  }
  const db: AuditorDb = {
    ...chainDb,
    sessionExists: async (sid) => tables.sessions.some((s) => s.id === sid),
    grantForSession: async (sid) => tables.grants.find((g) => g.session_id === sid) ?? null,
    proposalForGrant: async (gid) => tables.proposals.find((x) => x.grant_id === gid) ?? null,
    checkoutForGrant: async (gid) => tables.actions.find((a) => a.grant_id === gid && a.type === 'checkout') ?? null,
    // The seller of the item the agent actually bought (the order's merchant).
    product: async (pid) => (pid === c.order.product_id ? { category: p.category, formal_returns: p.formal_returns, formal_terms_text: p.formal_terms_text, merchant_name: c.order.sold_by, row: { ...p } } : null),
    // The merchant the shopper's grant allows.
    merchantName: async (mid) => (mid === MERCHANT_ID ? c.shopper.merchant : null),
    entryHashAt: async (s) => (chainRows().find((r) => r.chain_seq === s)?.entry_hash as string | undefined) ?? null,
    receiptForGrant: async (gid) => tables.receipts.find((r) => r.grant_id === gid) ?? null,
    refs: async () => tables.receipts.map((r) => ({ receipt_ref: r.receipt_ref as string, order_ref: (r.order_ref as string | null) ?? null })),
    logStep: async () => {},
  }

  // ----- the order's records, in the shapes the shopper agent writes -----
  const s = c.shopper
  const sessionId = id()
  tables.sessions.push({ id: sessionId, merchant_id: MERCHANT_ID })
  const cents = s.budget_dollars === undefined ? null : Math.round(s.budget_dollars * 100)
  const grantId = id()
  await appendChained(chainDb, 'grants', {
    id: grantId, session_id: sessionId, version: 1, supersedes_grant_id: null, shopper_ref: 'Demo customer', agent_id: 'eval-agent', agent_verified: true,
    merchant_id: MERCHANT_ID, product_scope: s.product ?? null, size_min_cm: s.size_min_cm ?? null, size_max_cm: s.size_max_cm ?? null,
    colour_preference: s.colour ?? null, currency: 'USD', amount_max_cents: cents, budget_limit_cents: cents, payment_method_ref: 'Demo Checkout',
    shipping_method: null, shipping_max_cost_cents: null, delivery_by: s.delivery_by ?? null, return_policy_required: s.returns_required === true ? true : null,
    confirmed_at: '2026-10-26T17:55:00.000Z', expires_at: '2026-10-27T17:55:00.000Z', private_chat_hash: `sha256:${'e'.repeat(64)}`,
    schema_label: 'VI-aligned demo representation',
  })
  const expedited = c.order.shipping === 'expedited'
  const shipping = expedited ? p.expedited_shipping_cents : p.standard_shipping_cents
  const days = expedited ? p.expedited_delivery_days : p.standard_delivery_days
  if (shipping === null || days === null) throw new Error(`${c.id}: ${p.name} has no ${c.order.shipping} shipping`)
  await appendChained(chainDb, 'proposals', {
    id: id(), grant_id: grantId, product_id: c.order.product_id, shown_item_price_cents: p.price_cents, shown_total_cents: null,
    shown_returns_summary: c.order.agent_returns_summary, shown_delivery: c.order.shown_delivery ?? null,
    shown_at: '2026-10-26T17:56:00.000Z', confirmation_ref: `PC-EVAL-${c.id}`, confirmed_at: '2026-10-26T17:57:00.000Z',
  })
  await appendChained(chainDb, 'actions', {
    id: id(), grant_id: grantId, seq: 1, type: 'checkout',
    detail: {
      product_id: c.order.product_id, product_name: p.name, brand: p.brand, colour: p.colour, size_cm: p.size_cm,
      item_price_cents: p.price_cents, shipping_method: c.order.shipping, shipping_cents: shipping, total_cents: p.price_cents + shipping,
      delivery_date: addDays(TODAY, days), payment_method: 'Demo Checkout', payment_simulated: true, sealed_at: '2026-10-26T17:58:00.000Z',
      agent_summary: { returns: c.order.agent_returns_summary },
    },
    agent_believed_terms: { returns: c.order.agent_returns_summary }, image_evidence_ref: null,
  })

  // Tamper: edit a sealed record in place, after its hash was written (what an edit in the database would look like).
  if (c.tamper) {
    const action = tables.actions[0]
    action.detail = { ...(action.detail as Row), total_cents: c.tamper.new_value }
  }

  // ----- the real auditor -----
  const reply = await runAuditor({ session_id: sessionId }, { db, reader: createSparkReader(null), now: () => NOW, newId: id, today: () => TODAY })
  if (reply.type !== 'audit') throw new Error(`${c.id}: auditor answered ${reply.message}`)

  // ----- receipt integrity: the order's full chain (grant, proposal, action, sealed receipt) -----
  const typeOf = (r: Row) => chained.find((t) => tables[t].includes(r))!.slice(0, -1) as ChainRecord['entry_type']
  const records: ChainRecord[] = chainRows().map((r) => ({ chain_seq: r.chain_seq as number, entry_type: typeOf(r), row: r as ChainRecord['row'] }))
  const chain = await verifyOrderChain(records, (x) => (chainRows().find((r) => r.chain_seq === x)?.entry_hash as string | undefined) ?? null)

  const actual = reply.audit.decision
  return {
    id: c.id, expected: c.expected, actual, correct: actual === c.expected, reason: c.reason,
    problem_fields: reply.audit.problem_fields, suspicion_reasons: reply.audit.suspicion_reasons,
    chain_ok: chain.ok, chain_problem: chain.failed?.message ?? null,
  }
}

const pct = (num: number, den: number) => (den === 0 ? 'n/a' : `${((num / den) * 100).toFixed(1)}%`)
const isBad = (d: Decision) => d !== 'pass'

export function metrics(results: { expected: Decision; actual: Decision; chain_ok: boolean }[]) {
  const bad = results.filter((r) => isBad(r.expected))
  const good = results.filter((r) => !isBad(r.expected))
  const missed = bad.filter((r) => r.actual === 'pass').length
  const caught = bad.filter((r) => r.actual !== 'pass').length
  const falseHolds = good.filter((r) => r.actual !== 'pass').length
  const correct = results.filter((r) => r.actual === r.expected).length
  const verified = results.filter((r) => r.chain_ok).length
  return {
    total: results.length, bad: bad.length, good: good.length, missed, caught, falseHolds, correct, verified,
    missRate: pct(missed, bad.length), falseHoldRate: pct(falseHolds, good.length), accuracy: pct(correct, results.length),
    chargebacksPrevented: pct(caught, bad.length), receiptIntegrity: pct(verified, results.length),
  }
}

function report(results: CaseResult[]): string {
  const m = metrics(results)
  // Baseline: no verification. Every order gets Pass, so no receipt is sealed and nothing is checked.
  const base = metrics(results.map((r) => ({ expected: r.expected, actual: 'pass' as Decision, chain_ok: false })))
  const wrong = results.filter((r) => !r.correct)
  const L = (d: Decision) => DECISION_LABEL[d]
  const lines: string[] = []
  lines.push('# Verdict eval: Agent Proceed verifying agent')
  lines.push('')
  lines.push('Generated by `npm run eval:verdict` (`scripts/run-verdict-eval.ts`) from `evals/verdict_cases.json`. Do not edit by hand: rerun the eval.')
  lines.push('')
  lines.push('## Method')
  lines.push('')
  lines.push(`- **Labeled cases (${m.total}).** Each case is one agent order at Northwind Outfitters, built from the live catalog (9 products): what the shopper specified, what the agent actually ordered, and the expected verdict, labeled from the rules before running. ${m.good} should Pass; ${m.bad} are bad orders (${results.filter((r) => r.expected === 'review_required').length} Review Required, ${results.filter((r) => r.expected === 'hold_suspicion').length} Hold for Suspicion).`)
  lines.push('- **Labeling rules.** Only consumer-specified parameters count; an unspecified field is skipped, never a mismatch. Budget (order total), merchant and returns are decision-grade: a mismatch that is not clearly fraud is Review Required. Clearly wrong or suspicious orders (far over budget, wrong category, unknown merchant, a record that does not verify) are Hold for Suspicion.')
  lines.push('- **System under test.** The real auditor, unchanged: `runAuditor` → `auditInputFromRecords` → `audit` (`supabase/functions/auditor/`). Each case\'s session, grant, proposal and checkout action are chained with the product\'s `appendChained` in an in-memory database, and the auditor seals its receipt into that chain. Returns wording is read by the auditor\'s own rules reader (`createSparkReader(null)`, keyword rules, no model call), so runs are deterministic. The production Muse Spark reader is not exercised here.')
  lines.push('- **Receipt integrity.** Each order\'s full chain (grant, proposal, action and the sealed receipt) is checked with the product\'s `verifyOrderChain`: every hash recomputed from the record\'s fields, every link checked.')
  lines.push('- **Baseline.** No verification: every order gets Pass and no receipt is sealed.')
  lines.push('- **Metrics.** Miss rate = bad orders that got Pass ÷ bad orders. False-hold rate = good orders that got Review Required or Hold ÷ good orders. Accuracy = correct verdicts ÷ cases. Chargebacks prevented = bad orders that got Review Required or Hold ÷ bad orders (caught before shipping). Receipt integrity = cases whose chain verifies ÷ cases.')
  lines.push('')
  lines.push('## Results')
  lines.push('')
  lines.push('| Metric | Agent Proceed verdict | Baseline (no verification) |')
  lines.push('|---|---|---|')
  lines.push(`| Miss rate | **${m.missRate}** (${m.missed}/${m.bad}) | ${base.missRate} (${base.missed}/${base.bad}) |`)
  lines.push(`| Chargebacks prevented | **${m.chargebacksPrevented}** (${m.caught}/${m.bad}) | ${base.chargebacksPrevented} (${base.caught}/${base.bad}) |`)
  lines.push(`| False-hold rate | **${m.falseHoldRate}** (${m.falseHolds}/${m.good}) | ${base.falseHoldRate} (${base.falseHolds}/${base.good}) |`)
  lines.push(`| Accuracy (exact verdict) | **${m.accuracy}** (${m.correct}/${m.total}) | ${base.accuracy} (${base.correct}/${base.total}) |`)
  lines.push(`| Receipt integrity (chain verifies) | **${m.receiptIntegrity}** (${m.verified}/${m.total}) | no receipt |`)
  lines.push('')
  lines.push('## Cases')
  lines.push('')
  lines.push('| ID | Expected | Actual | Result | Fields the auditor flagged | Chain verifies | Case |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const r of results) {
    const flagged = [...r.problem_fields, ...r.suspicion_reasons].join('; ') || '—'
    lines.push(`| ${r.id} | ${L(r.expected)} | ${L(r.actual)} | ${r.correct ? 'correct' : '**incorrect**'} | ${flagged} | ${r.chain_ok ? 'yes' : `no: ${r.chain_problem}`} | ${r.reason} |`)
  }
  lines.push('')
  lines.push('## Findings')
  lines.push('')
  if (wrong.length === 0) lines.push('Every case returned its expected verdict.')
  else {
    lines.push(`${wrong.length} case(s) returned a verdict different from the label. These are reported as returned; the verdict logic was not changed.`)
    lines.push('')
    for (const r of wrong) lines.push(`- **${r.id}**: expected ${L(r.expected)}, got **${L(r.actual)}**. ${r.reason} Auditor flagged: ${[...r.problem_fields, ...r.suspicion_reasons].join('; ') || 'nothing'}.`)
    const softHolds = wrong.filter((r) => r.expected === 'hold_suspicion' && r.actual === 'review_required')
    if (softHolds.length) {
      lines.push('')
      lines.push(`Pattern: ${softHolds.map((r) => r.id).join(', ')} are suspicious orders that the auditor caught but rated Review Required, not Hold for Suspicion. In \`audit()\`, Hold for Suspicion means "the record itself is not trusted" (hash failure, missing component, expired grant, unverified agent); a field mismatch of any size (budget, category, merchant) is Review Required. Every one of these orders is still stopped before shipping, so it counts as a chargeback prevented and not as a miss; only the severity differs from the label.`)
    }
  }
  lines.push('')
  lines.push('## Not covered')
  lines.push('')
  lines.push('- Multiple items when one was requested: a checkout action records exactly one product, so the order model cannot express it.')
  lines.push('- The Muse Spark returns reader (production) and other languages: covered by the unit tests in `src/test/auditor.test.ts`, not by this eval.')
  lines.push('- Specified non-decision attributes (colour, size, delivery) that mismatch: their label is ambiguous under the rules above, so no case relies on one. P2 specifies size and delivery and matches both.')
  lines.push('')
  return lines.join('\n')
}

export async function runEval(file = new URL('../evals/verdict_cases.json', import.meta.url)) {
  const data = JSON.parse(readFileSync(file, 'utf8')) as CaseFile
  const results: CaseResult[] = []
  for (const [i, c] of data.cases.entries()) results.push(await runCase(c, data.catalog, i + 1))
  return results
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await runEval()
  writeFileSync(new URL('../evals/verdict_eval_results.md', import.meta.url), report(results))
  const m = metrics(results)
  const base = metrics(results.map((r) => ({ expected: r.expected, actual: 'pass' as Decision, chain_ok: false })))
  console.log(`Verdict eval: ${m.total} labeled cases (${m.good} good, ${m.bad} bad)`)
  for (const r of results) console.log(`  ${r.correct ? 'ok   ' : 'WRONG'} ${r.id.padEnd(3)} expected ${DECISION_LABEL[r.expected].padEnd(18)} actual ${DECISION_LABEL[r.actual].padEnd(18)} chain ${r.chain_ok ? 'verifies' : 'FAILS'}`)
  console.log('')
  console.log(`  Miss rate              ${m.missRate.padStart(6)}  (baseline ${base.missRate})`)
  console.log(`  False-hold rate        ${m.falseHoldRate.padStart(6)}  (baseline ${base.falseHoldRate})`)
  console.log(`  Chargebacks prevented  ${m.chargebacksPrevented.padStart(6)}  (baseline ${base.chargebacksPrevented})`)
  console.log(`  Accuracy               ${m.accuracy.padStart(6)}  (baseline ${base.accuracy})`)
  console.log(`  Receipt integrity      ${m.receiptIntegrity.padStart(6)}`)
  const wrong = results.filter((r) => !r.correct)
  if (wrong.length) {
    console.log('')
    console.log('Unexpected verdicts:')
    for (const r of wrong) console.log(`  ${r.id}: expected ${DECISION_LABEL[r.expected]}, got ${DECISION_LABEL[r.actual]}`)
  }
  console.log('\nWrote evals/verdict_eval_results.md')
}

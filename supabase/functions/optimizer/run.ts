// Listing Optimizer: scan, re-scan and merchant decisions. Runs in the `optimizer` edge function.
// It reads one merchant's listings and the store page markup, and writes only its own two
// tables (optimizer_scans, optimizer_suggestions). It has no way to write a product, price, term or page: the OptimizerDb
// interface below has no such method. Approval records a decision; the merchant applies the fix in their own store.
import {
  checkListing, severityOf,
  type Flag, type ListingResult, type MarkupScan, type Row, type Semantic,
} from './checks.ts'
import { deconstructKey, fallback, type ListingReader } from './spark.ts'
import { isoDateIn, pending, reuseReadTest, runReadTest, unavailable, type AgentReader, type ReadTest } from './readtest.ts'

export type Status = 'pending' | 'approved' | 'rejected' | 'resolved' | 'still_flagged'

export interface SuggestionRow {
  id: string
  merchant_id: string
  product_id: string
  flag_key: string
  pillar: number
  flag_type: string
  subtype: string
  category: number
  severity: string
  title: string
  evidence: string[]
  impact: string
  suggested_fix: string
  merchant_fix_text: string | null
  value_fields: string[]
  merchant_values: Record<string, string>
  source: string
  status: Status
  decided_by: string | null
  decided_at: string | null
  first_scan_id: string
  last_scan_id: string
  rescan_result: string | null
  rescan_at: string | null
  resolved_at: string | null
}

export interface OptimizerDb {
  merchant(id: string): Promise<{ id: string; name: string } | null>
  products(merchantId: string): Promise<Row[]>
  suggestions(merchantId: string): Promise<SuggestionRow[]>
  insertSuggestions(rows: SuggestionRow[]): Promise<void>
  updateSuggestion(merchantId: string, id: string, patch: Partial<SuggestionRow>): Promise<void>
  insertScan(row: Record<string, unknown>): Promise<void>
  // Optional: the last scan's stored results (to reuse Spark answers for unchanged listings) and a way to fill in
  // read-tests that finish after the scan has replied.
  latestScan?(merchantId: string): Promise<{ id: string; results: unknown } | null>
  updateScanResults?(merchantId: string, id: string, results: unknown[]): Promise<void>
}

export interface Deps {
  db: OptimizerDb
  reader: ListingReader
  agent: AgentReader // Agent Read-Test: its own blind Spark call (readtest.ts), never shown the formal terms
  fetchMarkup: () => Promise<MarkupScan>
  now: () => Date
  newId: () => string
  // Keeps work running after the reply is sent (EdgeRuntime.waitUntil). Without it, the read-tests are awaited in the scan.
  inBackground?: (p: Promise<unknown>) => void
}

export type Reply =
  | { type: 'error'; message: string }
  | { type: 'scan'; scan_id: string; listings_scanned: number; flags: number; resolved: number; still_flagged: number; markup_status: string; spark: Record<string, number>; read_test: Record<string, number> }
  | { type: 'decision'; suggestion_id: string; status: Status }
  | { type: 'approve_all'; approved: number; skipped_unfilled: number; skipped_not_pending: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const err = (message: string): Reply => ({ type: 'error', message })
const decidedBy = (name: string) => `${name} (demo merchant sign-in)`

// Flags whose check depends on something this scan could not run are left as they were, never marked resolved.
function notRechecked(s: SuggestionRow, markup: MarkupScan, semantic: Semantic | undefined): string | null {
  if ((s.flag_key.startsWith('p3.') || s.flag_key === 'p1.stale_price') && markup.status !== 'fetched') {
    return `Not re-checked: the store page markup could not be read on this scan (${markup.error ?? markup.status}).`
  }
  if (s.source === 'muse-spark' && semantic?.source !== 'muse-spark') {
    return 'Not re-checked: this flag came from Muse Spark and Spark was unavailable on this scan.'
  }
  return null
}

export const filled = (s: Pick<SuggestionRow, 'value_fields' | 'merchant_values'>) =>
  s.value_fields.every((f) => typeof s.merchant_values?.[f] === 'string' && s.merchant_values[f].trim() !== '')

export async function runScan(body: Record<string, unknown>, deps: Deps): Promise<Reply> {
  const merchantId = body.merchant_id
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) return err('merchant_id is required.')
  const merchant = await deps.db.merchant(merchantId)
  if (!merchant) return err('Unknown merchant.')

  // This merchant's listings only (filtered in the query and again here).
  const rows = (await deps.db.products(merchantId)).filter((r) => r.merchant_id === merchantId)
  const today = isoDateIn(deps.now())

  // The last scan's Spark answers, by listing. A listing whose Spark input is unchanged gets the same answer again,
  // so it is reused instead of asking Spark (the slow part of a scan). A changed listing is always read fresh.
  type Stored = { product_id?: string; semantic_cache?: { key: string; value: Semantic }; read_test?: ReadTest }
  const last = await deps.db.latestScan?.(merchantId).catch(() => null) ?? null
  const before = new Map<string, Stored>()
  for (const x of (Array.isArray(last?.results) ? last!.results : []) as Stored[]) if (x?.product_id) before.set(x.product_id, x)

  const deconstruct = (r: Row): Promise<Semantic> => {
    const c = before.get(r.id)?.semantic_cache
    if (c && c.key === deconstructKey(r) && c.value?.source === 'muse-spark') return Promise.resolve(c.value)
    return deps.reader.deconstruct(r).catch(() => fallback(r, 'Spark deconstruction unavailable (call failed).'))
  }
  // Agent Read-Test runs beside the pillars and never feeds them: no flag, suggestion or pillar result depends on it.
  const readTestFor = (r: Row) => runReadTest(r, deps.agent, today).catch(() => unavailable(r, today, 'Spark read-test unavailable (call failed).'))
  const reused = rows.map((r) => reuseReadTest(before.get(r.id)?.read_test, r, today))
  const background = !!deps.inBackground && !!deps.db.updateScanResults
  // New blind reads start now. With a background runner the scan does not wait for them.
  const newReads = rows.map((r, i) => (reused[i] ? null : readTestFor(r)))

  // The store page and the Spark readings do not depend on each other: start them together.
  const [markup, semantics] = await Promise.all([deps.fetchMarkup(), Promise.all(rows.map(deconstruct))])
  const readTests: ReadTest[] = background
    ? rows.map((r, i) => reused[i] ?? pending(r, today))
    : await Promise.all(rows.map((_, i) => reused[i] ? Promise.resolve(reused[i]!) : newReads[i]!))
  const semanticBy = new Map(rows.map((r, i) => [r.id, semantics[i]]))

  const results: ListingResult[] = rows.map((r, i) =>
    checkListing(r, { merchantName: merchant.name, catalogue: rows, markup, semantic: semantics[i] }))
  const readTest: Record<string, number> = {}
  for (const t of readTests) readTest[t.source] = (readTest[t.source] ?? 0) + 1

  const stored = (tests: ReadTest[]) => results.map(({ flags, ...rest }, i) => ({
    ...rest, flag_keys: flags.map((f) => f.key), read_test: tests[i],
    ...(semantics[i].source === 'muse-spark' ? { semantic_cache: { key: deconstructKey(rows[i]), value: semantics[i] } } : {}),
  }))
  const scanId = deps.newId()
  const at = deps.now().toISOString()
  // The scan row goes in first: every suggestion written below points at it.
  const spark: Record<string, number> = {}
  for (const s of semantics) spark[s.source] = (spark[s.source] ?? 0) + 1
  await deps.db.insertScan({
    id: scanId,
    merchant_id: merchantId,
    scanned_at: at,
    listings_scanned: rows.length,
    catalogue_source: 'Supabase catalogue snapshot (demo; not live Shopify sync)',
    markup: { status: markup.status, url: markup.url, http_status: markup.http_status, bytes: markup.bytes, products_found: markup.products.length, has_microdata_product: markup.has_microdata_product, has_breadcrumbs: markup.has_breadcrumbs, has_faq: markup.has_faq, error: markup.error },
    spark,
    results: stored(readTests),
  })
  if (background && newReads.some(Boolean)) {
    // The blind reads still running finish after the reply; their answers are written into this scan's row.
    deps.inBackground!(Promise.all(rows.map((_, i) => reused[i] ?? newReads[i]!))
      .then((done) => deps.db.updateScanResults!(merchantId, scanId, stored(done)))
      .catch((e) => console.error('read-test fill failed', e instanceof Error ? e.message : e)))
  }

  const existing = await deps.db.suggestions(merchantId)
  const byKey = new Map(existing.map((s) => [`${s.product_id}|${s.flag_key}`, s]))
  const fresh: SuggestionRow[] = []
  let resolved = 0
  let stillFlagged = 0
  const seen = new Set<string>()
  // Each update touches its own suggestion row, so they are sent together rather than one after another.
  const writes: Promise<unknown>[] = []

  for (const res of results) {
    for (const f of res.flags) {
      const k = `${res.product_id}|${f.key}`
      seen.add(k)
      const content = flagContent(f)
      const prev = byKey.get(k)
      if (!prev) {
        fresh.push({
          id: deps.newId(), merchant_id: merchantId, product_id: res.product_id, flag_key: f.key, ...content,
          merchant_fix_text: null, merchant_values: {}, status: 'pending', decided_by: null, decided_at: null,
          first_scan_id: scanId, last_scan_id: scanId, rescan_result: null, rescan_at: null, resolved_at: null,
        })
        continue
      }
      const patch: Partial<SuggestionRow> = { ...content, last_scan_id: scanId, rescan_at: at }
      if (prev.status === 'approved' || prev.status === 'still_flagged') {
        patch.status = 'still_flagged'
        patch.rescan_result = `Still flagged on re-scan: the deterministic check still fails. ${f.evidence[0] ?? ''}`.trim()
        stillFlagged += 1
      } else if (prev.status === 'resolved') {
        patch.status = 'pending' // it came back
        patch.resolved_at = null
        patch.rescan_result = 'Flagged again on re-scan after it had been resolved.'
      } else {
        patch.rescan_result = 'Still present on re-scan.'
      }
      writes.push(deps.db.updateSuggestion(merchantId, prev.id, patch))
    }
  }

  const scanned = new Set(rows.map((r) => r.id))
  for (const s of existing) {
    if (seen.has(`${s.product_id}|${s.flag_key}`) || s.status === 'resolved' || !scanned.has(s.product_id)) continue
    const why = notRechecked(s, markup, semanticBy.get(s.product_id))
    if (why) {
      writes.push(deps.db.updateSuggestion(merchantId, s.id, { last_scan_id: scanId, rescan_at: at, rescan_result: why }))
      continue
    }
    resolved += 1
    writes.push(deps.db.updateSuggestion(merchantId, s.id, {
      status: 'resolved', last_scan_id: scanId, rescan_at: at, resolved_at: at,
      rescan_result: `Resolved on re-scan: the deterministic check now passes (${s.title} is no longer found).`,
    }))
  }
  if (fresh.length) writes.push(deps.db.insertSuggestions(fresh))
  await Promise.all(writes)

  return {
    type: 'scan', scan_id: scanId, listings_scanned: rows.length, flags: results.reduce((n, r) => n + r.flags.length, 0),
    resolved, still_flagged: stillFlagged, markup_status: markup.status, spark, read_test: readTest,
  }
}

function flagContent(f: Flag) {
  return {
    pillar: f.pillar, flag_type: f.flag_type, subtype: f.subtype, category: f.category, severity: severityOf(f.category),
    title: f.title, evidence: f.evidence, impact: f.impact, suggested_fix: f.suggested_fix, value_fields: f.value_fields,
    source: f.source,
  }
}

function cleanValues(raw: unknown, fields: string[]): Record<string, string> | null {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!fields.includes(k)) continue // only the fields this flag asks for
    if (typeof v !== 'string' || v.length > 200) return null
    if (v.trim() !== '') out[k] = v.trim()
  }
  return out
}

export async function decide(body: Record<string, unknown>, deps: Deps): Promise<Reply> {
  const { merchant_id: merchantId, suggestion_id: id, decision } = body
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) return err('merchant_id is required.')
  if (typeof id !== 'string' || !UUID.test(id)) return err('suggestion_id is required.')
  if (decision !== 'approve' && decision !== 'reject') return err('decision must be approve or reject.')
  const merchant = await deps.db.merchant(merchantId)
  if (!merchant) return err('Unknown merchant.')
  const s = (await deps.db.suggestions(merchantId)).find((x) => x.id === id)
  if (!s) return err('Suggestion not found for this merchant.')
  const at = deps.now().toISOString()

  if (decision === 'reject') {
    if (!['pending', 'approved', 'still_flagged'].includes(s.status)) return err(`A ${s.status} suggestion cannot be rejected.`)
    await deps.db.updateSuggestion(merchantId, id, { status: 'rejected', decided_by: decidedBy(merchant.name), decided_at: at })
    return { type: 'decision', suggestion_id: id, status: 'rejected' }
  }

  if (!['pending', 'rejected'].includes(s.status)) return err(`A ${s.status} suggestion cannot be approved again.`)
  const values = cleanValues(body.values, s.value_fields)
  if (values === null) return err('values must be short text, one per field to be filled.')
  const merged = { ...s.merchant_values, ...values }
  if (!filled({ value_fields: s.value_fields, merchant_values: merged })) {
    return err(`Fill ${s.value_fields.filter((f) => !merged[f]).join(', ')} before approving. The optimizer never fills a missing value.`)
  }
  const fix = body.fix_text
  if (fix !== undefined && fix !== null && (typeof fix !== 'string' || fix.length > 4000)) return err('fix_text must be text up to 4000 characters.')
  const patch: Partial<SuggestionRow> = { status: 'approved', merchant_values: merged, decided_by: decidedBy(merchant.name), decided_at: at }
  if (typeof fix === 'string' && fix.trim() !== '' && fix.trim() !== s.suggested_fix.trim()) patch.merchant_fix_text = fix.trim()
  await deps.db.updateSuggestion(merchantId, id, patch)
  return { type: 'decision', suggestion_id: id, status: 'approved' }
}

// Approves the pending suggestions the merchant has on screen. Never applies anything; never approves an empty
// to-be-filled field (that would be inventing data by omission).
export async function approveAll(body: Record<string, unknown>, deps: Deps): Promise<Reply> {
  const { merchant_id: merchantId, suggestion_ids: ids } = body
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) return err('merchant_id is required.')
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => typeof x === 'string' && UUID.test(x))) return err('suggestion_ids must be a list of ids.')
  const merchant = await deps.db.merchant(merchantId)
  if (!merchant) return err('Unknown merchant.')
  const wanted = new Set(ids as string[])
  const mine = (await deps.db.suggestions(merchantId)).filter((s) => wanted.has(s.id))
  const at = deps.now().toISOString()
  let approved = 0
  let unfilled = 0
  for (const s of mine) {
    if (s.status !== 'pending') continue
    if (!filled(s)) { unfilled += 1; continue }
    await deps.db.updateSuggestion(merchantId, s.id, { status: 'approved', decided_by: decidedBy(merchant.name), decided_at: at })
    approved += 1
  }
  return { type: 'approve_all', approved, skipped_unfilled: unfilled, skipped_not_pending: wanted.size - approved - unfilled }
}

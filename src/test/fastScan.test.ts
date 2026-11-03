import { describe, expect, it } from 'vitest'
import { runScan } from '../../supabase/functions/optimizer/run'
import { type ListingReader } from '../../supabase/functions/optimizer/spark'
import { type AgentReader } from '../../supabase/functions/optimizer/readtest'
import { type Semantic } from '../../supabase/functions/optimizer/checks'
import { NW, scriptedAgent, world } from './optimizerFixtures'

// A Spark stand-in that counts its calls and always reads the copy the same way.
const countingReader = (calls: string[]): ListingReader => ({
  async deconstruct(row) {
    calls.push(row.id)
    return { source: 'muse-spark', returns_matches_terms: null, reason: 'Spark: compared.', deconstructed: { brand: null, product_type: null, size_cm: null, colour: null, price: null, shipping: null, returns_claim: null, terms: null } } as Semantic
  },
})
const countingAgent = (calls: string[]): AgentReader => {
  const inner = scriptedAgent()
  return { read: (input) => { calls.push(input.listing.title); return inner.read(input) } }
}
// The real store adds these two; the test world keeps them in memory.
function withScanStore(w: ReturnType<typeof world>) {
  w.deps.db.latestScan = async (m) => {
    const rows = w.tables.optimizer_scans.filter((s) => s.merchant_id === m)
    const s = rows[rows.length - 1]
    return s ? { id: s.id as string, results: s.results } : null
  }
  w.deps.db.updateScanResults = async (m, id, results) => {
    const s = w.tables.optimizer_scans.find((x) => x.id === id && x.merchant_id === m)!
    s.results = results
  }
  return w
}
type StoredListing = { product_id: string; read_test: { source: string; questions: unknown[] }; semantic_cache?: unknown }
const results = (w: ReturnType<typeof world>, i: number) => w.tables.optimizer_scans[i].results as StoredListing[]

describe('Faster scan: reuse Spark answers for unchanged listings', () => {
  it('a second scan of an unchanged catalogue asks Spark nothing and gives the same flags', async () => {
    const reads: string[] = []; const blind: string[] = []
    const w = withScanStore(world({ reader: countingReader(reads), agent: countingAgent(blind) }))
    const first = await runScan({ merchant_id: NW }, w.deps)
    expect(reads).toHaveLength(9); expect(blind).toHaveLength(9)
    const second = await runScan({ merchant_id: NW }, w.deps)
    expect(reads).toHaveLength(9); expect(blind).toHaveLength(9) // no new calls
    expect(second).toMatchObject({ flags: (first as { flags: number }).flags, spark: { 'muse-spark': 9 }, read_test: { 'muse-spark': 9 } })
    expect(results(w, 1).map((x) => x.read_test.questions.length)).toEqual(results(w, 0).map((x) => x.read_test.questions.length))
  })

  it('a changed listing is read again; the others are reused', async () => {
    const reads: string[] = []; const blind: string[] = []
    const w = withScanStore(world({ reader: countingReader(reads), agent: countingAgent(blind) }))
    await runScan({ merchant_id: NW }, w.deps)
    const changed = w.products[0]
    changed.marketing_blurb = 'All-mountain board. Final sale.'
    await runScan({ merchant_id: NW }, w.deps)
    expect(reads.slice(9)).toEqual([changed.id])
    expect(blind).toHaveLength(10)
  })

  it('a rules-fallback reading is never reused (the next scan asks Spark again)', async () => {
    const w = withScanStore(world())
    await runScan({ merchant_id: NW }, w.deps)
    expect(results(w, 0).every((x) => !('semantic_cache' in x))).toBe(true)
  })

  it('a new day means a new blind read (delivery dates depend on today)', async () => {
    const blind: string[] = []
    const w = withScanStore(world({ reader: countingReader([]), agent: countingAgent(blind) }))
    await runScan({ merchant_id: NW }, w.deps)
    w.deps.now = () => new Date('2026-10-30T10:00:00Z')
    await runScan({ merchant_id: NW }, w.deps)
    expect(blind).toHaveLength(18)
  })
})

describe('Faster scan: blind read-tests finish in the background', () => {
  it('the scan replies without waiting; the read-tests are stored as running, then filled into the same scan row', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const inner = scriptedAgent()
    const slowAgent: AgentReader = { read: async (input) => { await gate; return inner.read(input) } }
    const w = withScanStore(world({ reader: countingReader([]), agent: slowAgent }))
    const bg: Promise<unknown>[] = []
    w.deps.inBackground = (p) => { bg.push(p) }
    const reply = await runScan({ merchant_id: NW }, w.deps) // would hang here if it waited for the agent
    expect(reply).toMatchObject({ type: 'scan', read_test: { pending: 9 } })
    expect(results(w, 0).every((x) => x.read_test.source === 'pending')).toBe(true)
    expect(bg).toHaveLength(1)
    release(); await bg[0]
    expect(w.tables.optimizer_scans).toHaveLength(1)
    expect(results(w, 0).every((x) => x.read_test.source === 'muse-spark' && x.read_test.questions.length === 4)).toBe(true)
  })

  it('suggestions never depend on the read-test: same flags with and without the background runner', async () => {
    const a = withScanStore(world({ reader: countingReader([]), agent: scriptedAgent() }))
    const b = withScanStore(world({ reader: countingReader([]), agent: scriptedAgent() }))
    b.deps.inBackground = () => {}
    await runScan({ merchant_id: NW }, a.deps); await runScan({ merchant_id: NW }, b.deps)
    const keys = (w: typeof a) => w.tables.optimizer_suggestions.map((s) => `${s.product_id}|${s.flag_key}|${s.status}`).sort()
    expect(keys(b)).toEqual(keys(a))
  })
})

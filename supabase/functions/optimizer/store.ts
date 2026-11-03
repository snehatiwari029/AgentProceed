// Supabase-backed OptimizerDb. Runs in the edge function with the service role (auto-injected, never in the repo).
// Every read and write is filtered by merchant_id. It reads merchants and products only (no orders, receipts, grants or
// chat). Writes touch optimizer_scans and optimizer_suggestions only.
import type { OptimizerDb, SuggestionRow } from './run.ts'
import { parseMarkup, unscannedMarkup, type MarkupScan, type Row } from './checks.ts'

// deno-lint-ignore no-explicit-any
type Db = any

function must<T>(res: { data?: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

export function createOptimizerDb(db: Db): OptimizerDb {
  return {
    async merchant(id) {
      const r = await db.from('merchants').select('id,name').eq('id', id).limit(1)
      return must<{ id: string; name: string }[]>(r, 'read merchant')?.[0] ?? null
    },
    async products(merchantId) {
      const r = await db.from('products').select('*').eq('merchant_id', merchantId).order('sort_order', { ascending: true })
      return must<Row[]>(r, 'read products') ?? []
    },
    async suggestions(merchantId) {
      const r = await db.from('optimizer_suggestions').select('*').eq('merchant_id', merchantId)
      return must<SuggestionRow[]>(r, 'read suggestions') ?? []
    },
    async insertSuggestions(rows) {
      must(await db.from('optimizer_suggestions').insert(rows), 'insert suggestions')
    },
    async updateSuggestion(merchantId, id, patch) {
      must(await db.from('optimizer_suggestions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('merchant_id', merchantId), 'update suggestion')
    },
    async insertScan(row) {
      must(await db.from('optimizer_scans').insert(row), 'insert scan')
    },
    async latestScan(merchantId) {
      const r = await db.from('optimizer_scans').select('id,results').eq('merchant_id', merchantId).order('scanned_at', { ascending: false }).limit(1)
      return must<{ id: string; results: unknown }[]>(r, 'read last scan')?.[0] ?? null
    },
    async updateScanResults(merchantId, id, results) {
      must(await db.from('optimizer_scans').update({ results }).eq('id', id).eq('merchant_id', merchantId), 'update scan results')
    },
  }
}

// Fetches the store page exactly as served (no JavaScript run) for the Schema.org check.
export async function fetchStoreMarkup(url: string | undefined, fetchFn: typeof fetch = fetch): Promise<MarkupScan> {
  const target = url?.trim()
  if (!target) return unscannedMarkup('not_configured', null, 'STORE_PAGE_URL is not set in the edge function secrets.')
  if (!/^https?:\/\//i.test(target)) return unscannedMarkup('not_configured', target, 'STORE_PAGE_URL must be an http(s) URL.')
  try {
    const res = await fetchFn(target, { headers: { Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(10_000) })
    const html = (await res.text()).slice(0, 2_000_000)
    if (!res.ok) return unscannedMarkup('failed', target, `HTTP ${res.status}`, res.status)
    return parseMarkup(html, target, res.status)
  } catch (e) {
    return unscannedMarkup('failed', target, e instanceof Error ? e.message : 'fetch failed')
  }
}

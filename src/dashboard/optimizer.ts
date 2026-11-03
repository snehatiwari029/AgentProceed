import type { ListingResult } from '../../supabase/functions/optimizer/checks'
import type { Reply, SuggestionRow } from '../../supabase/functions/optimizer/run'
import type { ReadTest } from '../../supabase/functions/optimizer/readtest'

// The Optimization page writes through one place: the optimizer edge function (publishable key only, like the phone
// screen). The function records decisions in its own tables; nothing here or there writes a listing.
export type OptimizerRequest =
  | { action: 'scan'; merchant_id: string }
  | { action: 'decide'; merchant_id: string; suggestion_id: string; decision: 'approve' | 'reject'; fix_text?: string; values?: Record<string, string> }
  | { action: 'approve_all'; merchant_id: string; suggestion_ids: string[] }

export async function callOptimizer(body: OptimizerRequest): Promise<Reply> {
  const base = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!base || !key) return { type: 'error', message: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.' }
  try {
    const res = await fetch(`${base}/functions/v1/optimizer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as Reply | null
    if (json && typeof json === 'object' && 'type' in json) return json
    return { type: 'error', message: `The optimizer answered HTTP ${res.status}.` }
  } catch {
    return { type: 'error', message: 'Could not reach the optimizer. Check your connection and try again.' }
  }
}

// Rows as stored by the function (supabase/012_listing_optimizer.sql).
export type Suggestion = SuggestionRow & { created_at?: string; updated_at?: string }
// read_test is absent on scans stored before Agent Read-Test existed.
export type ScanListing = Omit<ListingResult, 'flags'> & { flag_keys: string[]; read_test?: ReadTest }
export type Scan = {
  id: string
  merchant_id: string
  scanned_at: string
  listings_scanned: number
  catalogue_source: string
  markup: { status: string; url: string | null; http_status: number | null; bytes: number; products_found: number; error: string | null }
  spark: Record<string, number>
  results: ScanListing[]
}

// Section 8 only, same rule as the function's rankFlags: category first, then pillar. No order history is used.
export function rankSuggestions<T extends Pick<Suggestion, 'category' | 'pillar'>>(list: T[]): T[] {
  return [...list].sort((a, b) => a.category - b.category || a.pillar - b.pillar)
}

// Same rule as the function's `filled`: every To-be-filled field has a saved, non-blank value. The function enforces it;
// the page uses it so Approve All's count is what it will actually approve.
export const filledIn = (s: Pick<Suggestion, 'value_fields' | 'merchant_values'>) =>
  s.value_fields.every((f) => (s.merchant_values?.[f] ?? '').trim() !== '')

export const STATUS_LABEL: Record<Suggestion['status'], string> = {
  pending: 'Open',
  approved: 'Marked as done — apply the fix in your store; the next scan checks it',
  rejected: 'Rejected',
  resolved: 'Resolved on re-scan',
  still_flagged: 'Still flagged after re-scan',
}

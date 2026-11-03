// The Listing Optimizer's own Muse Spark client (Product Feature 2). Separate from the shopper's and the auditor's.
//
// Spark does language work only, on ONE merchant listing's own fields: title, brand, marketing copy, details text and
// formal terms. It never sees customer chat, shopper reasoning, other merchants' listings, orders or grants.
//   deconstruct  marketing copy + details -> atomic fields, and: does the copy's returns claim mean the same as the terms?
// It never decides a verdict, never edits a listing, never does arithmetic and never fills a missing value: every string
// it returns must appear in the listing's own text, or it is dropped (see keepIfQuoted).
// If the call fails or there is no key, the result is a labelled `rules-fallback` (keyword reading only).
import { kindOfText, returnsLine, type Deconstructed, type Row, type Semantic } from './checks.ts'

export const META_CHAT_URL = 'https://api.meta.ai/v1/chat/completions'
export const MODEL_NAME = 'muse-spark-1.3'

export interface ListingReader {
  deconstruct(row: Row): Promise<Semantic>
}

const SYSTEM =
  'You are the AgentReceipt Listing Optimizer. You get ONE merchant listing: its title, brand, marketing copy, details text and formal terms. ' +
  'Task 1: split the marketing copy and details into atomic fields. Copy words exactly as written. If a field is not written, use null. Never guess, infer or fill in a value. ' +
  'Task 2: decide whether what the marketing copy claims about returns means the same thing as the formal terms. Compare meaning, not keywords: ' +
  '"easy returns", "free returns 30 days", "returnable" and "no-hassle returns" all claim the item can be returned; "final sale" and "no returns" claim it cannot. ' +
  'A returns claim in the marketing copy when the formal terms say final sale does NOT match. Use null if the marketing copy says nothing about returns. ' +
  'Answer with JSON only, exactly: {"deconstructed":{"brand":string|null,"product_type":string|null,"size_cm":number|null,"colour":string|null,"price":string|null,"shipping":string|null,"returns_claim":string|null,"terms":string|null},"returns_claim_matches_terms":true|false|null,"reason":"<one short sentence>"}'

// The listing fields Spark may see. Nothing else from the row is sent.
export function sparkInput(row: Row) {
  return {
    title: row.name,
    brand: row.brand ?? null,
    marketing_copy: row.marketing_blurb ?? null,
    details: row.details ?? null,
    formal_terms: row.formal_terms_text ?? null,
  }
}

// A deconstruction depends only on what Spark is sent (the listing's own fields), the model and the prompt.
// Same key = same question, so the last Spark answer can be reused instead of asking again.
export function deconstructKey(row: Row): string {
  return JSON.stringify({ model: MODEL_NAME, prompt: SYSTEM, input: sparkInput(row) })
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'null' ? v.trim() : null)

// Anti-invention guard: a value Spark returns is kept only if the listing's own text contains it.
export function keepIfQuoted(d: Record<string, unknown>, row: Row): Deconstructed {
  const source = [row.name, row.brand, row.marketing_blurb, row.details, row.formal_terms_text].filter((s) => typeof s === 'string').join(' \n ').toLowerCase()
  const quoted = (v: unknown) => { const s = str(v); return s && source.includes(s.toLowerCase()) ? s : null }
  const size = typeof d.size_cm === 'number' && Number.isFinite(d.size_cm) && source.includes(String(d.size_cm)) ? d.size_cm : null
  return {
    brand: quoted(d.brand), product_type: quoted(d.product_type), size_cm: size, colour: quoted(d.colour),
    price: quoted(d.price), shipping: quoted(d.shipping), returns_claim: quoted(d.returns_claim), terms: quoted(d.terms),
  }
}

export function fallback(row: Row, why: string): Semantic {
  const marketing = typeof row.marketing_blurb === 'string' ? row.marketing_blurb : null
  const claim = kindOfText(marketing)
  return {
    source: 'rules-fallback',
    deconstructed: null,
    returns_matches_terms: claim === null ? null : claim === (row.formal_returns === 'final_sale' ? 'final_sale' : 'returnable'),
    reason: `${why} Keyword reading only${claim ? ` (copy: ${JSON.stringify(returnsLine(marketing) ?? marketing)})` : ''}.`,
  }
}

function firstJsonObject(s: string): Record<string, unknown> | null {
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) as Record<string, unknown> } catch { return null }
}

export function createSparkListingReader(apiKey: string | undefined | null, fetchFn: typeof fetch = fetch): ListingReader {
  return {
    async deconstruct(row) {
      const key = apiKey?.trim()
      if (!key) return fallback(row, 'Spark deconstruction unavailable (no model key).')
      try {
        const res = await fetchFn(META_CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(sparkInput(row)) }] }),
        })
        if (!res.ok) return fallback(row, `Spark deconstruction unavailable (HTTP ${res.status}).`)
        const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null
        const content = json?.choices?.[0]?.message?.content
        const out = typeof content === 'string' ? firstJsonObject(content) : null
        const v = out?.returns_claim_matches_terms
        if (!out || !out.deconstructed || typeof out.deconstructed !== 'object' || !(v === true || v === false || v === null)) {
          return fallback(row, 'Spark deconstruction unavailable (unreadable answer).')
        }
        const reason = typeof out.reason === 'string' && out.reason.trim() ? out.reason.trim().slice(0, 200) : 'Muse Spark compared the marketing copy with the formal terms.'
        return { source: 'muse-spark', deconstructed: keepIfQuoted(out.deconstructed as Record<string, unknown>, row), returns_matches_terms: v, reason }
      } catch {
        return fallback(row, 'Spark deconstruction unavailable (call failed).')
      }
    },
  }
}

// Hash spec for AgentReceipt chained records. Pure TypeScript with no Deno or browser APIs except
// the standard Web Crypto `crypto.subtle`, so the same file runs in an edge function, in the browser
// (Tamper page) and in Node (seed script, tests). It is the single source of truth for hashing.
//
//   entry_hash = "sha256:" + hex( SHA-256( prev_hash + "\n" + canonicalJson(payload) ) )
//
//   payload = the stored row minus: prev_hash, entry_hash, chain_seq, created_at
//             (chain_seq and created_at are assigned by the database; the previous hash already pins order)
//
//   canonicalJson: JSON with object keys sorted at every depth, no whitespace, nulls kept, and any string
//   shaped like an ISO date-time rewritten to Date#toISOString() (so "…+00:00" and "….000Z" agree).
//   The first entry in a chain has prev_hash = GENESIS_HASH.
//
// Grants additionally carry grant_json (canonical customer-authorised fields) and are sealed by this
// same entry_hash: "grant seal = SHA-256(canonical grant fields)".

export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`

export const HASH_EXCLUDED_KEYS = ['prev_hash', 'entry_hash', 'chain_seq', 'created_at'] as const

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T/

function normalise(v: unknown): unknown {
  if (typeof v === 'string' && ISO_DATE_TIME.test(v)) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? v : d.toISOString()
  }
  if (Array.isArray(v)) return v.map(normalise)
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = normalise(src[k] === undefined ? null : src[k])
    return out
  }
  return v
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(normalise(v))
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function hashPayload(row: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if ((HASH_EXCLUDED_KEYS as readonly string[]).includes(k)) continue
    payload[k] = v
  }
  return payload
}

export async function computeEntryHash(prevHash: string, row: Record<string, unknown>): Promise<string> {
  return `sha256:${await sha256Hex(`${prevHash}\n${canonicalJson(hashPayload(row))}`)}`
}

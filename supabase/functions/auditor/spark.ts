// The auditor's own Muse Spark client. Separate from the shopper's: the auditor never imports shopper code.
//
// Spark does language work only, on STRUCTURED fields the shopper wrote to its proposal record. It never sees the
// chat, never sees proposal free text, never does arithmetic, never touches a hash and never decides the verdict.
//   Call 3  readReturns   agent_summary_returns (any language: tested in English, Spanish and Hindi) vs the English formal
//                         terms_text -> Match / Mismatch / Cannot determine, by meaning across languages (+ an English reason)
//   Call 4  readDelivery  agent_summary_delivery phrase -> an exact date (only when code cannot read the phrase itself)
// Each call has its own prompt, JSON-only output, and a labelled `rules-fallback` if the model call fails.
import { kindOfText, type ReturnsComparison, type SemanticDelivery, type SemanticReturns } from './audit.ts'

export const META_CHAT_URL = 'https://api.meta.ai/v1/chat/completions'
export const MODEL_NAME = 'muse-spark-1.3'

export interface SemanticReader {
  readReturns(input: { agent_summary_returns: string; agent_believed_terms: string | null; formal_returns: string | null; formal_terms_text: string }): Promise<SemanticReturns>
  readDelivery(phrase: string, today: string): Promise<SemanticDelivery>
}

// Spark sees exactly two fields: agent_summary_returns (in the language the agent presented it) and the English
// formal_terms_text. No believed-terms field, no grant, no chat, no other order. The formal terms are never translated.
export const RETURNS_HARDENING =
  'Compare meaning across languages, not keywords. Do not translate formal terms. Do not assume a summary means the same as formal terms because it shares a word, a root, or a cognate. ' +
  'If the summary does not state a return term clearly in its own language, return Cannot determine.'

export const RETURNS_SYSTEM =
  'You are the AgentReceipt auditor. You get two structured fields only: agent_summary_returns, the returns summary a shopping agent presented to the customer, ' +
  'in whatever language it was presented (for example English, Spanish or Hindi, in any script), and formal_terms_text, the merchant\'s formal returns terms, in English. ' +
  'Decide whether the summary means the same thing as the formal terms. ' + RETURNS_HARDENING + ' ' +
  'A summary that says the item can be returned (for example "easy returns", "free returns", "no-hassle returns", "30-day returns") means the same as returnable terms; ' +
  'a summary that says it cannot be returned (for example "final sale", "no returns") means the same as final-sale terms. ' +
  'A summary that mentions returns only to say returns are not allowed says the item cannot be returned. A claim of returns when the terms say final sale is a mismatch. ' +
  'Write the reason in English, one short sentence, based only on the two fields given. Do not add any number, date, price, hash, code or other fact that is not in the two fields. Output no other field. ' +
  'Answer with JSON only, exactly {"returns_comparison": "match" | "mismatch" | "cannot_determine", "reason": "<one short sentence in English>"}.'

const DELIVERY_SYSTEM =
  'You are the AgentReceipt auditor. Rewrite a delivery phrase as an exact calendar date. You are given the phrase and today\'s date. ' +
  'Answer with JSON only, exactly {"claimed_date": "YYYY-MM-DD" | null}. Use null if the phrase does not name a date. Do not guess a year in the past.'

// ---- plain rules used when there is no key, the call fails, or the answer is unreadable ----
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')

// Exact labels our own store writes ("Wed Oct 28", "Oct 28", "2026-10-28"). Anything looser is Spark's job.
export function parseExactDeliveryPhrase(phrase: string, today: string): string | null {
  const s = phrase.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return s
  const m = s.match(/^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})$/i)
  if (!m) return null
  const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
  const day = Number(m[2])
  if (mi < 0 || day < 1 || day > 31) return null
  const y = Number(today.slice(0, 4))
  const t = Date.parse(`${today}T00:00:00Z`)
  let cand = `${y}-${pad(mi + 1)}-${pad(day)}`
  if (Date.parse(`${cand}T00:00:00Z`) < t - 120 * 86400_000) cand = `${y + 1}-${pad(mi + 1)}-${pad(day)}`
  return Number.isNaN(Date.parse(`${cand}T00:00:00Z`)) ? null : cand
}

// The keyword reading reads plain English only. It never guesses on other scripts, and never reads "return" followed
// by a negation ("Returns not accepted", "return nahi hoga") as returnable: those are Cannot determine, not a match.
const NON_ASCII_LETTER = /[^\x00-\x7F]/
const NEGATED_RETURN = /\breturn\w*\b(?:\W+\w+){0,2}?\W+(?:not|nahi|nahin|nhi|never)\b/i

export const CANNOT_DETERMINE_REASON = 'Returns comparison cannot be determined from summary as presented — merchant review required for that field.'

function keywordKind(text: string | null): ReturnType<typeof kindOfText> {
  if (!text) return null
  const k = kindOfText(text)
  if (k === 'returnable' && (NON_ASCII_LETTER.test(text) || NEGATED_RETURN.test(text))) return null
  return k
}

function returnsFallback(i: { agent_summary_returns: string; agent_believed_terms: string | null; formal_returns: string | null }): SemanticReturns {
  const claim = keywordKind(i.agent_summary_returns) ?? keywordKind(i.agent_believed_terms)
  const formal = i.formal_returns === 'final_sale' ? 'final_sale' : i.formal_returns ? 'returnable' : null
  if (formal === null) return { returns_summary_matches_terms: null, reason: 'Keyword reading could not tell what the agent claimed.', source: 'rules-fallback' }
  if (claim === null) {
    // A summary is present but the plain English keyword reading cannot read it: never a guessed match.
    return { returns_summary_matches_terms: null, returns_comparison: 'cannot_determine', reason: CANNOT_DETERMINE_REASON, source: 'rules-fallback' }
  }
  return {
    returns_summary_matches_terms: claim === formal,
    returns_comparison: claim === formal ? 'match' : 'mismatch',
    reason: claim === formal ? 'Keyword reading: the agent\'s claim and the formal terms agree.' : 'Keyword reading: the agent\'s claim and the formal terms disagree.',
    source: 'rules-fallback',
  }
}

// Spark's answer, read strictly: only the comparison and the reason are taken; any other field (a colour, a size, a
// date) is dropped, so Spark can never put a value into a field the structured input left unspecified.
export function readComparison(out: Record<string, unknown> | null): ReturnsComparison | null {
  if (!out) return null
  const v = out.returns_comparison
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (t === 'match' || t === 'mismatch') return t
    if (t === 'cannot_determine') return 'cannot_determine'
    return null
  }
  // the earlier answer shape, still accepted
  const b = out.returns_summary_matches_terms
  return b === true ? 'match' : b === false ? 'mismatch' : null
}

// The reason may not add facts: a number, date or hash/code that is not in the two input fields is rejected, and a
// neutral reason is used instead (the comparison itself is kept).
export function cleanReason(reason: unknown, input: { agent_summary_returns: string; formal_terms_text: string }, cmp: ReturnsComparison): string {
  const fallback = cmp === 'cannot_determine' ? CANNOT_DETERMINE_REASON : cmp === 'match' ? 'Muse Spark read the summary as meaning the same as the formal terms.' : 'Muse Spark read the summary as not meaning the same as the formal terms.'
  if (typeof reason !== 'string' || !reason.trim()) return fallback
  const r = reason.trim().slice(0, 200)
  const given = `${input.agent_summary_returns} ${input.formal_terms_text}`
  const numbers = r.match(/\d+(?:[.,]\d+)?/g) ?? []
  if (numbers.some((x) => !given.includes(x))) return fallback
  if (/sha256|0x[0-9a-f]+|\b[0-9a-f]{12,}\b/i.test(r)) return fallback
  return r
}

async function ask(apiKey: string | undefined | null, fetchFn: typeof fetch, system: string, user: unknown): Promise<Record<string, unknown> | null> {
  const key = apiKey?.trim()
  if (!key) return null
  try {
    const res = await fetchFn(META_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }] }),
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') return null
    const m = content.match(/\{[^{}]*\}/)
    return m ? (JSON.parse(m[0]) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function createSparkReader(apiKey: string | undefined | null, fetchFn: typeof fetch = fetch): SemanticReader {
  return {
    async readReturns(i) {
      // Exactly two fields go to Spark: the summary as presented, and the English formal terms.
      const sent = { agent_summary_returns: i.agent_summary_returns, formal_terms_text: i.formal_terms_text }
      const out = await ask(apiKey, fetchFn, RETURNS_SYSTEM, sent)
      const cmp = readComparison(out)
      if (cmp) {
        return {
          returns_summary_matches_terms: cmp === 'match' ? true : cmp === 'mismatch' ? false : null,
          returns_comparison: cmp,
          reason: cleanReason(out?.reason, sent, cmp),
          source: 'muse-spark',
        }
      }
      // An earlier-shape null ("said nothing about returns") or an unreadable answer: the labelled keyword reading.
      return returnsFallback(i)
    },
    async readDelivery(phrase, today) {
      const exact = parseExactDeliveryPhrase(phrase, today)
      if (exact) return { claimed_date: exact, source: 'rules-fallback' } // an exact label needs no model
      const out = await ask(apiKey, fetchFn, DELIVERY_SYSTEM, { phrase, today })
      const d = out?.claimed_date
      if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return { claimed_date: d, source: 'muse-spark' }
      return { claimed_date: null, source: 'rules-fallback' }
    },
  }
}

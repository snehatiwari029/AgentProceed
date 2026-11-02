// The Dispute Agent's own Muse Spark client (Product Feature 3). Server-side only; the key is read by name from the
// environment in index.ts and never reaches the browser.
//
// Spark receives ONE disputed order's pack facts (sparkInput in pack.ts: the claim as filed, the condition as filed, and
// the labels of what the record holds and lacks). It writes two texts: a plain-language reading of the claim, and a short
// explanation of the pack. It does not lay out the pack, choose a code, decide fight / concede or liability, or predict
// an outcome. Its answer is checked by validateSparkTexts; on any failure the caller uses the template text (rules-fallback).
import type { SparkInput, TextSource, Texts } from './pack.ts'
import { validateSparkTexts } from './pack.ts'

export const META_CHAT_URL = 'https://api.meta.ai/v1/chat/completions'
export const MODEL_NAME = 'muse-spark-1.3'

export interface PackTextWriter {
  write(input: SparkInput): Promise<{ texts: Texts | null; text_source: TextSource; reason: string | null }>
}

const SYSTEM =
  'You are the Agent Proceed Dispute Agent. You get one disputed order\'s pack facts as JSON: the claim as filed, the reason code / condition as filed, ' +
  'and the labels of what the record holds ("in_record") and what is still needed ("needed"). Write two short texts for the merchant, in plain language: ' +
  '"claim_plain": one sentence saying what the customer claims, in everyday words. ' +
  '"explanation": two or three sentences saying what this pack lays out and that the needed items are listed with where to obtain them. ' +
  'Use only facts from the JSON. Do not add any number, date, amount, hash or code that is not in the JSON. ' +
  'Do not recommend fighting or conceding, do not predict an outcome, do not judge liability or fault, do not score anything. ' +
  'Answer with JSON only, exactly {"claim_plain": "...", "explanation": "..."}.'

export function createSparkTextWriter(apiKey: string | undefined | null, fetchFn: typeof fetch = fetch): PackTextWriter {
  return {
    async write(input) {
      const key = apiKey?.trim()
      if (!key) return { texts: null, text_source: 'rules-fallback', reason: 'MODEL_API_KEY not set.' }
      try {
        const res = await fetchFn(META_CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(input) }] }),
        })
        if (!res.ok) return { texts: null, text_source: 'rules-fallback', reason: `Spark answered HTTP ${res.status}.` }
        const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null
        const content = json?.choices?.[0]?.message?.content
        const m = typeof content === 'string' ? content.match(/\{[\s\S]*\}/) : null
        const parsed = m ? (JSON.parse(m[0]) as unknown) : null
        const v = validateSparkTexts(parsed, input)
        return v.ok ? { texts: v.texts, text_source: 'muse-spark', reason: null } : { texts: null, text_source: 'rules-fallback', reason: `Spark text rejected: ${v.reason}` }
      } catch {
        return { texts: null, text_source: 'rules-fallback', reason: 'Spark call failed.' }
      }
    },
  }
}

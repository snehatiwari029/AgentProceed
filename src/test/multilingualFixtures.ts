// Multilingual Auditor Comparison fixtures (Returns field only). The agent summary is in the language it was presented;
// the formal terms stay in English and are never translated.
//
// `meaning` is what the summary says about returns, read by a human (the answer Spark is expected to give by meaning).
// Tests feed it to a SCRIPTED Spark endpoint to prove the code path end to end. It is NOT a live Muse Spark result:
// a live run needs MODEL_API_KEY, which this repo and the build container do not have.
//
// `keyword` is what the plain keyword reading (kindOfText) makes of the summary, for the keyword-vs-meaning contrast.
import type { ReturnsComparison } from '../../supabase/functions/_shared/audit'

export const FREE_30 = 'Free returns within 30 days'
export const FINAL_SALE = 'Final Sale'

export type MlCase = {
  id: string
  lang: 'en' | 'es' | 'hi' | 'hi-latn'
  summary: string
  english_gloss: string
  formal: typeof FREE_30 | typeof FINAL_SALE
  meaning: ReturnsComparison
  keyword: 'final_sale' | 'returnable' | null
}

export const ML_CASES: MlCase[] = [
  // 1-2. English controls: behaviour must not change.
  { id: 'en-match', lang: 'en', summary: 'Free returns', english_gloss: 'Free returns', formal: FREE_30, meaning: 'match', keyword: 'returnable' },
  { id: 'en-mismatch-burton', lang: 'en', summary: 'Easy returns', english_gloss: 'Easy returns', formal: FINAL_SALE, meaning: 'mismatch', keyword: 'returnable' },
  // 3-4. Spanish.
  { id: 'es-match', lang: 'es', summary: 'Se puede devolver sin costo si no te convence', english_gloss: 'It can be returned at no cost if you are not convinced', formal: FREE_30, meaning: 'match', keyword: null },
  { id: 'es-mismatch', lang: 'es', summary: 'Venta final: no se aceptan devoluciones', english_gloss: 'Final sale: returns are not accepted', formal: FREE_30, meaning: 'mismatch', keyword: null },
  // 5-6. Hindi (Devanagari).
  { id: 'hi-match', lang: 'hi', summary: 'मुफ़्त वापसी — पसंद न आए तो लौटा सकते हैं', english_gloss: 'Free return — if you do not like it you can send it back', formal: FREE_30, meaning: 'match', keyword: null },
  { id: 'hi-mismatch', lang: 'hi', summary: 'यह अंतिम बिक्री है, वापसी नहीं होगी', english_gloss: 'This is a final sale, there will be no return', formal: FREE_30, meaning: 'mismatch', keyword: null },
  // 9. Cannot determine: the summary does not state a return term.
  { id: 'es-cannot', lang: 'es', summary: 'Consulta la política de la tienda', english_gloss: 'Check the store policy', formal: FREE_30, meaning: 'cannot_determine', keyword: null },
  { id: 'hi-cannot', lang: 'hi', summary: 'वापसी के बारे में विक्रेता से पूछें', english_gloss: 'Ask the seller about returns', formal: FREE_30, meaning: 'cannot_determine', keyword: null },
  // 10. Keyword contrast cases.
  //   keyword FAILS: Spanish, no English word "return" in it, means free returns.
  { id: 'contrast-es-keyword-fails', lang: 'es', summary: 'Devolución gratuita dentro de 30 días', english_gloss: 'Free return within 30 days', formal: FREE_30, meaning: 'match', keyword: null },
  //   keyword FALSELY MATCHES: Hindi in Latin script (Hinglish) that mentions "return" only to say there is none.
  { id: 'contrast-hinglish-false-match', lang: 'hi-latn', summary: 'Is board ka return nahi hoga', english_gloss: 'This board cannot be returned', formal: FREE_30, meaning: 'mismatch', keyword: 'returnable' },
]

export const mlCase = (id: string): MlCase => {
  const c = ML_CASES.find((x) => x.id === id)
  if (!c) throw new Error(`no case ${id}`)
  return c
}

// 7-8. Unspecified preservation: words in the summary suggest a colour, a size and returns, but the grant has none.
export const UNSPECIFIED_CASES = [
  { id: 'es-unspecified', lang: 'es', summary: 'Tabla roja de 156 cm, se puede devolver', english_gloss: 'Red board, 156 cm, can be returned' },
  { id: 'hi-unspecified', lang: 'hi', summary: 'लाल रंग, 156 सेमी, वापस कर सकते हैं', english_gloss: 'Red colour, 156 cm, can be returned' },
] as const

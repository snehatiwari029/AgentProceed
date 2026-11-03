// Agent Read-Test: a behavioural test, separate from the optimizer's deconstruction (spark.ts) and from the pillars.
//
// A blind Muse Spark call plays a shopping agent reading ONE listing as the shop displays it, and answers four fixed
// questions, each with a quote from that displayed listing or "Not stated in listing". Spark NEVER receives the formal
// terms, the returns enum, pillar flags, previous scans, other listings, orders or chat: the only input is
// displayedListing(row) below, plus today's date so it can turn "5 days" into a date. Spark never decides match /
// mismatch. Code (compareReadTest) compares each answer with the formal terms and catalogue attributes, reusing the
// optimizer's copy of the Order check returns reading (kindOfText / returnsConflict) and the auditor's exact matching
// rules (equal dates, equal integer cents, equal colour, equal size).
// It writes nothing: the result is stored with the scan's per-listing results (optimizer_scans.results[].read_test).
import { displayedTitle, kindOfText, money, returnsConflict, type Row } from './checks.ts'
import { META_CHAT_URL, MODEL_NAME } from './spark.ts'

export const NOT_STATED = 'Not stated in listing'
export const UNAVAILABLE_LABEL = 'Agent read-test unavailable — deterministic checks only'
export const ALL_MATCH_LINE = 'Agent read-test: agent answers match formal terms.'

export type QuestionKey = 'returns' | 'delivery' | 'cost' | 'colour_size'
export const QUESTIONS: Record<QuestionKey, string> = {
  returns: 'Can this be returned?',
  delivery: 'When will it arrive?',
  cost: 'What does it cost with shipping?',
  colour_size: 'What colour or size is it?',
}
export type ReadResult = 'match' | 'mismatch' | 'not_stated'
export const RESULT_LABEL: Record<ReadResult, string> = { match: 'Match', mismatch: 'Mismatch', not_stated: 'Agent answer not stated' }

// The listing exactly as a shopper sees it (src/shop/components/ProductCard.tsx and ProductDetails.tsx): brand line + name,
// "156cm · Serpent", the price, the marketing copy and the shipping lines. The shop also shows a returns chip and a Terms
// box; both are the formal terms, so they are withheld on purpose: the test is what an agent concludes from the rest.
export interface DisplayedListing {
  title: string
  price: string
  shipping: { standard: string; expedited: string | null }
  marketing_blurb: string | null
  product_details: string
}

// Same output as the shop's formatMoney (src/shared/format.ts): whole dollars without cents.
const shopMoney = (cents: number) => `$${cents % 100 === 0 ? (cents / 100).toLocaleString('en-US') : (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const daysLabel = (d: number) => (d === 1 ? '1 day' : `${d} days`)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

export function displayedListing(row: Row): DisplayedListing {
  const std = Number(row.standard_shipping_cents ?? 0)
  const expC = num(row.expedited_shipping_cents)
  const expD = num(row.expedited_delivery_days)
  return {
    title: displayedTitle(row),
    price: shopMoney(row.price_cents),
    shipping: {
      standard: `Standard: ${std === 0 ? 'Free' : shopMoney(std)}, ${daysLabel(Number(row.standard_delivery_days))}`,
      expedited: expC !== null && expD !== null ? `Expedited: ${shopMoney(expC)}, ${daysLabel(expD)}` : null,
    },
    marketing_blurb: text(row.marketing_blurb),
    product_details: `${row.size_cm}cm${text(row.colour) ? ` · ${text(row.colour)}` : ''}`,
  }
}

// What Spark gets: the displayed listing, today's date and the task. Nothing else.
export function readTestInput(row: Row, today: string) {
  return { today, listing: displayedListing(row) }
}

const SYSTEM =
  'You are a shopping agent reading this listing for a customer. Answer the questions below from this listing only. ' +
  'Questions: 1. Can this be returned? 2. When will it arrive? 3. What does it cost with shipping? 4. What colour or size is it? ' +
  'Answer each one the way you would tell the customer. Every answer needs a quote copied exactly from the listing that supports it. ' +
  `If the listing does not say, the answer is "${NOT_STATED}" and the quote is null. Never guess. Never use a number, date, price, colour, size or ` +
  'return term that is not in the listing; a delivery date may only be today plus the shipping days shown, and a total may only be a price plus a shipping cost shown. ' +
  'For question 3, say which shipping option you picked and why, from the options shown only. ' +
  'Answer with JSON only, exactly: {"returns":{"answer":string,"quote":string|null},' +
  '"delivery":{"answer":string,"option":"standard"|"expedited"|null,"days":number|null,"date":"YYYY-MM-DD"|null,"quote":string|null},' +
  '"cost":{"answer":string,"option":"standard"|"expedited"|null,"option_reason":string|null,"item_price":string|null,"shipping_cost":string|null,"total":string|null,"item_quote":string|null,"shipping_quote":string|null},' +
  '"colour_size":{"answer":string,"colour":string|null,"size":string|null,"quote":string|null}}'

export type Option = 'standard' | 'expedited'
export interface AgentAnswers {
  returns: { answer: string; quote: string | null }
  delivery: { answer: string; option: Option | null; days: number | null; date: string | null; quote: string | null }
  cost: { answer: string; option: Option | null; option_reason: string | null; item_price: string | null; shipping_cost: string | null; total: string | null; item_quote: string | null; shipping_quote: string | null }
  colour_size: { answer: string; colour: string | null; size: string | null; quote: string | null }
  dropped: string[] // what the anti-invention guard removed, and why
}

export interface AgentReader {
  read(input: ReturnType<typeof readTestInput>): Promise<{ ok: true; raw: Record<string, unknown> } | { ok: false; why: string }>
}

// ---------- anti-invention guard: every kept value is in the displayed listing ----------
const flat = (s: string) => s.toLowerCase().replace(/[‘’“”"']/g, '').replace(/\s+/g, ' ').trim().replace(/[.!,;:]+$/, '')
export function listingText(l: DisplayedListing): string {
  return [l.title, l.price, l.shipping.standard, l.shipping.expedited, l.marketing_blurb, l.product_details].filter(Boolean).join(' \n ')
}
const inListing = (l: DisplayedListing, s: string | null) => !!s && flat(s) !== '' && flat(listingText(l)).includes(flat(s))
const isNotStated = (s: string | null) => !s || /^not stated/i.test(s.trim())

export const parseCents = (s: string | null): number | null => {
  if (!s) return null
  if (/^\s*free\s*$/i.test(s)) return 0
  const m = s.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/)
  return m ? Math.round(Number(m[1]) * 100) : null
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
const opt = (v: unknown): Option | null => (v === 'standard' || v === 'expedited' ? v : null)
const short = (v: unknown, max = 200) => { const s = text(v); return s ? s.slice(0, max) : null }
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

// Turns Spark's raw JSON into answers the code can trust: a quote not found in the displayed listing is dropped, and
// the answer it supported becomes "Not stated in listing". Returns null if the JSON is not the shape asked for.
export function guardAnswers(raw: Record<string, unknown>, l: DisplayedListing): AgentAnswers | null {
  const r = obj(raw.returns), d = obj(raw.delivery), c = obj(raw.cost), cs = obj(raw.colour_size)
  if (!r || !d || !c || !cs) return null
  const dropped: string[] = []
  const quoted = (q: unknown, what: string) => {
    const s = short(q, 300)
    if (s && !inListing(l, s)) { dropped.push(`${what} quote ${JSON.stringify(s)} is not in the displayed listing`); return null }
    return s
  }
  const answerOf = (a: unknown, q: string | null) => { const s = short(a); return !s || isNotStated(s) || !q ? NOT_STATED : s }

  const rq = quoted(r.quote, 'Returns')
  const returns = { answer: answerOf(r.answer, rq), quote: rq }

  const dq = quoted(d.quote, 'Delivery')
  let days = num(d.days)
  if (days !== null && !(dq && new RegExp(`\\b${days}\\b`).test(dq))) { dropped.push(`Delivery days ${days} is not in the quoted listing text`); days = null }
  const date = dq && isDate(d.date) ? d.date : null
  const delivery = { answer: dq && (days !== null || date) ? answerOf(d.answer, dq) : NOT_STATED, option: opt(d.option), days: dq ? days : null, date, quote: dq }

  const iq = quoted(c.item_quote, 'Item price')
  const sq = quoted(c.shipping_quote, 'Shipping cost')
  // A price is kept only if the quoted listing text shows that same amount ("$60" and "$60.00" are the same amount).
  const amountsIn = (s: string) => [...s.matchAll(/\$\s*[\d,]+(?:\.\d{1,2})?/g)].map((m) => parseCents(m[0])).concat(/\bfree\b/i.test(s) ? [0] : [])
  const quotedAmount = (v: unknown, q: string | null, what: string) => {
    const s = short(v, 40)
    if (!s || isNotStated(s)) return null
    const cents = parseCents(s)
    if (!q || cents === null || !amountsIn(q).includes(cents)) { dropped.push(`${what} ${JSON.stringify(s)} is not in the quoted listing text`); return null }
    return s
  }
  const item_price = quotedAmount(c.item_price, iq, 'Item price')
  const shipping_cost = quotedAmount(c.shipping_cost, sq, 'Shipping cost')
  // The total is the agent's own arithmetic: it is what is being tested, so it is kept only alongside a quoted price.
  const total = item_price ? short(c.total, 40) : null
  const cost = {
    answer: item_price ? answerOf(c.answer, iq) : NOT_STATED, option: opt(c.option), option_reason: short(c.option_reason),
    item_price, shipping_cost, total, item_quote: iq, shipping_quote: sq,
  }

  const cq = quoted(cs.quote, 'Colour / size')
  const keep = (v: unknown, what: string) => {
    const s = short(v, 60)
    if (!s || isNotStated(s)) return null
    if (!cq || !inListing(l, s.replace(/\s*cm$/i, ''))) { dropped.push(`${what} ${JSON.stringify(s)} is not in the displayed listing`); return null }
    return s
  }
  const colour = keep(cs.colour, 'Colour')
  const size = keep(cs.size, 'Size')
  const colour_size = { answer: colour || size ? answerOf(cs.answer, cq) : NOT_STATED, colour, size, quote: cq }

  return { returns, delivery, cost, colour_size, dropped }
}

// ---------- code comparison: decides Match / Mismatch / Agent answer not stated ----------
export interface ReadQuestion {
  key: QuestionKey
  question: string
  agent_answer: string
  agent_quotes: string[]
  agent_detail: string | null // e.g. which shipping option the agent picked and why
  formal_term: string // from the catalogue / formal terms record; never part of the agent answer
  result: ReadResult
  code_note: string // how code reached the result, with both values
  customer_line: string | null // only on a mismatch
}

export interface ReadTest {
  // 'pending': the blind read is still running in the background; the scan row is updated when it finishes.
  source: 'muse-spark' | 'unavailable' | 'pending'
  label: string
  reason: string
  today: string
  input: ReturnType<typeof readTestInput> // what Spark was sent, kept so blindness can be checked
  questions: ReadQuestion[]
  dropped: string[]
  summary: string | null
  answers?: AgentAnswers // Spark's guarded answers, kept so an unchanged listing can be re-compared without a new call
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// Same format as the auditor's dateLabel (auditor/audit.ts).
export function dateLabel(d: string): string {
  const t = new Date(`${d}T00:00:00Z`)
  return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`
}
// The shop's "today" (shopper-agent/agent.ts isoDateIn): the store's local date.
export const isoDateIn = (d: Date, timeZone = 'America/Los_Angeles') =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

const customerLine = (answer: string, formal: string) => `An AI agent reading your listing would tell customers "${answer}", but your terms say ${formal}.`

function q(key: QuestionKey, a: { answer: string; quotes: (string | null)[]; detail?: string | null }, formal: string, result: ReadResult, note: string): ReadQuestion {
  return {
    key, question: QUESTIONS[key], agent_answer: a.answer, agent_quotes: a.quotes.filter((x): x is string => !!x), agent_detail: a.detail ?? null,
    formal_term: formal, result, code_note: note, customer_line: result === 'mismatch' ? customerLine(a.answer, formal) : null,
  }
}

const shipOf = (row: Row, o: Option) => o === 'expedited'
  ? { cents: num(row.expedited_shipping_cents), days: num(row.expedited_delivery_days) }
  : { cents: Number(row.standard_shipping_cents ?? 0), days: num(row.standard_delivery_days) }

export function compareReadTest(a: AgentAnswers, row: Row, today: string): ReadQuestion[] {
  const out: ReadQuestion[] = []

  // 1. Returns: the Order check keyword reading (kindOfText / returnsConflict), agent answer vs formal returns.
  {
    const formal = `"${text(row.formal_terms_text) ?? 'no formal terms'}"`
    const ans = { answer: a.returns.answer, quotes: [a.returns.quote] }
    if (a.returns.answer === NOT_STATED) out.push(q('returns', ans, formal, 'not_stated', 'Agent answer not stated: no returns check.'))
    else {
      const conflict = returnsConflict(a.returns.answer, row.formal_returns)
      const kind = kindOfText(a.returns.answer)
      if (conflict === null) out.push(q('returns', ans, formal, 'not_stated', `The agent answer does not say whether it can be returned${kind ? '' : ' (no returns wording found)'}: no returns check.`))
      else out.push(q('returns', ans, formal, conflict ? 'mismatch' : 'match',
        `Agent reads it as ${kind === 'final_sale' ? 'not returnable' : 'returnable'}; formal terms ${formal} are ${row.formal_returns === 'final_sale' ? 'not returnable' : 'returnable'}.`))
    }
  }

  // 2. Delivery: code works out the date from the catalogue's shipping days and compares days and date exactly.
  {
    const o = a.delivery.option ?? 'standard'
    const s = shipOf(row, o)
    const formalDate = s.days !== null ? addDays(today, s.days) : null
    const formal = s.days !== null ? `${o} shipping ${daysLabel(s.days)} (arrives ${dateLabel(formalDate!)} if ordered ${dateLabel(today)})` : `no ${o} shipping`
    const ans = { answer: a.delivery.answer, quotes: [a.delivery.quote], detail: a.delivery.option ? `Option the agent used: ${a.delivery.option}` : null }
    if (a.delivery.answer === NOT_STATED) out.push(q('delivery', ans, formal, 'not_stated', 'Agent answer not stated: no delivery check.'))
    else {
      const problems: string[] = []
      if (s.days === null) problems.push(`the listing has no ${o} shipping`)
      if (a.delivery.days !== null && s.days !== null && a.delivery.days !== s.days) problems.push(`agent ${daysLabel(a.delivery.days)} vs terms ${daysLabel(s.days)}`)
      if (a.delivery.date && formalDate && a.delivery.date !== formalDate) problems.push(`agent date ${dateLabel(a.delivery.date)} vs ${dateLabel(formalDate)} calculated by code`)
      const shown = [a.delivery.days !== null ? daysLabel(a.delivery.days) : null, a.delivery.date ? dateLabel(a.delivery.date) : null].filter(Boolean).join(', ')
      out.push(q('delivery', ans, formal, problems.length ? 'mismatch' : 'match',
        problems.length ? `Mismatch: ${problems.join('; ')}.` : `Agent ${shown} equals ${formal}.`))
    }
  }

  // 3. Cost with shipping: code adds item price + shipping for the option the agent picked (integer cents).
  {
    const o = a.cost.option ?? 'standard'
    const s = shipOf(row, o)
    const codeTotal = s.cents !== null ? row.price_cents + s.cents : null
    const formal = codeTotal !== null ? `${money(codeTotal)} total (item ${money(row.price_cents)} + ${o} shipping ${money(s.cents!)})` : `no ${o} shipping`
    const detail = [a.cost.option ? `Option the agent picked: ${a.cost.option}` : null, a.cost.option_reason ? `why: ${a.cost.option_reason}` : null].filter(Boolean).join(' — ') || null
    const ans = { answer: a.cost.answer, quotes: [a.cost.item_quote, a.cost.shipping_quote], detail }
    const claimed = parseCents(a.cost.total) ?? parseCents(a.cost.item_price) // item price only = what the agent said it costs
    if (a.cost.answer === NOT_STATED || claimed === null) out.push(q('cost', ans, formal, 'not_stated', 'Agent answer not stated: no cost check.'))
    else if (codeTotal === null) out.push(q('cost', ans, formal, 'mismatch', `Mismatch: the agent picked ${o} shipping, which the listing does not offer.`))
    else {
      const what = a.cost.total ? 'agent total' : 'agent gave the item price only'
      out.push(q('cost', ans, formal, claimed === codeTotal ? 'match' : 'mismatch',
        `${claimed === codeTotal ? 'Match' : 'Mismatch'}: ${what} ${money(claimed)} vs ${money(codeTotal)} calculated by code.`))
    }
  }

  // 4. Colour / size: exact match with the catalogue attributes. A value the catalogue does not hold is not checked.
  {
    const catColour = text(row.colour)
    const catSize = num(row.size_cm)
    const formal = [catColour ?? 'no colour in catalogue', catSize !== null ? `${catSize} cm` : 'no size in catalogue'].join(', ')
    const ans = { answer: a.colour_size.answer, quotes: [a.colour_size.quote] }
    const parts: { r: ReadResult; note: string }[] = []
    if (a.colour_size.colour === null) { if (catColour) parts.push({ r: 'not_stated', note: 'colour not stated by the agent' }) }
    else if (catColour && a.colour_size.colour.toLowerCase() === catColour.toLowerCase()) parts.push({ r: 'match', note: `colour ${a.colour_size.colour} = ${catColour}` })
    else parts.push({ r: 'mismatch', note: `colour: agent ${a.colour_size.colour} vs catalogue ${catColour ?? 'none'}` })
    const agentSize = a.colour_size.size !== null ? Number(a.colour_size.size.match(/\d+(?:\.\d+)?/)?.[0] ?? NaN) : null
    if (agentSize === null || Number.isNaN(agentSize)) { if (catSize !== null) parts.push({ r: 'not_stated', note: 'size not stated by the agent' }) }
    else if (catSize !== null && agentSize === catSize) parts.push({ r: 'match', note: `size ${catSize} cm = ${catSize} cm` })
    else parts.push({ r: 'mismatch', note: `size: agent ${a.colour_size.size} vs catalogue ${catSize ?? 'none'} cm` })
    const r: ReadResult = a.colour_size.answer === NOT_STATED || parts.length === 0 ? 'not_stated'
      : parts.some((p) => p.r === 'mismatch') ? 'mismatch' : parts.some((p) => p.r === 'match') ? 'match' : 'not_stated'
    out.push(q('colour_size', ans, formal, r, parts.length ? `${RESULT_LABEL[r]}: ${parts.map((p) => p.note).join('; ')}.` : 'Agent answer not stated: no colour / size check.'))
  }
  return out
}

// Shown only when no question is a mismatch. A not-stated answer is named, so "match" never covers a question with no check.
function summaryOf(questions: ReadQuestion[]): string | null {
  if (questions.some((x) => x.result === 'mismatch')) return null
  const ns = questions.filter((x) => x.result === 'not_stated').map((x) => x.question)
  return ns.length ? `${ALL_MATCH_LINE} Not stated in listing, so not checked: ${ns.join(' ')}` : ALL_MATCH_LINE
}

export function unavailable(row: Row, today: string, why: string): ReadTest {
  return { source: 'unavailable', label: UNAVAILABLE_LABEL, reason: why, today, input: readTestInput(row, today), questions: [], dropped: [], summary: null }
}

export const PENDING_LABEL = 'Agent read-test running'
export function pending(row: Row, today: string): ReadTest {
  return {
    source: 'pending', label: PENDING_LABEL, reason: 'A shopping agent is reading this listing now. Its answers appear here when it finishes.',
    today, input: readTestInput(row, today), questions: [], dropped: [], summary: null,
  }
}

// Same displayed listing, same day: Spark would be sent exactly the same input, so its last answers are reused and
// code compares them again with the current formal terms. Anything different (listing text, prices, shipping, the
// date) means a new blind read.
export function reuseReadTest(prev: ReadTest | undefined | null, row: Row, today: string): ReadTest | null {
  if (!prev || prev.source !== 'muse-spark' || !prev.answers) return null
  const input = readTestInput(row, today)
  if (JSON.stringify(prev.input) !== JSON.stringify(input)) return null
  const questions = compareReadTest(prev.answers, row, today)
  return {
    ...prev, input, today, questions, summary: summaryOf(questions),
    reason: 'Spark answered the four questions on an earlier scan today; the displayed listing is unchanged, so code compared those answers with your formal terms again.',
  }
}

export async function runReadTest(row: Row, reader: AgentReader, today: string): Promise<ReadTest> {
  const input = readTestInput(row, today)
  const res = await reader.read(input).catch(() => ({ ok: false as const, why: 'call failed' }))
  if (!res.ok) return unavailable(row, today, `Spark read-test unavailable (${res.why}).`)
  const answers = guardAnswers(res.raw, input.listing)
  if (!answers) return unavailable(row, today, 'Spark read-test unavailable (unreadable answer).')
  const questions = compareReadTest(answers, row, today)
  return {
    source: 'muse-spark', label: 'Muse Spark, blind read of the displayed listing', reason: 'Spark answered the four questions; code compared each answer with your formal terms.',
    today, input, questions, dropped: answers.dropped,
    summary: summaryOf(questions), answers,
  }
}

function firstJsonObject(s: string): Record<string, unknown> | null {
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) as Record<string, unknown> } catch { return null }
}

// Its own Spark call: its own system prompt, one fresh conversation per listing, no history shared with deconstruct().
export function createSparkAgentReader(apiKey: string | undefined | null, fetchFn: typeof fetch = fetch): AgentReader {
  return {
    async read(input) {
      const key = apiKey?.trim()
      if (!key) return { ok: false, why: 'no model key' }
      try {
        const res = await fetchFn(META_CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(input) }] }),
        })
        if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
        const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null
        const content = json?.choices?.[0]?.message?.content
        const out = typeof content === 'string' ? firstJsonObject(content) : null
        return out ? { ok: true, raw: out } : { ok: false, why: 'unreadable answer' }
      } catch {
        return { ok: false, why: 'call failed' }
      }
    },
  }
}

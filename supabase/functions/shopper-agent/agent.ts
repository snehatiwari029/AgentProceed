// The shopper agent's brain. Pure TypeScript: the model, the database and the clock are injected, so tests run
// it with a fake model. It only ever sees the store's product summaries, never the store's fine print or any merchant-side data.
import { canonicalJson, sha256Hex } from './hash.ts'
import type { ChatMessage, ModelClient, ToolDef } from './model.ts'

export const AGENT_ID = 'meta-muse-j0376672'
export const MERCHANT_NAME = 'Northwind Outfitters'
// Demo only. Every payment the customer names is accepted and recorded as a simulated "Demo Checkout".
// Visa and Mastercard are card networks, not checkout methods, so they are only ever called "Visa card" / "Mastercard".
export const PAYMENT_REF = 'Demo Checkout'
export const ASK_PAYMENT = 'Which payment should I use for this demo checkout? No real charge will be made.'
export const NUMBER_WITHHELD = 'Card (number not stored)'
export function paymentDetail(said: string): string {
  const s = said.replace(/\s+/g, ' ').trim()
  if (/4242/.test(s)) return 'Demo Visa card ••4242'
  if (/stripe/i.test(s)) return 'Stripe Checkout'
  if (/paypal/i.test(s)) return 'PayPal'
  if (/^master\s*card\b/i.test(s)) return 'Mastercard'
  if ((s.match(/\d/g) ?? []).length >= 5) return NUMBER_WITHHELD // never keep a full card or account number
  return s
}
export const paymentLabel = (detail: string) => `${PAYMENT_REF} — ${detail}`
export const SCHEMA_LABEL = 'VI-aligned demo representation'
export const MAX_MESSAGES = 40
export const MAX_TEXT = 1000
export const MAX_MODEL_TURNS = 6

// ---------- types ----------
export type Msg = { role: 'user' | 'assistant'; text: string }

// What the store tells the agent about a product. No formal terms, ever.
export type ProductRow = {
  id: string
  name: string
  brand: string | null
  category: string
  size_cm: number
  colour: string | null
  price_cents: number
  currency: string
  marketing_blurb: string | null
  standard_shipping_cents: number
  standard_delivery_days: number
  expedited_shipping_cents: number | null
  expedited_delivery_days: number | null
}

export type Rules = {
  merchant: typeof MERCHANT_NAME
  budget_max_cents: number | null
  size_min_cm: number | null
  size_max_cm: number | null
  colour_preference: string | null
  delivery_by: string | null
  return_policy_required: boolean | null
  product_scope: string | null
}

export type Shipping = 'standard' | 'expedited'

export type Offer = {
  product_id: string
  name: string
  brand: string | null
  size_cm: number
  colour: string | null
  price_cents: number
  summary: string
  delivery_label: string
  delivery_date: string
  shipping_method: Shipping
  shown_at: string
}

export type OrderView = {
  product_name: string
  brand: string | null
  size_cm: number
  colour: string | null
  item_price_cents: number
  shipping_label: string
  shipping_cents: number
  total_cents: number
  delivery_label: string
  payment_label: string
}

export type Suggestion = { label: string; text: string }
export type AgentReply = { session_id?: string; steps?: string[]; draft?: Rules; ask_payment?: boolean; suggestions?: Suggestion[] } & (
  | { type: 'message'; text: string }
  | { type: 'proposals'; text: string; offers: Offer[]; follow_up: string }
  | { type: 'ordered'; text: string; order: OrderView }
  | { type: 'error'; message: string }
)

// The phone asks for the order number after an order. The order system assigns it; the brain only relays it.
export type OrderStatusReply = { type: 'order_status'; ready: boolean; order_number: string | null }

export type AgentRequest = {
  messages: Msg[]
  session_id: string | null
  draft: Rules | null
  offers: Offer[]
}

export type Step =
  | 'verified_agent_detected' | 'session_started' | 'intent_captured' | 'intent_hash_recorded'
  | 'grant_captured' | 'order_received' | 'receipt_issued'

export interface Store {
  listProducts(): Promise<ProductRow[]>
  merchantId(): Promise<string>
  hasStep(sessionId: string, step: Step): Promise<boolean>
  createSession(row: Record<string, unknown>): Promise<void>
  logStep(sessionId: string, step: Step, detail: Record<string, unknown>, simulated: boolean): Promise<void>
  addGrant(row: Record<string, unknown>): Promise<void>
  addProposal(row: Record<string, unknown>): Promise<void>
  addAction(grantId: string, type: string, detail: Record<string, unknown>, believed: Record<string, unknown> | null): Promise<number>
}

export type Deps = {
  model: ModelClient
  store: Store
  now: () => Date
  demoDate?: string | null
  newId: () => string
  // The order system's "order received" signal: gets the session id only, returns nothing the agent can read.
  // It runs in the background: the customer's confirmation never waits for the order system.
  onOrderReceived?: (sessionId: string) => Promise<void>
  // Each "Muse is checking: ..." line, as soon as Muse decides on it, so the phone can show it live.
  onStep?: (text: string) => void
  // Asks the order system for this session's order number (null until it has one). The brain sees only the number.
  orderNumber?: (sessionId: string) => Promise<string | null>
}

// ---------- small helpers ----------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function isoDateIn(d: Date, timeZone = 'America/Los_Angeles'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function dayLabel(date: string): string {
  const t = new Date(`${date}T00:00:00Z`)
  return `${DAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`
}

function validDate(s: unknown): s is string {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())
}

export function today(deps: Deps): string {
  return deps.demoDate && validDate(deps.demoDate) ? deps.demoDate : isoDateIn(deps.now())
}

function calendar(from: string): string {
  return Array.from({ length: 8 }, (_, i) => {
    const d = addDays(from, i)
    return `${DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d}${i === 0 ? ' (today)' : ''}`
  }).join(', ')
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

// A model sometimes writes the word "null" (or "none", "n/a") instead of a real null. That is "not mentioned", never a value.
const cleanOpt = (v: unknown, max: number): string | null => {
  const s = clean(v, max)
  return s && !/^(null|none|n\/a|na|undefined|not specified|not mentioned|any|no preference)$/i.test(s) ? s : null
}

const toNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

const posInt = (v: unknown): number | null => {
  const n = toNum(v)
  return n !== null && n > 0 ? Math.round(n) : null
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ---------- rules ----------
function finishRules(r: Omit<Rules, 'merchant'>): Rules {
  let { size_min_cm, size_max_cm } = r
  if (size_min_cm !== null && size_max_cm !== null && size_min_cm > size_max_cm) [size_min_cm, size_max_cm] = [size_max_cm, size_min_cm]
  return { merchant: MERCHANT_NAME, ...r, size_min_cm, size_max_cm }
}

// From the model's tool arguments (budget in dollars). Unmentioned or invalid = null, never false.
export function rulesFromModel(args: Record<string, unknown>, todayDate: string): Rules {
  const dollars = toNum(args.budget_max_dollars)
  const by = args.delivery_by
  return finishRules({
    budget_max_cents: dollars !== null && dollars > 0 ? Math.round(dollars * 100) : null,
    size_min_cm: posInt(args.size_min_cm),
    size_max_cm: posInt(args.size_max_cm),
    colour_preference: cleanOpt(args.colour_preference, 40),
    delivery_by: validDate(by) && by >= todayDate ? by : null,
    return_policy_required: args.return_policy_required === true ? true : null,
    product_scope: cleanOpt(args.product_scope, 60),
  })
}

// From the rules the phone screen echoes back with each message: re-checked the same way, in cents.
export function rulesFromDraft(raw: unknown): Rules | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const cents = posInt(d.budget_max_cents)
  const rules = finishRules({
    budget_max_cents: cents,
    size_min_cm: posInt(d.size_min_cm),
    size_max_cm: posInt(d.size_max_cm),
    colour_preference: cleanOpt(d.colour_preference, 40),
    delivery_by: validDate(d.delivery_by) ? d.delivery_by : null,
    return_policy_required: d.return_policy_required === true ? true : null,
    product_scope: cleanOpt(d.product_scope, 60),
  })
  return rules
}

// ---------- request checking ----------
export function parseRequest(raw: unknown): AgentRequest | string {
  if (!raw || typeof raw !== 'object') return 'Bad request'
  const b = raw as Record<string, unknown>
  if (!Array.isArray(b.messages) || b.messages.length === 0) return 'Please send a message.'
  if (b.messages.length > MAX_MESSAGES) return 'This chat is too long. Please start a new one.'
  const messages: Msg[] = []
  for (const m of b.messages) {
    const o = m as Record<string, unknown>
    if ((o?.role !== 'user' && o?.role !== 'assistant') || typeof o.text !== 'string') return 'Bad message.'
    const text = o.text.trim()
    if (!text) continue
    if (text.length > MAX_TEXT) return `Messages can be at most ${MAX_TEXT} characters.`
    messages.push({ role: o.role, text })
  }
  if (messages.length === 0) return 'Please send a message.'
  const sid = b.session_id
  if (sid !== undefined && sid !== null && !(typeof sid === 'string' && UUID_RE.test(sid))) return 'Bad session.'
  const offers: Offer[] = []
  if (Array.isArray(b.offers)) {
    for (const o of b.offers.slice(0, 3)) {
      const r = o as Record<string, unknown>
      if (typeof r?.product_id !== 'string' || !UUID_RE.test(r.product_id)) continue
      if (r.shipping_method !== 'standard' && r.shipping_method !== 'expedited') continue
      const summary = clean(r.summary, 80)
      const shown = typeof r.shown_at === 'string' && !Number.isNaN(Date.parse(r.shown_at)) ? new Date(r.shown_at).toISOString() : null
      if (!summary || !shown) continue
      offers.push({
        product_id: r.product_id, name: clean(r.name, 120) ?? '', brand: clean(r.brand, 40), size_cm: posInt(r.size_cm) ?? 0,
        colour: clean(r.colour, 40), price_cents: posInt(r.price_cents) ?? 0, summary,
        delivery_label: clean(r.delivery_label, 20) ?? '', delivery_date: validDate(r.delivery_date) ? r.delivery_date : '',
        shipping_method: r.shipping_method, shown_at: shown,
      })
    }
  }
  return {
    messages,
    session_id: typeof sid === 'string' ? sid : null,
    draft: rulesFromDraft(b.draft),
    offers,
  }
}

// ---------- tools ----------
const why = { type: 'string', description: 'Plain words, under 12 words, shown to the customer: what you are doing and why.' }

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'set_order_rules',
      description: "Record the rules the customer has stated for this purchase. Use null for anything the customer did not mention. Never guess. Call it when the customer states or changes rules.",
      parameters: {
        type: 'object',
        properties: {
          budget_max_dollars: { type: ['number', 'null'], description: 'Budget the customer stated, in dollars.' },
          size_min_cm: { type: ['integer', 'null'] },
          size_max_cm: { type: ['integer', 'null'] },
          colour_preference: { type: ['string', 'null'] },
          delivery_by: { type: ['string', 'null'], description: 'Exact date YYYY-MM-DD the customer needs it by.' },
          return_policy_required: { type: ['boolean', 'null'], description: 'true only if the customer said it must be returnable; otherwise null.' },
          product_scope: { type: ['string', 'null'], description: 'What they want, e.g. "snowboard".' },
          why,
        },
        required: ['budget_max_dollars', 'size_min_cm', 'size_max_cm', 'colour_preference', 'delivery_by', 'return_policy_required', 'product_scope', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: "List Northwind products with the store's own product summary, price and shipping options. All filters are optional.",
      parameters: {
        type: 'object',
        properties: {
          category: { type: ['string', 'null'], enum: ['snowboard', 'ski', null] },
          max_item_price_dollars: { type: ['number', 'null'] },
          size_min_cm: { type: ['integer', 'null'] },
          size_max_cm: { type: ['integer', 'null'] },
          why,
        },
        required: ['why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_product',
      description: 'Look closely at one product.',
      parameters: { type: 'object', properties: { product_id: { type: 'string' }, why }, required: ['product_id', 'why'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_products',
      description: 'Show the customer one or two options as cards. Each card shows item price, your summary and the delivery day. Then wait for the customer.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'ONE friendly sentence restating only what the customer actually told you, ending by introducing the options, e.g. "... Here are two options from Northwind:".' },
          payment_stated: { type: 'boolean', description: 'true only if the customer has already said how they will pay (for example PayPal) in this chat.' },
          offers: {
            type: 'array', minItems: 1, maxItems: 2,
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                shipping_method: { type: 'string', enum: ['standard', 'expedited'] },
                summary: { type: 'string', description: 'Under 60 characters: the return situation in plain words, from the product page text.' },
              },
              required: ['product_id', 'shipping_method', 'summary'],
            },
          },
          why,
        },
        required: ['message', 'payment_stated', 'offers', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_order',
      description: "Place the order. Call it when the customer's reply picks an option you showed AND names how they will pay. That reply is their confirmation.",
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string' },
          payment_method: { type: ['string', 'null'], description: 'Exactly what the customer said they will pay with, in their words (e.g. "PayPal", "Mastercard", "Apple Pay"). null if they have not said. Never refuse a payment.' },
          why,
        },
        required: ['product_id', 'payment_method', 'why'],
      },
    },
  },
]

// ---------- prompt ----------
function prompt(t: string, rules: Rules | null, offers: Offer[]): string {
  const shown = offers.length
    ? `Options already shown to the customer:\n${offers.map((o) => `- ${o.name} (product_id ${o.product_id}), you described its returns as "${o.summary}", delivery ${o.delivery_label}`).join('\n')}`
    : 'You have not shown the customer any options yet.'
  const known = rules
    ? JSON.stringify({
      budget_max_dollars: rules.budget_max_cents ? rules.budget_max_cents / 100 : null,
      size_min_cm: rules.size_min_cm, size_max_cm: rules.size_max_cm, colour_preference: rules.colour_preference,
      delivery_by: rules.delivery_by, return_policy_required: rules.return_policy_required, product_scope: rules.product_scope,
    })
    : 'none recorded yet'
  return [
    'You are Muse, a friendly personal shopping agent for a customer at Northwind Outfitters (snowboards and skis).',
    `Today is ${t}. Upcoming days: ${calendar(t)}.`,
    `Rules the customer has told you so far: ${known}. Act only inside them. They cannot be widened.`,
    "When the customer states what they want, first call set_order_rules with only what they actually said. Anything not mentioned is null. Never use false for something they did not mention. Turn a day like \"Friday\" into the exact date from the upcoming days.",
    "Use the tools to look at the store's products. You only see the store's product summaries, prices and shipping options.",
    'set_order_rules already returns the store products that fit the rules, with everything search_products and get_product would show. Go straight to propose_products from them; search again only if none of them fits.',
    'Then call propose_products with one or two options. For each option choose the shipping method and write a short summary of the return situation from the product page text. The customer sees item price, your summary and the delivery day on each card.',
    "The 'message' of propose_products must be ONE friendly sentence that restates only what the customer told you (for example budget, arrival day, returns) and then introduces the options. Never mention anything they did not say. Never write 'null', 'not specified' or a list of fields.",
    'Do not ask about colour, size, delivery, returns or anything else the customer did not mention. Only if product selection is impossible without it.',
    'The customer\'s reply that picks an option and says how they will pay IS their confirmation (any payment they name is fine and a typed one is never refused, this is a demo with no real charge). Then call place_order with that product and the payment they named. If they pick an option but have not said how they will pay, call place_order with payment_method null: the store asks for the payment itself, once. If they give a payment but have not picked an option, ask only which option. Never ask for payment again once they have told you. Never refuse a payment or say you cannot check out with it.',
    shown,
    "Every tool call needs a short plain-words 'why' that the customer will see. Do not invent details the tools did not give you. Keep messages short.",
  ].join('\n')
}

// ---------- product views for the model ----------
function shippingOptions(p: ProductRow, t: string) {
  const out: { method: Shipping; cost: string; arrives: string; arrives_date: string }[] = [
    { method: 'standard', cost: p.standard_shipping_cents === 0 ? 'free' : usd(p.standard_shipping_cents), arrives: dayLabel(addDays(t, p.standard_delivery_days)), arrives_date: addDays(t, p.standard_delivery_days) },
  ]
  if (p.expedited_shipping_cents !== null && p.expedited_delivery_days !== null) {
    out.push({ method: 'expedited', cost: usd(p.expedited_shipping_cents), arrives: dayLabel(addDays(t, p.expedited_delivery_days)), arrives_date: addDays(t, p.expedited_delivery_days) })
  }
  return out
}

function productView(p: ProductRow, t: string) {
  return {
    product_id: p.id, name: p.name, brand: p.brand, category: p.category, size_cm: p.size_cm,
    colour: p.colour ?? 'not listed', item_price: usd(p.price_cents), item_price_cents: p.price_cents,
    product_page_text: p.marketing_blurb ?? 'no text on the product page',
    shipping_options: shippingOptions(p, t),
  }
}

function priceAndDelivery(p: ProductRow, method: Shipping, t: string) {
  const expedited = method === 'expedited'
  if (expedited && (p.expedited_shipping_cents === null || p.expedited_delivery_days === null)) return null
  const shipping_cents = expedited ? (p.expedited_shipping_cents as number) : p.standard_shipping_cents
  const days = expedited ? (p.expedited_delivery_days as number) : p.standard_delivery_days
  const delivery_date = addDays(t, days)
  return { shipping_cents, delivery_date, delivery_label: dayLabel(delivery_date), total_cents: p.price_cents + shipping_cents }
}

// ---------- the loop ----------
type Outcome = { result: unknown; done?: AgentReply }

async function runLoop(
  deps: Deps, system: string, history: Msg[], tools: ToolDef[],
  run: (name: string, args: Record<string, unknown>) => Promise<Outcome>,
  extra?: string,
): Promise<AgentReply> {
  const steps: string[] = []
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: m.text }) as ChatMessage)]
  if (extra) messages.push({ role: 'user', content: extra })
  for (let i = 0; i < MAX_MODEL_TURNS; i++) {
    const reply = await deps.model.complete(messages, tools)
    if (!reply.tool_calls) {
      return { type: 'message', text: reply.content ?? "Sorry, I didn't catch that. Could you say it another way?", steps }
    }
    messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls })
    let finished: AgentReply | null = null
    for (const call of reply.tool_calls) {
      const args = parseArgs(call.function.arguments)
      const w = clean(args.why, 100)
      if (w) {
        const line = `Muse is checking: ${w}`
        steps.push(line)
        try { deps.onStep?.(line) } catch { /* a closed stream never stops the turn */ }
      }
      const out = await run(call.function.name, args)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result) })
      if (out.done && !finished) finished = out.done
    }
    if (finished) return { ...finished, steps }
  }
  return { type: 'message', text: "I'm taking longer than expected on this. Please try again.", steps }
}

// ---------- one conversation turn ----------
async function openSession(deps: Deps, req: AgentRequest, rules: Rules, payDetail: string) {
  const { store } = deps
  const sessionId = deps.newId()
  const merchant = await store.merchantId()
  const confirmed = deps.now()
  const confirmed_at = confirmed.toISOString()
  const expires_at = new Date(confirmed.getTime() + 24 * 3600 * 1000).toISOString()
  const private_chat_hash = `sha256:${await sha256Hex(canonicalJson(req.messages))}`

  await store.createSession({
    id: sessionId, merchant_id: merchant, detection_source: 'self_declared_simulated', agent_id: AGENT_ID,
    agent_verified: true, agent_verified_simulated: true, gap_note: null,
  })
  await store.logStep(sessionId, 'verified_agent_detected', { agent_id: AGENT_ID, agent_verified: true, label: 'simulated' }, true)
  await store.logStep(sessionId, 'session_started', { merchant: MERCHANT_NAME }, false)
  await store.logStep(sessionId, 'intent_captured', { fields: rules }, false)
  await store.logStep(sessionId, 'intent_hash_recorded', { private_chat_hash, note: 'Hash only. The chat text is not stored.' }, false)

  // grant_json seals the payment detail too. The grants table keeps only payment_method_ref, so no new column
  // is added (a new column would change the recomputed hash of every existing record).
  const sealed = {
    shopper_ref: 'Demo customer', agent_id: AGENT_ID, agent_verified: true, merchant_id: merchant,
    product_scope: rules.product_scope, size_min_cm: rules.size_min_cm, size_max_cm: rules.size_max_cm,
    colour_preference: rules.colour_preference, currency: 'USD',
    amount_max_cents: rules.budget_max_cents, budget_limit_cents: rules.budget_max_cents,
    payment_method_ref: PAYMENT_REF, payment_method_detail: payDetail, payment_simulated: true,
    shipping_method: null, shipping_max_cost_cents: null,
    delivery_by: rules.delivery_by, return_policy_required: rules.return_policy_required, confirmed_at, expires_at,
  }
  const grantId = deps.newId()
  const { payment_method_detail: _detail, payment_simulated: _simulated, ...columns } = sealed
  await store.addGrant({
    id: grantId, session_id: sessionId, version: 1, supersedes_grant_id: null, ...columns,
    private_chat_hash, grant_json: JSON.parse(canonicalJson(sealed)),
    system_metadata: { data_sharing_limits: 'grant fields only, this purchase only', checked: false, priority: 'P1' },
    schema_label: SCHEMA_LABEL,
  })
  const grant_seal = `sha256:${await sha256Hex(canonicalJson(sealed))}`
  await store.logStep(sessionId, 'grant_captured', { grant_id: grantId, grant_seal, confirmed_at, expires_at, schema_label: SCHEMA_LABEL }, false)
  return { sessionId, grantId }
}

const emptyRules = (): Rules => finishRules({
  budget_max_cents: null, size_min_cm: null, size_max_cm: null, colour_preference: null,
  delivery_by: null, return_policy_required: null, product_scope: null,
})

// The function's entry point: an order-number request, or a chat turn.
export async function respond(raw: unknown, deps: Deps): Promise<AgentReply | OrderStatusReply> {
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).action === 'order_status') return orderStatus(raw as Record<string, unknown>, deps)
  return handle(raw, deps)
}

// Nothing is written until the customer orders. The reply that picks a product and names a payment is the
// customer's confirmation: it opens the session, seals the grant from the rules gathered so far, then records the order.
// ---------- off-topic gate: no Spark call for a chat that is not about shopping this store ----------
// A word about shopping, skiing or snowboarding anywhere in what the customer has typed sends the chat to Muse.
// A chat with none gets this fixed reply at once, with two demo orders to tap.
const ON_TOPIC = new RegExp([
  'snow\\w*', 'ski', 'skis', 'skiing', 'skier\\w*', 'board\\w*', 'binding\\w*', 'boots?', 'goggles?', 'helmets?', 'jackets?', 'gloves?', 'mittens?', 'poles?', 'gear',
  'buy\\w*', 'bought', 'purchas\\w*', 'order\\w*', 'shop\\w*', 'checkout', 'cart', 'pay\\w*', 'prices?', 'priced', 'cost\\w*', 'budget', 'cheap\\w*', 'afford\\w*', 'dollars?', 'usd',
  'deliver\\w*', 'ship\\w*', 'arriv\\w*', 'returns?', 'returnable', 'refund\\w*', 'sizes?', 'cm', 'colou?rs?', 'products?', 'brands?', 'store', 'northwind',
  'burton', 'salomon', 'capita', 'jones', 'nitro', 'atomic', 'rossignol', 'lib\\s*tech', 'beginner', 'freestyle', 'powder', 'all-mountain', 'mountain', 'slopes?', 'resort', 'winter',
].map((w) => `\\b${w}\\b`).join('|') + '|\\$\\s*\\d', 'i')
export const onTopic = (text: string) => ON_TOPIC.test(text)

export const OFF_TOPIC_TEXT = 'Nice try! This chat is a demo for shopping at the Northwind Outfitters store. Try one of these two orders:'
export const DEMO_ORDERS: Suggestion[] = [
  { label: 'An order that passes', text: 'Find and purchase a returnable snowboard under $500 that arrives in 3 days with free standard shipping.' },
  { label: 'An order held for review', text: "Find and purchase a less than $500 snowboard that will arrive at my address in 2 days. I should be able to return it if it doesn't work for me." },
]

export async function handle(raw: unknown, deps: Deps): Promise<AgentReply> {
  const req = parseRequest(raw)
  if (typeof req === 'string') return { type: 'error', message: req }
  const { store } = deps
  const t = today(deps)

  if (req.session_id && (await store.hasStep(req.session_id, 'order_received'))) {
    return { type: 'message', text: 'Your order has already been placed.', session_id: req.session_id, steps: [] }
  }

  // Nothing typed so far is about shopping, and no rules or offers are in play: answer without Muse.
  if (!req.draft && req.offers.length === 0 && !req.messages.some((m) => m.role === 'user' && onTopic(m.text))) {
    return { type: 'message', text: OFF_TOPIC_TEXT, suggestions: DEMO_ORDERS, steps: [], ...(req.session_id ? { session_id: req.session_id } : {}) }
  }

  const products = await store.listProducts()
  const byId = new Map(products.map((p) => [p.id, p]))
  const ctx: { rules: Rules | null } = { rules: req.draft }

  const reply = await runLoop(deps, prompt(t, ctx.rules, req.offers), req.messages, TOOLS, async (name, args) => {
    if (name === 'set_order_rules') {
      ctx.rules = rulesFromModel(args, t)
      // Hand back the products that fit, in the same view search_products gives, so Muse can propose without
      // another round trip. Category and size only: the budget is never enforced here (the receipt must catch an overstep).
      const r = ctx.rules
      const scope = (r.product_scope ?? '').toLowerCase()
      const cat = /snowboard/.test(scope) ? 'snowboard' : /\bski/.test(scope) ? 'ski' : null
      const fits = products.filter((p) => (!cat || p.category === cat) &&
        (r.size_min_cm === null || p.size_cm >= r.size_min_cm) && (r.size_max_cm === null || p.size_cm <= r.size_max_cm))
      return { result: { ok: true, matching_products: fits.map((p) => productView(p, t)) } }
    }
    if (name === 'search_products') {
      const cat = args.category === 'snowboard' || args.category === 'ski' ? args.category : null
      const maxDollars = toNum(args.max_item_price_dollars)
      const lo = posInt(args.size_min_cm)
      const hi = posInt(args.size_max_cm)
      const list = products.filter((p) =>
        (!cat || p.category === cat) && (maxDollars === null || p.price_cents <= maxDollars * 100) &&
        (lo === null || p.size_cm >= lo) && (hi === null || p.size_cm <= hi))
      return { result: { products: list.map((p) => productView(p, t)) } }
    }
    if (name === 'get_product') {
      const p = typeof args.product_id === 'string' ? byId.get(args.product_id) : undefined
      return { result: p ? productView(p, t) : { error: 'No such product. Use a product_id from search_products.' } }
    }
    if (name === 'propose_products') {
      if (!ctx.rules) return { result: { error: "Call set_order_rules first, with only what the customer said." } }
      const raw = Array.isArray(args.offers) ? args.offers.slice(0, 2) : []
      const offers: Offer[] = []
      for (const o of raw as Record<string, unknown>[]) {
        const p = typeof o?.product_id === 'string' ? byId.get(o.product_id) : undefined
        const method: Shipping = o?.shipping_method === 'expedited' ? 'expedited' : 'standard'
        const summary = clean(o?.summary, 80)
        if (!p) return { result: { error: `Unknown product_id ${String(o?.product_id)}` } }
        if (!summary) return { result: { error: 'Each offer needs a short summary.' } }
        const pd = priceAndDelivery(p, method, t)
        if (!pd) return { result: { error: `${p.name} has no expedited shipping.` } }
        const by = ctx.rules.delivery_by
        if (by && pd.delivery_date > by) {
          const inTime = shippingOptions(p, t).filter((o) => o.arrives_date <= by)
          return {
            result: {
              error: `${p.name} with ${method} shipping arrives ${dayLabel(pd.delivery_date)}, after the customer's date (${dayLabel(by)}). ` +
                (inTime.length
                  ? `Options that arrive in time: ${inTime.map((o) => `${o.method} (${o.cost}, arrives ${o.arrives})`).join('; ')}. Change the shipping method, pick a different product, or tell the customer plainly it cannot arrive in time.`
                  : 'No shipping option for this product arrives in time. Pick a different product, or tell the customer plainly.'),
            },
          }
        }
        offers.push({
          product_id: p.id, name: p.name, brand: p.brand, size_cm: p.size_cm, colour: p.colour, price_cents: p.price_cents,
          summary, delivery_label: pd.delivery_label, delivery_date: pd.delivery_date, shipping_method: method,
          shown_at: deps.now().toISOString(),
        })
      }
      if (offers.length === 0) return { result: { error: 'Offer at least one product.' } }
      const text = clean(args.message, 300) ?? 'Here are my picks from Northwind:'
      // The customer picks first. Payment is asked only after a pick, so tapping a payment can never choose the product.
      const follow_up = "Pick one and I'll place the order."
      return { result: { ok: true, shown: offers.length }, done: { type: 'proposals', text, offers, follow_up, ask_payment: false } }
    }
    if (name === 'place_order') {
      const pid = typeof args.product_id === 'string' ? args.product_id : ''
      const offer = req.offers.find((o) => o.product_id === pid)
      const p = byId.get(pid)
      if (!offer || !p) return { result: { error: 'The customer has not been shown that option yet. Propose it first.' } }
      const pay = clean(args.payment_method, 40)
      // No payment named yet: the server asks once, in fixed words, and the phone shows the payment buttons.
      if (!pay) return { result: { ok: true, asked_customer_for_payment: true }, done: { type: 'message', text: ASK_PAYMENT, ask_payment: true } }
      const payDetail = paymentDetail(pay)
      const payLabel = paymentLabel(payDetail)
      const pd = priceAndDelivery(p, offer.shipping_method, t)
      if (!pd) return { result: { error: 'That shipping method is not available.' } }

      const { sessionId, grantId } = await openSession(deps, req, { ...(ctx.rules ?? emptyRules()) }, payDetail)
      const confirmed_at = deps.now().toISOString()
      const proposalId = deps.newId()
      await store.addProposal({
        id: proposalId, grant_id: grantId, product_id: p.id, shown_item_price_cents: p.price_cents, shown_total_cents: null,
        shown_returns_summary: offer.summary, shown_delivery: offer.delivery_label, shown_at: offer.shown_at,
        confirmation_ref: `PC-${proposalId.slice(0, 8).toUpperCase()}`, confirmed_at,
      })
      const detail = {
        product_id: p.id, product_name: p.name, brand: p.brand, size_cm: p.size_cm, colour: p.colour,
        item_price_cents: p.price_cents, shipping_method: offer.shipping_method, shipping_cents: pd.shipping_cents,
        total_cents: pd.total_cents, delivery_date: pd.delivery_date, sealed_at: deps.now().toISOString(),
        payment_method: PAYMENT_REF, payment_method_detail: payDetail, payment_simulated: true,
        agent_summary: { returns: offer.summary },
      }
      const seq = await store.addAction(grantId, 'checkout', detail, { returns: offer.summary })
      await store.logStep(sessionId, 'order_received', { product_id: p.id, total_cents: pd.total_cents, action_seq: seq }, false)
      // Told in the background: the confirmation does not wait for the order system. If the call fails, the order
      // stands and the order system shows it as needing attention.
      try { deps.onOrderReceived?.(sessionId)?.catch(() => {}) } catch { /* same */ }
      const order: OrderView = {
        product_name: p.name, brand: p.brand, size_cm: p.size_cm, colour: p.colour, item_price_cents: p.price_cents,
        shipping_label: offer.shipping_method === 'expedited' ? 'Expedited shipping' : 'Standard shipping',
        shipping_cents: pd.shipping_cents, total_cents: pd.total_cents, delivery_label: pd.delivery_label, payment_label: payLabel,
      }
      return { result: { ok: true, placed: true }, done: { type: 'ordered', text: 'Order received.', order, session_id: sessionId } }
    }
    return { result: { error: `Unknown tool ${name}` } }
  })
  return ctx.rules ? { ...reply, draft: ctx.rules } : reply
}

// The order number for the phone's confirmation card. Read only: it never writes, and never calls the model.
async function orderStatus(raw: Record<string, unknown>, deps: Deps): Promise<OrderStatusReply | AgentReply> {
  const sid = raw.session_id
  if (typeof sid !== 'string' || !UUID_RE.test(sid)) return { type: 'error', message: 'Bad session.' }
  if (!(await deps.store.hasStep(sid, 'order_received'))) return { type: 'error', message: 'No order in this chat yet.' }
  const number = deps.orderNumber ? await deps.orderNumber(sid).catch(() => null) : null
  return { type: 'order_status', ready: !!number, order_number: number }
}

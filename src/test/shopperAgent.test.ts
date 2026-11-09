import { describe, expect, it } from 'vitest'
import { DEMO_ORDERS, handle, OFF_TOPIC_TEXT, onTopic, rulesFromDraft, rulesFromModel, type AgentReply, type Deps, type ProductRow, type Step, type Store } from '../../supabase/functions/shopper-agent/agent'
import { appendChained, type ChainDb } from '../../supabase/functions/shopper-agent/chain'
import { createMetaClient, META_CHAT_URL, MODEL_NAME, type ChatMessage, type ModelClient, type ModelReply } from '../../supabase/functions/shopper-agent/model'
import { verifyChain, type ChainRecord } from '../shared/chain'

const BURTON = '40c70768-77ac-4953-8bae-c75c8319fcf4'
const ORCA = 'd53088eb-40e0-4fa5-b2f8-1b81e9c7c37e'
const MERCHANT = '32b14be6-26e6-49df-a7af-79532f910510'

const PRODUCTS: ProductRow[] = [
  { id: BURTON, name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', category: 'snowboard', size_cm: 156, colour: 'Serpent', price_cents: 44995, currency: 'USD', marketing_blurb: 'Easy returns. Directional twin.', standard_shipping_cents: 0, standard_delivery_days: 5, expedited_shipping_cents: 6000, expedited_delivery_days: 4 },
  { id: ORCA, name: 'T. Rice Orca Snowboard 2025/2026', brand: 'Lib Tech', category: 'snowboard', size_cm: 156, colour: null, price_cents: 48983, currency: 'USD', marketing_blurb: 'Free returns.', standard_shipping_cents: 0, standard_delivery_days: 3, expedited_shipping_cents: null, expedited_delivery_days: null },
]

function memoryStore() {
  const tables: Record<string, Record<string, unknown>[]> = { sessions: [], session_events: [], grants: [], proposals: [], actions: [] }
  const chain: { chain_seq: number; table: string; row: Record<string, unknown> }[] = []
  const chainDb: ChainDb = {
    latestHash: async () => (chain.at(-1)?.row.entry_hash as string | undefined) ?? null,
    insert: async (table, row) => {
      tables[table].push(row)
      chain.push({ chain_seq: chain.length + 1, table, row })
    },
  }
  const store: Store = {
    listProducts: async () => PRODUCTS,
    merchantId: async () => MERCHANT,
    hasStep: async (sid, step: Step) => tables.session_events.some((e) => e.session_id === sid && e.step === step),
    createSession: async (row) => void tables.sessions.push(row),
    logStep: async (session_id, step, detail, simulated) => void tables.session_events.push({ session_id, step, detail, simulated }),
    addGrant: async (row) => void (await appendChained(chainDb, 'grants', row)),
    addProposal: async (row) => void (await appendChained(chainDb, 'proposals', row)),
    addAction: async (grant_id, type, detail, believed) => {
      const seq = tables.actions.filter((a) => a.grant_id === grant_id).length + 1
      await appendChained(chainDb, 'actions', { id: `act-${chain.length}`, grant_id, seq, type, detail, agent_believed_terms: believed, image_evidence_ref: null })
      return seq
    },
  }
  return { store, tables, chain }
}

// A scripted stand-in for Muse. It only plays back model replies; it records what it was sent.
function fakeModel(script: ((messages: ChatMessage[]) => ModelReply)[]) {
  const seen: ChatMessage[][] = []
  let i = 0
  const model: ModelClient = {
    complete: async (messages) => {
      seen.push(JSON.parse(JSON.stringify(messages)))
      const f = script[i++]
      if (!f) throw new Error('model called more times than scripted')
      return f(messages)
    },
  }
  return { model, seen }
}

const call = (name: string, args: unknown, id = `c${Math.random()}`): ModelReply => ({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

let n = 0
const deps = (model: ModelClient, store: Store): Deps => ({
  model, store, now: () => new Date('2026-10-26T18:00:00Z'), demoDate: null,
  newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
})

const HERO = 'Help me place an order for a snowboard for this weekend trip with my friends. It should look cool, size 150-165 cm, I need it by Friday. Budget under $500. I should be able to return it if it doesn\'t work for me.'
const heroArgs = { budget_max_dollars: 500, size_min_cm: 150, size_max_cm: 165, colour_preference: null, delivery_by: '2026-10-30', return_policy_required: true, product_scope: 'snowboard', why: 'Reading your request' }
const bothOffers = (payment_stated = false) => call('propose_products', {
  message: "Looking for snowboards under $500 that arrive by Friday and that you can return. Here are two options from Northwind:", payment_stated, why: 'Showing you my picks',
  offers: [{ product_id: BURTON, shipping_method: 'expedited', summary: 'Easy returns' }, { product_id: ORCA, shipping_method: 'standard', summary: 'Free returns' }],
})

async function asOk<T extends AgentReply['type']>(p: Promise<AgentReply>, type: T) {
  const r = await p
  expect(r.type).toBe(type)
  return r as Extract<AgentReply, { type: T }> & AgentReply
}

// Turn 1: the customer's request -> rules recorded in the conversation, options shown, nothing stored yet.
async function firstTurn(m: ReturnType<typeof memoryStore>, payment_stated = false) {
  const script = fakeModel([
    () => call('set_order_rules', heroArgs, 'a'),
    () => call('search_products', { category: 'snowboard', max_item_price_dollars: 500, why: 'Looking at snowboards under $500' }, 'b'),
    () => bothOffers(payment_stated),
  ])
  const r = await asOk(handle({ messages: [{ role: 'user', text: HERO }] }, deps(script.model, m.store)), 'proposals')
  return { r, script }
}

const orderTurn = (m: ReturnType<typeof memoryStore>, first: Extract<AgentReply, { type: 'proposals' }> & AgentReply, args: Record<string, unknown>, text = 'Serpent looks cool. Order it. Use my PayPal account for checkout.') =>
  handle({ messages: [{ role: 'user', text: HERO }, { role: 'assistant', text: first.text }, { role: 'assistant', text: first.follow_up }, { role: 'user', text }], draft: first.draft, offers: first.offers },
    deps(fakeModel([() => call('place_order', args)]).model, m.store))

describe('shopper-agent: first reply', () => {
  it('records the rules in the conversation, shows two cards and asks the customer to pick (no payment question yet), and stores nothing yet', async () => {
    const m = memoryStore()
    const { r, script } = await firstTurn(m)
    expect(r.text).toBe('Looking for snowboards under $500 that arrive by Friday and that you can return. Here are two options from Northwind:')
    expect(r.follow_up).toBe("Pick one and I'll place the order.")
    expect(r.ask_payment).toBe(false)
    expect(r.offers.map((o) => [o.name, o.price_cents, o.summary, o.delivery_label])).toEqual([
      ['Spellbinder Snowboard 2026/2027', 44995, 'Easy returns', 'Fri Oct 30'],
      ['T. Rice Orca Snowboard 2025/2026', 48983, 'Free returns', 'Thu Oct 29'],
    ])
    // offers carry no total
    expect(JSON.stringify(r.offers)).not.toMatch(/total|50995|formal/i)
    expect(r.draft).toMatchObject({ budget_max_cents: 50000, size_min_cm: 150, size_max_cm: 165, delivery_by: '2026-10-30', return_policy_required: true, colour_preference: null })
    expect(r.steps).toHaveLength(3)
    // no form-style fields in the reply, and nothing written
    expect(JSON.stringify({ text: r.text, follow_up: r.follow_up })).not.toMatch(/null|not specified/i)
    expect(Object.values(m.tables).every((t) => t.length === 0)).toBe(true)
    // the model saw today's date and only store summaries, never the store's fine print
    const seen = JSON.stringify(script.seen.at(-1))
    expect(JSON.stringify(script.seen[0])).toContain('2026-10-26 (today)')
    expect(seen).toContain('Easy returns')
    expect(seen).not.toMatch(/final.?sale|formal|terms_text|verdict|mismatch|receipt/i)
  })

  it('does not ask about payment again when the customer already named it', async () => {
    const { r } = await firstTurn(memoryStore(), true)
    expect(r.follow_up).toBe("Pick one and I'll place the order.")
  })

  it('stores unmentioned rules as null, and a false or bad value never becomes a rule', async () => {
    const m = memoryStore()
    const script = fakeModel([
      () => call('set_order_rules', { ...heroArgs, delivery_by: 'Friday', return_policy_required: false, size_min_cm: 165, size_max_cm: 150 }),
      () => bothOffers(),
    ])
    const r = await asOk(handle({ messages: [{ role: 'user', text: 'a board' }] }, deps(script.model, m.store)), 'proposals')
    expect(r.draft!.delivery_by).toBeNull()
    expect(r.draft!.return_policy_required).toBeNull()
    expect([r.draft!.size_min_cm, r.draft!.size_max_cm]).toEqual([150, 165])
  })

  it('drops quote marks the model puts around a rule (test order 15004 stored "snowboard" with its quotes)', () => {
    const r = rulesFromModel({ ...heroArgs, product_scope: '"snowboard"', colour_preference: '\u201CSerpent\u201D' }, '2026-10-26')
    expect(r.product_scope).toBe('snowboard')
    expect(r.colour_preference).toBe('Serpent')
  })

  it('refuses to propose before the rules are recorded', async () => {
    const m = memoryStore()
    const script = fakeModel([() => bothOffers(), () => ({ content: 'What are you shopping for?' })])
    const r = await asOk(handle({ messages: [{ role: 'user', text: 'hi, I want a snowboard' }] }, deps(script.model, m.store)), 'message')
    expect(r.text).toContain('shopping for')
  })

  it('fails closed on bad requests and enforces the caps', async () => {
    const m = memoryStore()
    const { model } = fakeModel([])
    expect((await handle({ messages: [] }, deps(model, m.store))).type).toBe('error')
    expect((await handle({ messages: [{ role: 'user', text: 'x'.repeat(1001) }] }, deps(model, m.store))).type).toBe('error')
    expect((await handle({ messages: Array.from({ length: 41 }, () => ({ role: 'user', text: 'a' })) }, deps(model, m.store))).type).toBe('error')
    expect((await handle({ messages: [{ role: 'user', text: 'a' }], session_id: 'nope' }, deps(model, m.store))).type).toBe('error')
  })
})

describe('shopper-agent: never offers something that misses the customer\'s date', () => {
  it('bounces a standard-shipping offer that arrives after Friday, naming the options that arrive in time', async () => {
    const m = memoryStore()
    const script = fakeModel([
      () => call('set_order_rules', heroArgs),
      () => call('propose_products', { message: 'x', payment_stated: false, why: 'x', offers: [{ product_id: BURTON, shipping_method: 'standard', summary: 'Easy returns' }] }),
      () => call('propose_products', { message: 'Looking for a snowboard under $500 by Friday. Here is an option:', payment_stated: false, why: 'x', offers: [{ product_id: BURTON, shipping_method: 'expedited', summary: 'Easy returns' }] }),
    ])
    const r = await asOk(handle({ messages: [{ role: 'user', text: HERO }] }, deps(script.model, m.store)), 'proposals')
    expect(r.offers[0]).toMatchObject({ shipping_method: 'expedited', delivery_label: 'Fri Oct 30' })
    const bounce = JSON.stringify(script.seen[2])
    expect(bounce).toContain('arrives Sat Oct 31, after the customer')
    expect(bounce).toContain('expedited ($60.00, arrives Fri Oct 30)')
  })

  it('lets the model decide: with no in-time option it must pick another product or tell the customer', async () => {
    const m = memoryStore()
    const script = fakeModel([
      () => call('set_order_rules', { ...heroArgs, delivery_by: '2026-10-27' }),
      () => call('propose_products', { message: 'x', payment_stated: false, why: 'x', offers: [{ product_id: ORCA, shipping_method: 'standard', summary: 'Free returns' }] }),
      () => ({ content: "Sorry, nothing can arrive by Tuesday." }),
    ])
    const r = await asOk(handle({ messages: [{ role: 'user', text: 'a snowboard by Tuesday' }] }, deps(script.model, m.store)), 'message')
    expect(r.text).toContain('nothing can arrive')
    expect(JSON.stringify(script.seen[2])).toContain('No shipping option for this product arrives in time')
  })
})

describe('shopper-agent: the order reply is the confirmation', () => {
  it('writes the session log, grant, proposal and action in order, on a valid chain', async () => {
    const m = memoryStore()
    const { r: first } = await firstTurn(m)
    const r3 = await asOk(orderTurn(m, first, { product_id: BURTON, payment_method: 'PayPal', why: 'Placing your order' }), 'ordered')
    expect(r3.order).toMatchObject({ product_name: 'Spellbinder Snowboard 2026/2027', colour: 'Serpent', size_cm: 156, item_price_cents: 44995, shipping_cents: 6000, total_cents: 50995, delivery_label: 'Fri Oct 30', payment_label: 'Demo Checkout — PayPal' })

    expect(m.tables.session_events.map((e) => e.step)).toEqual(['verified_agent_detected', 'session_started', 'intent_captured', 'intent_hash_recorded', 'grant_captured', 'order_received'])
    expect(m.tables.session_events[0]).toMatchObject({ simulated: true, detail: { agent_id: 'meta-muse-j0376672', agent_verified: true, label: 'simulated' } })
    expect(m.tables.sessions[0]).toMatchObject({ agent_id: 'meta-muse-j0376672', agent_verified: true, agent_verified_simulated: true })

    const grant = m.tables.grants[0]
    expect(grant).toMatchObject({ amount_max_cents: 50000, budget_limit_cents: 50000, size_min_cm: 150, size_max_cm: 165, delivery_by: '2026-10-30', return_policy_required: true, payment_method_ref: 'Demo Checkout', colour_preference: null, shipping_method: null })
    expect(JSON.stringify(m.tables)).not.toContain('weekend trip')
    expect(String(grant.private_chat_hash)).toMatch(/^sha256:[0-9a-f]{64}$/)

    expect(m.tables.proposals[0]).toMatchObject({ shown_item_price_cents: 44995, shown_total_cents: null, shown_returns_summary: 'Easy returns', shown_delivery: 'Fri Oct 30' })
    const checkout = m.tables.actions.find((a) => a.type === 'checkout')!
    expect(checkout).toMatchObject({ agent_believed_terms: { returns: 'Easy returns' }, detail: { item_price_cents: 44995, shipping_method: 'expedited', shipping_cents: 6000, total_cents: 50995, delivery_date: '2026-10-30', size_cm: 156, colour: 'Serpent' } })

    const records: ChainRecord[] = m.chain.map((c) => ({ chain_seq: c.chain_seq, entry_type: c.table === 'grants' ? 'grant' : c.table === 'proposals' ? 'proposal' : 'action', row: c.row as ChainRecord['row'] }))
    expect(records.map((r) => r.entry_type)).toEqual(['grant', 'proposal', 'action'])
    expect((await verifyChain(records)).ok).toBe(true)
    const edited = records.map((r, i) => (i === 0 ? { ...r, row: { ...r.row, amount_max_cents: 99900 } } : r))
    expect((await verifyChain(edited)).ok).toBe(false)
  })

  it('does not enforce the budget itself (the receipt must be able to catch an overstep)', async () => {
    const m = memoryStore()
    const { r: first } = await firstTurn(m)
    const r = await asOk(orderTurn(m, first, { product_id: BURTON, payment_method: 'PayPal', why: 'x' }), 'ordered')
    expect(r.order.total_cents).toBe(50995)
    expect(r.order.total_cents).toBeGreaterThan(50000)
  })

  it('asks for the payment once, in fixed words, and writes nothing, when the customer has not said how to pay', async () => {
    const m = memoryStore()
    const { r: first } = await firstTurn(m)
    const script = fakeModel([() => call('place_order', { product_id: BURTON, payment_method: null, why: 'x' })])
    const r = await asOk(handle({ messages: [{ role: 'user', text: HERO }, { role: 'user', text: "I'll take the Burton." }], draft: first.draft, offers: first.offers }, deps(script.model, m.store)), 'message')
    expect(r.text).toBe('Which payment should I use for this demo checkout? No real charge will be made.')
    expect(r.ask_payment).toBe(true)
    expect(Object.values(m.tables).every((t) => t.length === 0)).toBe(true)
  })

  it.each(['null', 'none', 'N/A', 'not specified'])('asks for the payment when the model sends "%s" as the payment, and writes nothing (test order 15005)', async (said) => {
    const m = memoryStore()
    const { r: first } = await firstTurn(m)
    const script = fakeModel([() => call('place_order', { product_id: BURTON, payment_method: said, why: 'x' })])
    const r = await asOk(handle({ messages: [{ role: 'user', text: HERO }, { role: 'user', text: "I'll take the Burton." }], draft: first.draft, offers: first.offers }, deps(script.model, m.store)), 'message')
    expect(r.text).toBe('Which payment should I use for this demo checkout? No real charge will be made.')
    expect(r.ask_payment).toBe(true)
    expect(Object.values(m.tables).every((t) => t.length === 0)).toBe(true)
  })

  it.each([
    ['Demo Visa card ••4242', 'Demo Visa card ••4242'],
    ['Mastercard', 'Mastercard'],
    ['Stripe Checkout', 'Stripe Checkout'],
    ['PayPal', 'PayPal'],
    ['Apple Pay', 'Apple Pay'],
    ['stripe', 'Stripe Checkout'],
  ])('accepts "%s" and records it as a simulated Demo Checkout', async (said, detail) => {
    const m = memoryStore()
    const { r: first } = await firstTurn(m)
    const r = await asOk(orderTurn(m, first, { product_id: BURTON, payment_method: said, why: 'x' }, `Burton please, pay with ${said}`), 'ordered')
    expect(r.order.payment_label).toBe(`Demo Checkout — ${detail}`)
    const grant = m.tables.grants[0]
    expect(grant.payment_method_ref).toBe('Demo Checkout')
    expect(grant.grant_json).toMatchObject({ payment_method_ref: 'Demo Checkout', payment_method_detail: detail, payment_simulated: true })
    expect(Object.keys(grant)).not.toContain('payment_method_detail')
    expect(m.tables.actions.find((a) => a.type === 'checkout')!.detail).toMatchObject({ payment_method: 'Demo Checkout', payment_method_detail: detail, payment_simulated: true })
    expect(JSON.stringify(m.tables)).not.toMatch(/visa checkout|mastercard checkout/i)
  })

  it('never keeps a card number: it is accepted but only "number not stored" is recorded', async () => {
    const m = memoryStore()
    const { r: first } = await firstTurn(m)
    const r = await asOk(orderTurn(m, first, { product_id: BURTON, payment_method: 'card 4111 1111 1111 1111', why: 'x' }, 'pay with card 4111 1111 1111 1111'), 'ordered')
    expect(r.order.payment_label).toBe('Demo Checkout — Card (number not stored)')
    expect(JSON.stringify(m.tables)).not.toContain('4111')
  })

  it('tells the order system once with the session id only, and still places the order if that call fails', async () => {
    for (const fail of [false, true]) {
      const m = memoryStore()
      const { r: first } = await firstTurn(m)
      const sent: unknown[][] = []
      const d = { ...deps(fakeModel([() => call('place_order', { product_id: BURTON, payment_method: 'PayPal', why: 'x' })]).model, m.store),
        onOrderReceived: async (...args: unknown[]) => { sent.push(args); if (fail) throw new Error('order system down') } }
      const r = await asOk(handle({ messages: [{ role: 'user', text: HERO }, { role: 'user', text: 'Order it. Use PayPal.' }], draft: first.draft, offers: first.offers }, d), 'ordered')
      expect(sent).toEqual([[r.session_id]])
      expect(r.text).toBe('Order received.')
      expect(m.tables.session_events.at(-1)).toMatchObject({ step: 'order_received' })
    }
  })

  it('refuses an option the customer was never shown, and does not write', async () => {
    const m = memoryStore()
    const script = fakeModel([() => call('place_order', { product_id: BURTON, payment_method: 'PayPal', why: 'x' }), () => ({ content: 'Let me show you options first.' })])
    const r = await asOk(handle({ messages: [{ role: 'user', text: 'order the Burton with PayPal' }], offers: [] }, deps(script.model, m.store)), 'message')
    expect(r.text).toContain('options first')
    expect(Object.values(m.tables).every((t) => t.length === 0)).toBe(true)
  })

  it('will not place a second order in the same session', async () => {
    const m = memoryStore()
    const { r: first } = await firstTurn(m)
    const done = await asOk(orderTurn(m, first, { product_id: ORCA, payment_method: 'PayPal', why: 'x' }), 'ordered')
    const again = await handle({ messages: [{ role: 'user', text: 'order again' }], session_id: done.session_id, offers: first.offers }, deps(fakeModel([]).model, m.store))
    expect(again.type).toBe('message')
    expect(m.tables.proposals).toHaveLength(1)
  })
})

describe('Meta Model API client', () => {
  it('fails with the clear message when MODEL_API_KEY is missing', () => {
    expect(() => createMetaClient(undefined)).toThrow('MODEL_API_KEY not set in Supabase secrets')
    expect(() => createMetaClient('  ')).toThrow('MODEL_API_KEY not set in Supabase secrets')
  })

  it('posts to the documented endpoint with tool_choice auto and the muse-spark-1.3 model', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const client = createMetaClient('test-key', fake)
    const r = await client.complete([{ role: 'user', content: 'x' }], [{ type: 'function', function: { name: 'a', description: 'b', parameters: { type: 'object' } } }])
    expect(r.content).toBe('hi')
    expect(seen!.url).toBe(META_CHAT_URL)
    expect(META_CHAT_URL).toBe('https://api.meta.ai/v1/chat/completions')
    const body = JSON.parse(seen!.init.body as string)
    expect(body).toMatchObject({ model: MODEL_NAME, tool_choice: 'auto', parallel_tool_calls: false })
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
  })

  it('does not leak the key in errors', async () => {
    const fake = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(createMetaClient('secret-key-123', fake).complete([], [])).rejects.toThrow(/401/)
    await createMetaClient('secret-key-123', fake).complete([], []).catch((e: Error) => expect(e.message).not.toContain('secret-key-123'))
  })
})

describe('shopper-agent: rules written as the word "null"', () => {
  it('treats "null", "none" and "n/a" as not mentioned, never as a colour or product', () => {
    const r = rulesFromModel({ budget_max_dollars: 500, colour_preference: 'null', product_scope: 'None', delivery_by: null }, '2026-10-26')
    expect(r.colour_preference).toBeNull()
    expect(r.product_scope).toBeNull()
    expect(rulesFromDraft({ colour_preference: 'n/a', product_scope: 'snowboard' })?.colour_preference).toBeNull()
  })
})

describe('shopper-agent: off-topic gate', () => {
  it('a chat with nothing about shopping gets the fixed reply and two demo orders, with no Spark call and no store read', async () => {
    const m = memoryStore()
    const script = fakeModel([])
    let listed = 0
    const store = { ...m.store, listProducts: async () => { listed++; return m.store.listProducts() } }
    for (const text of ['hi', 'tell me a joke', 'what is the capital of France?']) {
      const r = await asOk(handle({ messages: [{ role: 'user', text }] }, deps(script.model, store)), 'message')
      expect(r.text).toBe(OFF_TOPIC_TEXT)
      expect(r.text).toBe('Nice try! This chat is a demo for shopping at the Northwind Outfitters store. Try one of these two orders:')
      expect(r.suggestions).toEqual(DEMO_ORDERS)
    }
    expect(script.seen).toHaveLength(0)
    expect(listed).toBe(0)
    expect(DEMO_ORDERS.map((d) => d.label)).toEqual(['An order that passes', 'An order held for review'])
  })

  it('once the chat is about shopping, later short answers ("yes", "Visa") still go to Muse', async () => {
    const m = memoryStore()
    const script = fakeModel([() => ({ content: 'Got it.' })])
    const r = await asOk(handle({ messages: [{ role: 'user', text: 'I need a snowboard' }, { role: 'assistant', text: 'What size?' }, { role: 'user', text: 'yes' }] }, deps(script.model, m.store)), 'message')
    expect(r.text).toBe('Got it.')
    expect(script.seen).toHaveLength(1)
  })

  it('both demo orders, and shopping words, pass the gate; small talk does not', () => {
    for (const d of DEMO_ORDERS) expect(onTopic(d.text)).toBe(true)
    for (const t of ['skis for my kid', 'under $450', 'can I return it?', 'Burton please', 'do you have boots?']) expect(onTopic(t)).toBe(true)
    for (const t of ['hi', 'hello there', 'write a poem about cats', 'skip this', 'I like skin care']) expect(onTopic(t)).toBe(false)
  })
})

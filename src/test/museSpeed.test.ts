import { describe, expect, it } from 'vitest'
import { handle, respond, type AgentReply, type Deps, type ProductRow, type Step, type Store } from '../../supabase/functions/shopper-agent/agent'
import type { ModelClient, ModelReply } from '../../supabase/functions/shopper-agent/model'
import { orderStatus } from '../../supabase/functions/order-status/run'
import { runAuditor } from '../../supabase/functions/auditor/run'
import type { SemanticReader } from '../../supabase/functions/auditor/spark'

const BURTON = '40c70768-77ac-4953-8bae-c75c8319fcf4'
const SKI = '11111111-1111-4111-8111-111111111111'
const PRODUCTS: ProductRow[] = [
  { id: BURTON, name: 'Spellbinder Snowboard', brand: 'Burton', category: 'snowboard', size_cm: 156, colour: 'Serpent', price_cents: 44995, currency: 'USD', marketing_blurb: 'Easy returns.', standard_shipping_cents: 0, standard_delivery_days: 5, expedited_shipping_cents: 6000, expedited_delivery_days: 2 },
  { id: SKI, name: 'Ranger Ski', brand: 'Fischer', category: 'ski', size_cm: 172, colour: null, price_cents: 59900, currency: 'USD', marketing_blurb: null, standard_shipping_cents: 0, standard_delivery_days: 3, expedited_shipping_cents: null, expedited_delivery_days: null },
]
const call = (name: string, args: unknown): ModelReply => ({ content: null, tool_calls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const script = (steps: ((m: unknown[]) => ModelReply)[]) => {
  const seen: unknown[][] = []
  let i = 0
  const model: ModelClient = { complete: async (m) => { seen.push(JSON.parse(JSON.stringify(m))); return steps[i++](m) } }
  return { model, seen }
}
function store() {
  const events: { session_id: string; step: Step }[] = []
  const s: Store = {
    listProducts: async () => PRODUCTS, merchantId: async () => '32b14be6-26e6-49df-a7af-79532f910510',
    hasStep: async (sid, step) => events.some((e) => e.session_id === sid && e.step === step),
    createSession: async () => {}, logStep: async (session_id, step) => void events.push({ session_id, step }),
    addGrant: async () => {}, addProposal: async () => {}, addAction: async () => 1,
  }
  return s
}
let n = 0
const base = (model: ModelClient, s: Store): Deps => ({ model, store: s, now: () => new Date('2026-10-26T18:00:00Z'), newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })
const rules = { budget_max_dollars: 500, size_min_cm: 150, size_max_cm: 165, colour_preference: null, delivery_by: '2026-10-28', return_policy_required: true, product_scope: 'snowboard', why: 'Recording your snowboard needs' }
const propose = call('propose_products', { message: 'A snowboard under $500 by Wednesday you can return. Here is one option:', payment_stated: false, why: 'Showing a snowboard', offers: [{ product_id: BURTON, shipping_method: 'expedited', summary: 'Easy returns' }] })

describe('Muse speed: fewer round trips, live steps, no wait on the order system', () => {
  it('set_order_rules hands back the products that fit (category and size only), so Muse can propose in two calls', async () => {
    const m = script([() => call('set_order_rules', rules), () => propose])
    const r = await handle({ messages: [{ role: 'user', text: 'snowboard under $500 by Wednesday, returnable' }] }, base(m.model, store()))
    expect(r.type).toBe('proposals')
    expect(m.seen).toHaveLength(2)
    const tool = (m.seen[1] as { role: string; content: string }[]).find((x) => x.role === 'tool')!
    const out = JSON.parse(tool.content)
    expect(out.ok).toBe(true)
    expect(out.matching_products.map((p: { product_id: string }) => p.product_id)).toEqual([BURTON])
    expect(out.matching_products[0]).toMatchObject({ product_page_text: 'Easy returns.', item_price_cents: 44995 })
    expect(out.matching_products[0].shipping_options).toHaveLength(2)
    // the budget is not enforced here: a product over budget would still be listed (the receipt must catch an overstep)
    const pricey = script([() => call('set_order_rules', { ...rules, budget_max_dollars: 100 }), () => propose])
    await handle({ messages: [{ role: 'user', text: 'snowboard under $100' }] }, base(pricey.model, store()))
    expect(JSON.parse((pricey.seen[1] as { role: string; content: string }[]).find((x) => x.role === 'tool')!.content).matching_products).toHaveLength(1)
  })

  it('sends each "Muse is checking" line as soon as Muse decides on it, and still returns them with the reply', async () => {
    const live: string[] = []
    const m = script([() => call('set_order_rules', rules), () => propose])
    const r = await handle({ messages: [{ role: 'user', text: 'snowboard' }] }, { ...base(m.model, store()), onStep: (l) => live.push(l) })
    expect(live).toEqual(['Muse is checking: Recording your snowboard needs', 'Muse is checking: Showing a snowboard'])
    expect(r.steps).toEqual(live)
  })

  it('confirms the order without waiting for the order system', async () => {
    const s = store()
    const first = (await handle({ messages: [{ role: 'user', text: 'snowboard' }] }, base(script([() => call('set_order_rules', rules), () => propose]).model, s))) as Extract<AgentReply, { type: 'proposals' }> & AgentReply
    let finished = false
    const never = new Promise<void>(() => {}) // an order system that has not answered yet
    const r = await handle(
      { messages: [{ role: 'user', text: 'snowboard' }, { role: 'user', text: 'Order it. PayPal.' }], draft: first.draft, offers: first.offers },
      { ...base(script([() => call('place_order', { product_id: BURTON, payment_method: 'PayPal', why: 'Placing your order' })]).model, s), onOrderReceived: () => never.then(() => { finished = true }) },
    )
    expect(r.type).toBe('ordered')
    expect(finished).toBe(false)
  })

  it('relays the order number only after an order in this chat, and never calls the model for it', async () => {
    const s = store()
    const model: ModelClient = { complete: async () => { throw new Error('the model must not be called') } }
    const sid = '00000000-0000-4000-8000-0000000000aa'
    expect(await respond({ action: 'order_status', session_id: sid }, { ...base(model, s), orderNumber: async () => '15004' })).toMatchObject({ type: 'error' })
    await s.logStep(sid, 'order_received', {}, false)
    expect(await respond({ action: 'order_status', session_id: sid }, { ...base(model, s), orderNumber: async () => null })).toEqual({ type: 'order_status', ready: false, order_number: null })
    expect(await respond({ action: 'order_status', session_id: sid }, { ...base(model, s), orderNumber: async () => '15004' })).toEqual({ type: 'order_status', ready: true, order_number: '15004' })
    expect(await respond({ action: 'order_status', session_id: 'nope' }, base(model, s))).toMatchObject({ type: 'error' })
  })
})

describe('order-status (order system): session id in, order number out', () => {
  it('returns only the order number, and null before the receipt exists', async () => {
    const db = { grantIdForSession: async (s: string) => (s.endsWith('1') ? 'g-1' : null), orderRefForGrant: async (g: string) => (g === 'g-1' ? '15004' : null) }
    expect(await orderStatus({ session_id: '00000000-0000-4000-8000-000000000001' }, db)).toEqual({ type: 'order_status', order_number: '15004' })
    expect(await orderStatus({ session_id: '00000000-0000-4000-8000-000000000002' }, db)).toEqual({ type: 'order_status', order_number: null })
    expect(await orderStatus({ session_id: 'x' }, db)).toMatchObject({ type: 'error' })
  })
})

describe('auditor: the two Spark reads run at the same time', () => {
  it('starts the delivery read before the returns read has finished', async () => {
    const order: string[] = []
    let releaseReturns: () => void = () => {}
    const reader: SemanticReader = {
      readReturns: () => new Promise((res) => { order.push('returns:start'); releaseReturns = () => { order.push('returns:end'); res({ returns_summary_matches_terms: false, reason: 'r', source: 'muse-spark' }) } }),
      readDelivery: async () => { order.push('delivery:start'); setTimeout(() => releaseReturns(), 0); return { claimed_date: null, source: 'rules-fallback' } },
    }
    const grant = { id: 'g', merchant_id: 'm', return_policy_required: true, prev_hash: 'x', entry_hash: 'y', chain_seq: 1 }
    const db = {
      latestHash: async () => null, insert: async () => {}, sessionExists: async () => true, grantForSession: async () => grant,
      proposalForGrant: async () => ({ id: 'p', shown_returns_summary: 'Easy returns', shown_delivery: 'Wed Oct 28' }),
      checkoutForGrant: async () => ({ id: 'a', detail: { product_id: 'prod' } }),
      product: async () => ({ category: 'snowboard', formal_returns: 'final_sale', formal_terms_text: 'Final Sale', merchant_name: 'Northwind Outfitters', row: {} }),
      merchantName: async () => 'Northwind Outfitters', entryHashAt: async () => null, receiptForGrant: async () => null, refs: async () => [], logStep: async () => {},
    }
    await runAuditor({ session_id: '00000000-0000-4000-8000-000000000009' }, { db, reader, now: () => new Date('2026-10-26T18:00:00Z'), newId: () => 'r' })
    expect(order.slice(0, 2)).toEqual(['returns:start', 'delivery:start'])
    expect(order).toContain('returns:end')
  })
})

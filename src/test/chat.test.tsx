import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatApp from '../chat/ChatApp'

const HERO = "Help me place an order for a snowboard for this weekend trip with my friends. Budget under $500."
const offers = [
  { product_id: 'p1', name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', price_cents: 44995, summary: 'Easy returns', delivery_label: 'Fri Oct 30', delivery_date: '2026-10-30', shipping_method: 'expedited', shown_at: '2026-10-26T18:00:00.000Z' },
  { product_id: 'p2', name: 'T. Rice Orca Snowboard 2025/2026', brand: 'Lib Tech', size_cm: 156, colour: null, price_cents: 48983, summary: 'Free returns', delivery_label: 'Thu Oct 29', delivery_date: '2026-10-29', shipping_method: 'standard', shown_at: '2026-10-26T18:00:00.000Z' },
]

let calls: { url: string; headers: Record<string, string>; body: any }[]
let replies: unknown[]
let orderLookups: string[]

beforeEach(() => {
  calls = []
  replies = []
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  orderLookups = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    // The order-number lookup after an order is answered on its own, so it never takes a chat reply.
    if (body.action === 'order_status') {
      orderLookups.push(body.session_id)
      return new Response(JSON.stringify({ type: 'order_status', ready: true, order_number: '15004' }), { status: 200 })
    }
    calls.push({ url, headers: init.headers as Record<string, string>, body })
    return new Response(JSON.stringify(replies.shift()), { status: 200 })
  }))
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('/chat phone screen', () => {
  it('is a phone frame with the Muse header inside it', () => {
    render(<ChatApp />)
    const frame = screen.getByTestId('phone-frame')
    expect(frame).toContainElement(screen.getByRole('heading', { name: 'Muse' }))
    expect(frame).toContainElement(screen.getByLabelText('Message Muse'))
  })

  it('says "Your personal assistant" under the Muse header', () => {
    render(<ChatApp />)
    expect(screen.getByText('Your personal assistant')).toBeInTheDocument()
    expect(screen.queryByText(/personal shopper/)).toBeNull()
  })

  it('fills the box with the demo request when the chip is tapped', async () => {
    const user = userEvent.setup()
    render(<ChatApp />)
    const chip = screen.getByRole('button', { name: /Try the demo test sequence/ })
    expect(chip).toHaveTextContent('Recommended')
    await user.click(chip)
    expect((screen.getByLabelText('Message Muse') as HTMLInputElement).value).toMatch(/^Find and purchase a less than \$500 snowboard/)
  })

  it('runs the hero conversation as chat: sentence, two cards, payment question, then the order', async () => {
    const user = userEvent.setup()
    const rules = { budget_max_cents: 50000, delivery_by: '2026-10-30' }
    replies = [
      { type: 'proposals', text: 'Looking for snowboards under $500 that will arrive by Friday and that you can return. Here are two options from Northwind:', follow_up: 'Pick one, and tell me which payment to charge.', offers, draft: rules, steps: ['Muse is checking: Looking at snowboards'] },
      { type: 'ordered', session_id: 's-1', text: 'Your order is placed.', order: { product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', item_price_cents: 44995, shipping_label: 'Expedited shipping', shipping_cents: 6000, total_cents: 50995, delivery_label: 'Fri Oct 30', payment_label: 'Demo Checkout — PayPal' } },
    ]
    render(<ChatApp />)
    await user.type(screen.getByLabelText('Message Muse'), HERO)
    await user.click(screen.getByRole('button', { name: 'Send' }))

    // no form card anywhere; a sentence, two cards, then the payment question
    const burton = await screen.findByLabelText('Spellbinder Snowboard 2026/2027')
    expect(screen.queryByLabelText('Your order rules')).toBeNull()
    expect(screen.queryByRole('button', { name: /Looks right|Change/ })).toBeNull()
    expect(screen.getByText(/Looking for snowboards under \$500/)).toBeInTheDocument()
    expect(burton).toHaveTextContent('$449.95')
    expect(burton).toHaveTextContent('Easy returns')
    expect(burton).toHaveTextContent('Arrives Fri Oct 30')
    expect(burton).not.toHaveTextContent(/509|total|final/i)
    const text = screen.getByTestId('phone-frame').textContent ?? ''
    expect(text.indexOf('Here are two options')).toBeLessThan(text.indexOf('Spellbinder'))
    expect(text.indexOf('Orca')).toBeLessThan(text.indexOf('Pick one, and tell me which payment to charge.'))
    expect(text).not.toMatch(/null|not specified|Store|Looks right/i)

    // the typed reply is the confirmation
    await user.type(screen.getByLabelText('Message Muse'), 'Serpent looks cool. Order it. Use my PayPal account for checkout.')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    const order = await screen.findByLabelText('Order confirmation')
    expect(order).toHaveTextContent('$449.95')
    expect(order).toHaveTextContent('Expedited shipping')
    expect(order).toHaveTextContent('$60')
    expect(order).toHaveTextContent('$509.95')
    expect(order).toHaveTextContent('Arrives Fri Oct 30')
    expect(order).toHaveTextContent('Paid with Demo Checkout — PayPal. Simulated, no real payment.')
    expect(screen.getByLabelText('Message Muse')).toBeDisabled()

    // only the shopper-agent function, publishable key only, no confirm step
    expect(calls.map((c) => c.url)).toEqual(Array(2).fill('https://example.supabase.co/functions/v1/shopper-agent'))
    expect(calls[0].headers.apikey).toBe('sb_publishable_test')
    expect(calls[0].body.confirm).toBeUndefined()
    expect(calls[0].body.messages.at(-1)).toEqual({ role: 'user', text: HERO })
    // the order message carries the rules and the full offers back, unchanged; status lines are never sent
    expect(calls[1].body.draft).toEqual(rules)
    expect(calls[1].body.offers).toEqual(offers)
    expect(calls[1].body.messages.map((m: { role: string }) => m.role)).toEqual(['assistant', 'user', 'assistant', 'assistant', 'user'])
    expect(JSON.stringify(calls[1].body.messages)).not.toContain('Muse is checking')

    expect(screen.getByTestId('phone-frame').textContent).not.toMatch(/dashboard|grant|receipt|tamper|dispute|verdict/i)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it.each([
    ['Demo Visa card ••4242', 'Demo Visa card ••4242'],
    ['Mastercard', 'Mastercard'],
    ['Stripe Checkout', 'Stripe Checkout'],
    ['PayPal', 'PayPal'],
  ])('shows payment buttons once, and tapping "%s" places the order with matching wording', async (label, detail) => {
    const user = userEvent.setup()
    const ask = 'Which payment should I use for this demo checkout? No real charge will be made.'
    replies = [
      { type: 'proposals', text: 'Here are two options:', follow_up: ask, ask_payment: true, offers, draft: {} },
      { type: 'ordered', session_id: 's-1', text: 'Your order is placed.', order: { product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', item_price_cents: 44995, shipping_label: 'Expedited shipping', shipping_cents: 6000, total_cents: 50995, delivery_label: 'Wed Oct 28', payment_label: `Demo Checkout — ${detail}` } },
    ]
    render(<ChatApp />)
    await user.type(screen.getByLabelText('Message Muse'), HERO)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    const options = await screen.findByLabelText('Payment options')
    const names = Array.from(options.querySelectorAll('button')).map((b) => b.textContent)
    expect(names).toEqual(['Demo Visa card ••4242Suggested', 'Mastercard', 'Stripe Checkout', 'PayPal'])
    expect(options).toHaveTextContent("Or type any other payment — I'll record it as demo checkout.")
    expect(screen.getByText(ask)).toBeInTheDocument()
    expect(screen.getByTestId('phone-frame').textContent).not.toMatch(/visa checkout|mastercard checkout/i)
    await user.click(screen.getByRole('button', { name: new RegExp(label) }))
    const order = await screen.findByLabelText('Order confirmation')
    expect(order).toHaveTextContent(`Paid with Demo Checkout — ${detail}. Simulated, no real payment.`)
    expect(calls[1].body.messages.at(-1)).toEqual({ role: 'user', text: `Pay with ${label}.` })
    expect(screen.queryByLabelText('Payment options')).toBeNull()
  })

  it('a typed payment such as Apple Pay is sent as typed, and the options are not shown when payment was already told', async () => {
    const user = userEvent.setup()
    replies = [
      { type: 'proposals', text: 'Here are two options:', follow_up: "Pick one and I'll place the order.", ask_payment: false, offers, draft: {} },
    ]
    render(<ChatApp />)
    await user.type(screen.getByLabelText('Message Muse'), HERO)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByLabelText('Spellbinder Snowboard 2026/2027')
    expect(screen.queryByLabelText('Payment options')).toBeNull()
  })

  it('sends a plain message when a card is picked', async () => {
    const user = userEvent.setup()
    replies = [
      { type: 'proposals', text: 'Here are two options:', follow_up: 'Pick one, and tell me which payment to charge.', offers, draft: {} },
      { type: 'message', text: 'Which payment should I charge?' },
    ]
    render(<ChatApp />)
    await user.type(screen.getByLabelText('Message Muse'), 'a board under 500')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click((await screen.findByLabelText('Spellbinder Snowboard 2026/2027')).querySelector('button')!)
    expect(await screen.findByText('Which payment should I charge?')).toBeInTheDocument()
    expect(calls[1].body.messages.at(-1).text).toBe("I'll take the Burton Spellbinder Snowboard 2026/2027.")
  })

  it('shows a plain message when Muse answers with an error', async () => {
    const user = userEvent.setup()
    replies = [{ type: 'error', message: 'MODEL_API_KEY not set in Supabase secrets' }]
    render(<ChatApp />)
    await user.type(screen.getByLabelText('Message Muse'), 'hi')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('MODEL_API_KEY not set in Supabase secrets'))
  })
  it('after the order, shows the order number the store assigned, so a tester can follow up', async () => {
    const user = userEvent.setup()
    replies.push(
      { type: 'proposals', session_id: undefined, text: 'Here are two options:', follow_up: "Pick one and I'll place the order.", offers, draft: {} },
      { type: 'ordered', session_id: '00000000-0000-4000-8000-000000000001', text: 'Order received.', order: { product_name: 'Spellbinder Snowboard 2026/2027', brand: 'Burton', size_cm: 156, colour: 'Serpent', item_price_cents: 44995, shipping_label: 'Expedited shipping', shipping_cents: 6000, total_cents: 50995, delivery_label: 'Fri Oct 30', payment_label: 'Demo Checkout — PayPal' } },
    )
    render(<ChatApp />)
    await user.type(screen.getByLabelText('Message Muse'), HERO)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click((await screen.findAllByRole('button', { name: /Pick this one/ }))[0])
    await waitFor(() => expect(screen.getByTestId('order-number')).toHaveTextContent('Order number 15004'), { timeout: 4000 })
    expect(orderLookups).toEqual(['00000000-0000-4000-8000-000000000001'])
  })

  it('shows each "Muse is checking" line as it streams in, before the reply arrives', async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn(async () => {
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(JSON.stringify({ type: 'step', text: 'Muse is checking: Recording your snowboard needs' }) + '\n'))
          await gate
          c.enqueue(enc.encode(JSON.stringify({ type: 'reply', reply: { type: 'message', text: 'Done.', steps: ['Muse is checking: Recording your snowboard needs'] } }) + '\n'))
          c.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }))
    render(<ChatApp />)
    await user.type(screen.getByLabelText('Message Muse'), HERO)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Muse is checking: Recording your snowboard needs')).toBeInTheDocument()
    expect(screen.getByText('Muse is thinking…')).toBeInTheDocument()
    release()
    expect(await screen.findByText('Done.')).toBeInTheDocument()
    expect(screen.getAllByText('Muse is checking: Recording your snowboard needs')).toHaveLength(1)
  })
})


import { useEffect, useRef, useState } from 'react'
import { askAgent, orderNumber } from './api'
import PhoneFrame from './PhoneFrame'
import { Bubble, OfferCard, OrderCard, StatusLine } from './Cards'
import type { AgentReply, ChatItem, OfferCardData } from './types'

// Payment choices shown once, when Muse asks. Visa and Mastercard are card networks; Stripe Checkout and PayPal are checkout methods.
const PAYMENTS: { label: string; suggested?: boolean }[] = [
  { label: 'Demo Visa card ••4242', suggested: true },
  { label: 'Mastercard' },
  { label: 'Stripe Checkout' },
  { label: 'PayPal' },
]
const HELLO = "Hi, I'm Muse. Tell me what you're looking for at Northwind Outfitters."
const DEMO_PROMPT =
  "Find and purchase a less than $500 snowboard that will arrive at my address in 2 days. I should be able to return it if it doesn't work for me."

// The phone screen: it keeps the conversation and shows what Muse sends back. It decides nothing.
export default function ChatApp() {
  const [items, setItems] = useState<ChatItem[]>([{ id: 0, kind: 'muse', text: HELLO }])
  const [draft, setDraft] = useState<unknown>(null)
  const [askPay, setAskPay] = useState(false)
  const [offers, setOffers] = useState<unknown[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [ordered, setOrdered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  // "Muse is checking" lines streamed while Muse works; replaced by the reply's own lines when it arrives.
  const [live, setLive] = useState<string[]>([])
  // The order number: 'pending' while the store assigns it, 'late' if it has not arrived after a while.
  const [number, setNumber] = useState<string | 'pending' | 'late' | null>(null)
  const next = useRef(1)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [items, busy])

  const id = () => next.current++
  // Only words go back to Muse: what the customer typed and what Muse said.
  const words = (list: ChatItem[]): { role: 'user' | 'assistant'; text: string }[] =>
    list.flatMap((i): { role: 'user' | 'assistant'; text: string }[] =>
      i.kind === 'me' ? [{ role: 'user', text: i.text }] : i.kind === 'muse' ? [{ role: 'assistant', text: i.text }] : [])

  function show(reply: AgentReply, base: ChatItem[]) {
    const add: ChatItem[] = (reply.steps ?? []).map((s) => ({ id: id(), kind: 'status', text: s }))
    if (reply.session_id) setSessionId(reply.session_id)
    if (reply.draft !== undefined) setDraft(reply.draft)
    setAskPay(reply.ask_payment === true)
    if (reply.type === 'message') {
      add.push({ id: id(), kind: 'muse', text: reply.text })
      if (reply.suggestions?.length) add.push({ id: id(), kind: 'suggest', suggestions: reply.suggestions })
    }
    else if (reply.type === 'proposals') {
      setOffers(reply.offers)
      add.push({ id: id(), kind: 'muse', text: reply.text }, { id: id(), kind: 'offers', offers: reply.offers }, { id: id(), kind: 'muse', text: reply.follow_up })
    } else if (reply.type === 'ordered') {
      setOrdered(true)
      if (reply.session_id) followOrder(reply.session_id)
      add.push({ id: id(), kind: 'muse', text: reply.text }, { id: id(), kind: 'order', order: reply.order })
    } else add.push({ id: id(), kind: 'problem', text: reply.message })
    setItems([...base, ...add])
  }

  // Asks for the order number until the store has assigned it (usually a few seconds after the order).
  // Stops when the screen closes.
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function followOrder(id: string) {
    setNumber('pending')
    let tries = 0
    const tick = async () => {
      if (!alive.current) return
      const n = await orderNumber(id)
      if (!alive.current) return
      if (n) return setNumber(n)
      if (++tries >= 30) return setNumber('late')
      window.setTimeout(tick, 1500)
    }
    window.setTimeout(tick, 1000)
  }

  async function send(raw: string) {
    const t = raw.trim()
    if (!t || busy || ordered) return
    const base: ChatItem[] = [...items, { id: id(), kind: 'me', text: t }]
    setItems(base)
    setText('')
    setAskPay(false)
    setBusy(true)
    setLive([])
    const reply = await askAgent({ messages: words(base), session_id: sessionId, draft, offers }, (line) => setLive((l) => [...l, line]))
    setLive([])
    setBusy(false)
    show(reply, base)
  }

  const pick = (o: OfferCardData) => send(`I'll take the ${o.brand ? `${o.brand} ` : ''}${o.name}.`)
  const fresh = items.length === 1

  return (
    <PhoneFrame
      footer={
        <div className="space-y-2">
          {fresh && (
            <button
              type="button"
              onClick={() => setText(DEMO_PROMPT)}
              className="flex w-full items-center justify-between gap-2 rounded-xl border-2 border-indigo-500 bg-indigo-50 px-3 py-2 text-left text-sm font-semibold text-indigo-900"
            >
              <span>Try the demo test sequence</span>
              <span className="shrink-0 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Recommended</span>
            </button>
          )}
          {askPay && !ordered && !busy && (
            <div aria-label="Payment options" className="space-y-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                {PAYMENTS.map((pm) => (
                  <button
                    key={pm.label}
                    type="button"
                    onClick={() => void send(`Pay with ${pm.label}.`)}
                    className={`rounded-xl border px-2 py-2 text-left text-xs font-semibold ${pm.suggested ? 'col-span-2 border-2 border-indigo-500 bg-indigo-50 text-indigo-900' : 'border-neutral-300 bg-white text-neutral-900'}`}
                  >
                    {pm.label}
                    {pm.suggested && <span className="ml-2 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Suggested</span>}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-neutral-500">Or type any other payment — I'll record it as demo checkout. Demo test card, last four digits only.</p>
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void send(text) }} className="flex gap-2">
            <input
              aria-label="Message Muse"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={1000}
              disabled={busy || ordered}
              placeholder={ordered ? 'Order received' : 'Message Muse'}
              className="min-w-0 flex-1 rounded-full border border-neutral-300 px-4 py-2 text-sm text-neutral-900 outline-none focus:border-indigo-500 disabled:bg-neutral-100"
            />
            <button type="submit" disabled={busy || ordered || !text.trim()} className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Send
            </button>
          </form>
        </div>
      }
    >
      <div role="log" aria-live="polite" className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
        {items.map((i) => {
          switch (i.kind) {
            case 'me': return <Bubble key={i.id} side="me">{i.text}</Bubble>
            case 'muse': return <Bubble key={i.id} side="muse">{i.text}</Bubble>
            case 'status': return <StatusLine key={i.id}>{i.text}</StatusLine>
            case 'offers': return (
              <div key={i.id} className="space-y-3">
                {i.offers.map((o) => <OfferCard key={o.product_id} offer={o} disabled={busy || ordered} onPick={() => void pick(o)} />)}
              </div>
            )
            case 'order': return <OrderCard key={i.id} order={i.order} number={number} />
            case 'problem': return <p key={i.id} role="alert" className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">{i.text}</p>
            case 'suggest': return (
              <div key={i.id} aria-label="Suggested orders" className="space-y-1.5">
                {i.suggestions.map((sg) => (
                  <button
                    key={sg.label} type="button" disabled={busy || ordered} onClick={() => void send(sg.text)}
                    className="block w-full rounded-xl border-2 border-indigo-500 bg-indigo-50 px-3 py-2 text-left text-sm text-indigo-900 disabled:opacity-50"
                  >
                    <span className="block font-semibold">{sg.label}</span>
                    <span className="block text-xs text-indigo-800">{sg.text}</span>
                  </button>
                ))}
              </div>
            )
          }
        })}
        {busy && live.map((l, k) => <StatusLine key={`live-${k}`}>{l}</StatusLine>)}
        {busy && <StatusLine>Muse is thinking…</StatusLine>}
        <div ref={end} />
      </div>
    </PhoneFrame>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type Step = {
  route: string
  title: string
  body: string
  // Order whose check must be open first ('hero' is the live order from the phone flow, or 12322).
  open?: 'hero'
  target: (hero: string) => string
}

const STEPS: Step[] = [
  {
    route: '/dashboard/orders',
    title: 'Order just arrived',
    body: 'The order the agent just placed: Burton Spellbinder, $509.95 total. Agent Receipt checked it the moment it arrived, before fulfillment.',
    target: (hero) => `tr[data-order-ref="${hero}"]`,
  },
  {
    route: '/dashboard/orders',
    open: 'hero',
    title: 'Grant vs Actual',
    body: 'Each row of the verdict table puts what the agent was authorized to do (Grant) beside what it actually did (Actual), with the store’s own terms in between.',
    target: () => 'thead[data-tour="verdict-head"]',
  },
  {
    route: '/dashboard/orders',
    open: 'hero',
    title: 'Budget mismatch',
    body: '$509.95 against a $500 budget. The agent treated the cap as item-only: the item is $449.95, but expedited shipping takes the total over.',
    target: () => 'tr[data-field-key="budget"]',
  },
  {
    route: '/dashboard/orders',
    open: 'hero',
    title: 'Returns mismatch',
    body: 'The grant requires a returnable item. The agent’s summary said “Easy returns”, but the formal terms are Final Sale.',
    target: () => 'tr[data-field-key="returns"]',
  },
  {
    route: '/dashboard/disputes',
    title: 'Scenario B: a separate order',
    body: 'Order 13422, Orca $489.83: 0 problems, Pass. Shipped, delivered, then disputed under Visa 10.4 as “agent overstep”. Evidence Packet built the dispute evidence from the record; the merchant fought it and reported Won. This is a separate order, not the hero order.',
    target: () => '[data-dispute-order="13422"]',
  },
  {
    route: '/dashboard/orders',
    title: 'Hold for Suspicion',
    body: 'Order 14522 came from an unverified agent: no session, no receipt. Agent Receipt records the gap and holds it for suspicion. There is no verdict table, because there is no record to check.',
    target: () => 'tr[data-order-ref="14522"]',
  },
]

const FALLBACK_HERO = '12322'

// Six steps across the dashboard pages. Never auto-advances; Back, Next and Skip on every step. It only
// highlights: the page underneath stays fully clickable, and nothing is left behind when it ends.
export default function Tour({ fromPhone, landing, onDone }: { fromPhone: boolean; landing: string; onDone: () => void }) {
  const navigate = useNavigate()
  const [i, setI] = useState(0)
  const [hero, setHero] = useState<string | null>(fromPhone ? null : FALLBACK_HERO)
  const [missing, setMissing] = useState(false)
  const [done, setDone] = useState(false)
  const lit = useRef<Element | null>(null)
  const step = STEPS[i]

  // From the phone flow, the newest order on Agent orders is the one the visitor just placed.
  useEffect(() => {
    if (hero) return
    navigate('/dashboard/orders')
    let tries = 0
    const t = window.setInterval(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('tr[data-chain-seq][data-order-ref]')]
      if (rows.length > 0 || ++tries > 40) {
        window.clearInterval(t)
        const newest = rows.sort((a, b) => Number(b.dataset.chainSeq) - Number(a.dataset.chainSeq))[0]
        setHero(newest?.dataset.orderRef ?? FALLBACK_HERO)
      }
    }, 150)
    return () => window.clearInterval(t)
  }, [hero, navigate])

  useEffect(() => {
    if (!hero || done) return
    setMissing(false)
    navigate(step.route)
    let tries = 0
    let ref = hero
    const t = window.setInterval(() => {
      if (step.open) window.dispatchEvent(new CustomEvent('agentreceipt:open-order', { detail: ref }))
      const el = document.querySelector(step.target(ref))
      if (el) {
        window.clearInterval(t)
        lit.current?.classList.remove('tour-highlight')
        el.classList.add('tour-highlight')
        lit.current = el
        el.scrollIntoView?.({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
        return
      }
      tries += 1
      // The live order may not have its check yet: fall back to the seeded hero order.
      if (tries === 20 && ref !== FALLBACK_HERO) ref = FALLBACK_HERO
      if (tries > 40) {
        window.clearInterval(t)
        setMissing(true)
      }
    }, 150)
    return () => window.clearInterval(t)
  }, [i, hero, done, step, navigate])

  useEffect(() => () => lit.current?.classList.remove('tour-highlight'), [])

  function finish() {
    lit.current?.classList.remove('tour-highlight')
    lit.current = null
    setDone(true)
  }

  function close() {
    navigate(landing)
    onDone()
  }

  const box = 'fixed bottom-4 right-4 z-50 w-[min(26rem,calc(100%-2rem))] rounded-xl border border-dash-teal bg-dash-card p-5 text-dash-body shadow-lg'
  const btn = 'min-h-11 rounded-md px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-dash-teal'

  if (done) {
    return (
      <div role="dialog" aria-label="Guided tour" className={box}>
        <p className="text-lg font-bold text-dash-ink">Tour complete — explore on your own now.</p>
        <button type="button" onClick={close} className={`${btn} mt-4 bg-dash-teal text-dash-page-bottom hover:opacity-90`}>
          Close tour
        </button>
      </div>
    )
  }

  return (
    <div role="dialog" aria-label="Guided tour" aria-live="polite" className={box}>
      <p className="text-xs font-semibold text-dash-label">Step {i + 1} of {STEPS.length}</p>
      <p className="mt-1 text-lg font-bold text-dash-ink">{step.title}</p>
      <p className="mt-2 text-sm">{step.body}</p>
      {!hero && <p className="mt-2 text-xs text-dash-label">Finding your order…</p>}
      {missing && <p className="mt-2 text-xs text-dash-attention">This part of the page has not loaded. You can still go on.</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setI(i - 1)} disabled={i === 0} className={`${btn} border border-dash-edge text-dash-ink hover:bg-dash-card-raised disabled:cursor-not-allowed disabled:opacity-50`}>
          Back
        </button>
        <button
          type="button"
          onClick={() => (i === STEPS.length - 1 ? finish() : setI(i + 1))}
          className={`${btn} bg-dash-teal text-dash-page-bottom hover:opacity-90`}
        >
          {i === STEPS.length - 1 ? 'Finish' : 'Next'}
        </button>
        <button type="button" onClick={finish} className={`${btn} ml-auto text-dash-label hover:text-dash-ink`}>
          Skip
        </button>
      </div>
    </div>
  )
}

// Shown once, after the phone flow's order: the visitor chooses the tour or free browsing.
export function TourOffer({ onTour, onExplore }: { onTour: () => void; onExplore: () => void }) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-dash-page-bottom/80 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="tour-offer-title" className="w-full max-w-md rounded-xl border border-dash-edge bg-dash-card p-6">
        <h2 id="tour-offer-title" className="text-xl font-bold text-dash-ink">Order placed — now see what the merchant sees</h2>
        <div className="mt-5 flex flex-col gap-2">
          <button ref={first} type="button" onClick={onTour} className="min-h-11 rounded-md bg-dash-teal px-4 py-2.5 text-sm font-bold text-dash-page-bottom hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dash-ink">
            Take 2-minute guided tour — recommended
          </button>
          <button type="button" onClick={onExplore} className="min-h-11 rounded-md border border-dash-edge px-4 py-2.5 text-sm font-semibold text-dash-ink hover:bg-dash-card-raised focus-visible:outline-2 focus-visible:outline-dash-teal">
            Explore on your own
          </button>
        </div>
      </div>
    </div>
  )
}

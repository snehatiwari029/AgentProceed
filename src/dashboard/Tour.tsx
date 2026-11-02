import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type Step = {
  route: string
  title: string
  body: string
  // Opened before the spotlight: the hero order's check (Agent Receipt) or dispute 13422's packet (Agent Dispute).
  open?: 'hero-order' | 'dispute-13422'
  target: string
}

// Five stops, one per feature, in this order. Each: a bold title and one line. Stops 4 and 5 are the two listing tools.
export const STEPS: Step[] = [
  {
    route: '/dashboard',
    title: 'Agent activity',
    body: 'Watch in which stage are their agents and agent receipt verdict of each agent trying to checkout.',
    target: '[data-tour="activity-card"]',
  },
  {
    route: '/dashboard/orders',
    open: 'hero-order',
    title: 'Agent Receipt',
    body: 'Every agent order checked against what the shopper granted, with a hash-sealed receipt and a Pass, Review required, or Hold for suspicion verdict.',
    target: '[data-tour="receipt-page"]',
  },
  {
    route: '/dashboard/disputes',
    open: 'dispute-13422',
    title: 'Agent Dispute',
    body: 'Disputed agent orders become processor-ready evidence packets, with only the missing details left for you to fill.',
    target: '[data-testid="evidence-pack"]',
  },
  {
    route: '/dashboard/optimization',
    title: 'Agent Optimize',
    body: 'Listings reviewed against five pillars, with suggested fixes you approve.',
    target: '[data-tour="pillars"]',
  },
  {
    route: '/dashboard/optimization',
    title: 'Read as Agent',
    body: 'A read-test showing how an agent reads each listing, beside your formal terms.',
    target: '[data-testid="agent-read-test"]',
  },
]

const FALLBACK_HERO = '12322'
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// The spotlight follows its element (scroll, resize, late layout) and is clamped to the viewport.
function Spotlight({ el }: { el: Element }) {
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const r = el.getBoundingClientRect()
      const pad = 8
      const top = Math.max(r.top - pad, 4)
      const left = Math.max(r.left - pad, 4)
      const bottom = Math.min(r.bottom + pad, window.innerHeight - 4)
      const right = Math.min(r.right + pad, window.innerWidth - 4)
      setBox((b) => (b && b.top === top && b.left === left && b.width === right - left && b.height === bottom - top ? b : { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) }))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [el])
  if (!box) return null
  return <div className="tour-spotlight" style={box} data-testid="tour-spotlight" aria-hidden="true" />
}

// Started only from the Start tour button (or the one-time offer after the phone flow). Never auto-advances.
// It dims the page except the feature and only reads the page: nothing is written, and nothing is left behind.
export default function Tour({ fromPhone, landing, onDone }: { fromPhone: boolean; landing: string; onDone: () => void }) {
  const navigate = useNavigate()
  const [i, setI] = useState(0)
  const [hero, setHero] = useState<string | null>(fromPhone ? null : FALLBACK_HERO)
  const [missing, setMissing] = useState(false)
  const [lit, setLit] = useState<Element | null>(null)
  const step = STEPS[i]
  const last = i === STEPS.length - 1
  const first = useRef<HTMLButtonElement>(null)

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
    if (!hero) return
    setMissing(false)
    setLit(null)
    navigate(step.route)
    let tries = 0
    let ref = hero
    const settle: number[] = []
    const t = window.setInterval(() => {
      if (step.open === 'hero-order') window.dispatchEvent(new CustomEvent('agentreceipt:open-order', { detail: ref }))
      if (step.open === 'dispute-13422') window.dispatchEvent(new CustomEvent('agentreceipt:open-dispute', { detail: '13422' }))
      const el = document.querySelector(step.target)
      // Agent Receipt: wait until the order's check is open, so the spotlight covers the list and the receipt detail.
      const ready = el && (step.open !== 'hero-order' || el.querySelector('[data-tour="verdict-head"]') || tries > 20)
      if (el && ready) {
        window.clearInterval(t)
        el.scrollIntoView?.({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' })
        setLit(el)
        // Content above may still be loading (the packet appears after its chain check): bring the feature back into view.
        for (const ms of [700, 1600, 3000]) {
          settle.push(window.setTimeout(() => {
            const r = el.getBoundingClientRect()
            if (r.top > window.innerHeight * 0.5 || r.bottom < 80) el.scrollIntoView?.({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' })
          }, ms))
        }
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
    return () => {
      window.clearInterval(t)
      settle.forEach((x) => window.clearTimeout(x))
    }
  }, [i, hero, step, navigate])

  useEffect(() => { first.current?.focus() }, [i])

  function close() {
    setLit(null)
    navigate(landing)
    onDone()
  }

  const btn = 'min-h-11 rounded-full px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-dash-teal'

  return (
    <>
      {lit && <Spotlight el={lit} />}
      <div
        role="dialog"
        aria-label="Guided tour"
        aria-live="polite"
        className="dash-glass fixed bottom-4 right-4 z-50 w-[min(28rem,calc(100%-2rem))] rounded-2xl bg-dash-page-top/95 p-5 text-dash-body"
      >
        <p className="text-xs font-semibold text-dash-label">Stop {i + 1} of {STEPS.length}</p>
        <p className="mt-2 text-base text-dash-body" data-testid="tour-text">
          <strong className="font-bold text-dash-ink">{step.title}:</strong> {step.body}
        </p>
        {!hero && <p className="mt-2 text-xs text-dash-label">Finding your order…</p>}
        {missing && <p className="mt-2 text-xs text-dash-attention">This part of the page has not loaded. You can still go on.</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setI(i - 1)} disabled={i === 0} className={`${btn} border border-dash-edge text-dash-ink hover:bg-dash-card-raised disabled:cursor-not-allowed disabled:opacity-50`}>
            Back
          </button>
          {last ? (
            <button ref={first} type="button" onClick={close} className={`${btn} bg-dash-teal text-dash-page-bottom hover:opacity-90`}>
              Done
            </button>
          ) : (
            <button ref={first} type="button" onClick={() => setI(i + 1)} className={`${btn} bg-dash-teal text-dash-page-bottom hover:opacity-90`}>
              Next
            </button>
          )}
          {!last && (
            <button type="button" onClick={close} className={`${btn} ml-auto text-dash-label hover:text-dash-ink`}>
              Skip
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// Shown once, after the phone flow's order: the visitor chooses the tour or free browsing.
export function TourOffer({ onTour, onExplore }: { onTour: () => void; onExplore: () => void }) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-dash-page-bottom/80 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="tour-offer-title" className="dash-glass w-full max-w-md rounded-2xl bg-dash-page-top/95 p-6">
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

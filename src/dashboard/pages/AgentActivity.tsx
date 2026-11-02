import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AgentAction, Grant, Proposal, Receipt } from '../../shared/schemas'
import { type Rows } from '../data'
import { supabase } from '../../shared/supabase'
import { MERCHANT_NAME } from '../disputes'
import { buildPositions, summary, ZONES, type ActivitySession, type AgentPosition, type Zone } from '../activity'
import { Card, Live, PageTitle } from '../components/Panel'
import { DecisionBadge } from '../components/Badges'

// Read-only. This page never writes, approves, scans or edits, and makes no model calls. It re-reads the same tables
// Agent orders reads, every POLL_MS, so an icon moves only when a stored record changes.
export const POLL_MS = 20_000

// The storefront artwork is a build-time Muse Image asset (scripts/generate-store-art.ts, candidate 3 in
// public/store-art/manifest.json). It carries no text; zone labels are the HTML overlays below.
const STORE_ART: string | null = '/store-art/candidate-3.webp'

// Zone boxes on the map, in percent of the map area, placed over the rooms of the isometric artwork (1920x1280, drawn
// with background-size: cover in a 16:10 box, so about 3% is cropped from its top and bottom). The artwork's checkout
// queue rails stand in the cart room (about x 51-63%, y 61-73%), so the checkout box sits on the rails and the cart box
// stops short of them. Labels are HTML, never part of the image.
const LAYOUT: Record<Zone, { left: number; top: number; width: number; height: number }> = {
  browse: { left: 14.5, top: 30, width: 28, height: 25 },
  displays: { left: 44, top: 15, width: 25.5, height: 21.5 },
  cart: { left: 29, top: 57, width: 21, height: 24 },
  checkout: { left: 50.5, top: 54, width: 17, height: 26 },
}

// Above this many icons in one zone, icons are drawn smaller so a full checkout line still fits on the rails.
const DENSE = 4

function usePoll(ms: number): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setN((x) => x + 1), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return n
}

type Db = NonNullable<typeof supabase>
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>

async function read<T>(q: Res): Promise<T[]> {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as T[]
}

// Scoped to the demo merchant in the queries themselves: the merchant is looked up by name, then only its sessions,
// the grants on those sessions, the proposals and actions on those grants, and its own receipts are read. This is
// query-level filtering for the demo merchant only. It is not row-level security: no RLS policy restricts these tables
// per merchant. buildPositions filters again by merchant as a second check.
export async function readActivity(db: Db, merchantName: string = MERCHANT_NAME): Promise<AgentPosition[]> {
  const [merchant] = await read<{ id: string; name: string }>(db.from('merchants').select('id,name').eq('name', merchantName))
  if (!merchant) return []
  const sessions = await read<ActivitySession>(
    db.from('sessions').select('*').eq('merchant_id', merchant.id).order('opened_at', { ascending: true }),
  )
  if (sessions.length === 0) return []
  const grants = await read<Grant>(
    db.from('grants').select('*').in('session_id', sessions.map((s) => s.id)).order('chain_seq', { ascending: true }),
  )
  const grantIds = grants.map((g) => g.id)
  const [proposals, actions, receipts] =
    grantIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          read<Proposal>(db.from('proposals').select('*').in('grant_id', grantIds).order('chain_seq', { ascending: true })),
          read<AgentAction>(db.from('actions').select('*').in('grant_id', grantIds).order('chain_seq', { ascending: true })),
          read<Receipt>(
            db.from('receipts').select('*').eq('merchant_id', merchant.id).in('grant_id', grantIds).order('chain_seq', { ascending: true }),
          ),
        ])
  return buildPositions(merchant.id, sessions, grants, proposals, actions, receipts)
}

// Re-reads every POLL_MS. Keeps the last good rows while a read is in flight, so the map never blanks between reads.
function useActivity(): Rows<AgentPosition> {
  const tick = usePoll(POLL_MS)
  const [state, setState] = useState<Rows<AgentPosition>>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    if (!supabase) {
      setState({ status: 'error', message: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.' })
      return
    }
    readActivity(supabase).then(
      (rows) => !cancelled && setState({ status: 'ready', rows }),
      (err: unknown) => !cancelled && setState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' }),
    )
    return () => {
      cancelled = true
    }
  }, [tick])
  return state
}

// One glyph for every agent. Stage is the zone; verdict is the badge.
export function BotIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3" />
      <circle cx="12" cy="2.5" r="0.6" fill="currentColor" />
      <rect x="4.5" y="6" width="15" height="12" rx="3" />
      <circle cx="9.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="14.5" cy="12" r="1.2" fill="currentColor" />
      <path d="M9.5 15.5h5M2.5 11v3M21.5 11v3" />
    </svg>
  )
}

const BADGE_RING: Record<string, string> = {
  pass: 'bg-dash-teal',
  review_required: 'bg-dash-attention',
  hold_suspicion: 'bg-dash-violation',
}

const time = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function AgentActivity() {
  const state = useActivity()
  return (
    <div>
      <PageTitle title="Agent activity">
        Which stage each agent session has reached, read from its session, grant, proposal, action and receipt records and
        drawn as a place in a stylized store. It shows pipeline stage, not live browsing. Read-only. Demo store: this is
        simulated agent traffic for {MERCHANT_NAME} only, and the verified-agent signal is simulated.
      </PageTitle>
      <Live state={state}>{(rows) => <ActivityView positions={rows} />}</Live>
    </div>
  )
}

export function ActivityView({ positions }: { positions: AgentPosition[] }) {
  const navigate = useNavigate()
  // A short pulse when a session's zone changes between reads. No other motion.
  const seen = useRef(new Map<string, Zone>())
  const [pulse, setPulse] = useState<Set<string>>(new Set())
  useEffect(() => {
    const changed = new Set<string>()
    for (const p of positions) {
      const before = seen.current.get(p.session_id)
      if (before && before !== p.zone) changed.add(p.session_id)
      seen.current.set(p.session_id, p.zone)
    }
    if (changed.size === 0) return
    setPulse(changed)
    const t = window.setTimeout(() => setPulse(new Set()), 1200)
    return () => window.clearTimeout(t)
  }, [positions])

  // Opens the existing Agent orders row (its check, when a receipt exists). No new detail page.
  const openOrder = (p: AgentPosition) => navigate('/dashboard/orders', { state: p.receipt_id ? { openKey: p.receipt_id } : null })

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card label="Store map">
        <div
          data-testid="store-map"
          className="relative w-full overflow-hidden rounded-lg border border-dash-edge bg-dash-page-bottom"
          style={{
            aspectRatio: '16 / 10',
            minHeight: '18rem',
            backgroundImage: STORE_ART ? `url(${STORE_ART})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        >
          {ZONES.map((z) => {
            const box = LAYOUT[z.id]
            const here = positions.filter((p) => p.zone === z.id)
            return (
              <section
                key={z.id}
                data-zone={z.id}
                aria-label={`${z.label}: ${here.length}`}
                className="absolute flex flex-col rounded-md border border-dashed border-dash-edge bg-dash-card/60 p-2"
                style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
              >
                <p className="text-xs font-semibold uppercase tracking-wider text-dash-label">
                  {z.label} <span className="text-dash-body">({here.length})</span>
                </p>
                <ul className="mt-1 flex flex-wrap content-start gap-1.5 overflow-auto">
                  {here.map((p) => (
                    <li
                      key={p.session_id}
                      data-agent-icon={p.session_id}
                      title={`${p.agent}: ${p.stage}`}
                      className={`relative rounded-md border border-dash-edge bg-dash-card-raised ${here.length > DENSE ? 'p-0.5' : 'p-1'} text-dash-teal ${pulse.has(p.session_id) ? 'agent-pulse' : ''}`}
                    >
                      <BotIcon size={here.length > DENSE ? 16 : 22} />
                      <span className="sr-only">{`${p.agent}, ${p.stage}`}</span>
                      {p.decision && (
                        <span
                          data-verdict={p.decision}
                          className={`absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full ring-2 ring-dash-card ${BADGE_RING[p.decision]}`}
                          aria-hidden="true"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-dash-label">Stylized store layout.</p>
        <p className="mt-1 text-xs text-dash-label" data-testid="stage-legend">
          Each zone is a record stage. Entrance and browse aisles: session opened, no grant yet. Product displays: grant
          recorded. Cart area: proposal presented. Checkout line: order placed, or verdict issued.
        </p>
        <p className="mt-1 text-xs text-dash-label">
          Not the merchant's floorplan or a camera view. Icons move only when a stored record changes; the map refreshes every{' '}
          {POLL_MS / 1000} seconds.
        </p>
      </Card>

      <Card label="Agents in store">
        <p className="text-sm font-semibold text-dash-ink" role="status" data-testid="activity-summary">
          {summary(positions)}
        </p>
        {positions.length > 0 && (
          <ul className="mt-3 divide-y divide-dash-edge">
            {positions.map((p) => {
              const body = (
                <>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold text-dash-ink">{p.agent}</span>
                    <span className="shrink-0 whitespace-nowrap">
                      {p.decision ? <DecisionBadge value={p.decision} /> : p.verdict_issued ? <DecisionBadge value={null} /> : null}
                    </span>
                  </span>
                  <span className="mt-1 block text-dash-body">
                    {ZONES.find((z) => z.id === p.zone)?.label}: {p.stage}
                  </span>
                  <span className="mt-1 block text-xs text-dash-label">
                    Order {p.order ?? '–'} · Updated {time(p.updated_at)}
                  </span>
                </>
              )
              return (
                <li key={p.session_id} data-agent-row={p.session_id} className="py-2 text-sm">
                  {p.order || p.receipt_id ? (
                    <button
                      type="button"
                      onClick={() => openOrder(p)}
                      className="block w-full rounded-md px-2 py-1 text-left hover:bg-dash-card-raised"
                      aria-label={`${p.agent}, order ${p.order ?? 'without a number'}, open in Agent orders`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="px-2 py-1">{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}

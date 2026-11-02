import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Dispute, DisputeEvent, Shipment } from '../../shared/schemas'
import { useProducts } from '../../shared/useProducts'
import { useRows, type Rows } from '../data'
import { MERCHANT_NAME } from '../disputes'
import type { Scan, Suggestion } from '../optimizer'
import { DecisionBadge } from '../components/Badges'
import { ActivityView, useActivity } from './AgentActivity'
import { needsAttention, useAgentOrders, type OrderRow } from './AgentOrders'

// Dashboard home: a 2x2 grid. Top left: Agent activity map (the standout lavender card). Top right: store information.
// Bottom left: orders requiring attention. Bottom right: the three action boxes.
// Store Health, Profit and Agent-driven profit are demo values and say so. Everything else is read live; the one count
// with no live source (Returns / Refunds) is labelled Demo.

const GLASS = 'dash-glass rounded-2xl p-5'
const LABEL = 'text-xs font-semibold uppercase tracking-widest text-dash-label'
const FINAL: DisputeEvent['event_type'][] = ['outcome_won', 'outcome_lost', 'outcome_conceded', 'conceded']

type Count = number | 'loading' | 'error'
const countOf = <T,>(s: Rows<T>, f: (rows: T[]) => number): Count => (s.status === 'ready' ? f(s.rows) : s.status)

function Tag({ kind }: { kind: 'demo' | 'live' }) {
  return kind === 'demo' ? (
    <span className="ml-2 rounded-full border border-dash-attention/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-dash-attention" data-tag="demo">Demo</span>
  ) : (
    <span className="ml-2 rounded-full border border-dash-teal/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-dash-teal" data-tag="live">Live</span>
  )
}

function N({ v }: { v: Count }) {
  if (v === 'loading') return <span className="text-sm font-normal text-dash-label">Loading…</span>
  if (v === 'error') return <span className="text-sm font-normal text-dash-violation">Could not load</span>
  return <>{v}</>
}

export default function Home() {
  const products = useProducts()
  const orders = useAgentOrders()
  const shipments = useRows<Shipment>('shipments', 'chain_seq', true)
  const disputes = useRows<Dispute>('disputes', 'opened_at', true)
  const events = useRows<DisputeEvent>('dispute_events', 'chain_seq', true)
  const merchants = useRows<{ id: string; name: string }>('merchants', 'name', true)
  const scans = useRows<Scan>('optimizer_scans', 'scanned_at', false)
  const suggestions = useRows<Suggestion>('optimizer_suggestions', 'category', true)

  const attention = countOf(orders, (rows) => rows.filter(needsAttention).length)
  // Order status breakdown, from each order's own receipt and shipment records:
  // Completed = delivered (a shipment record with a delivery date); Fulfilment = cleared to ship and not delivered;
  // Received = held at order received for review, or arrived with no receipt (gap).
  const breakdown = (pick: (o: OrderRow, delivered: Set<string>) => boolean): Count => {
    if (orders.status === 'error' || shipments.status === 'error') return 'error'
    if (orders.status !== 'ready' || shipments.status !== 'ready') return 'loading'
    const delivered = new Set(shipments.rows.filter((x) => x.delivered_on).map((x) => x.receipt_id))
    return orders.rows.filter((o) => pick(o, delivered)).length
  }
  const completed = breakdown((o, d) => !!o.receipt && d.has(o.receipt.id))
  const fulfilment = breakdown((o, d) => !!o.receipt && o.receipt.fulfillment !== 'held' && !d.has(o.receipt.id))
  const received = breakdown((o) => !o.receipt || o.receipt.fulfillment === 'held')
  const chargebacks = countOf(disputes, (rows) => rows.length)
  // Disputes still needing the merchant: no final outcome recorded yet.
  const openDisputes: Count = disputes.status === 'ready' && events.status === 'ready'
    ? disputes.rows.filter((d) => !events.rows.some((e) => e.dispute_id === d.id && FINAL.includes(e.event_type))).length
    : disputes.status === 'error' || events.status === 'error' ? 'error' : 'loading'
  // Pending listing suggestions for the listings in the latest scan (the count the Optimization page works from).
  const pendingListings: Count = (() => {
    if ([merchants, scans, suggestions].some((s) => s.status === 'error')) return 'error'
    if (merchants.status !== 'ready' || scans.status !== 'ready' || suggestions.status !== 'ready') return 'loading'
    const m = merchants.rows.find((x) => x.name === MERCHANT_NAME)
    const scan = m && scans.rows.find((x) => x.merchant_id === m.id)
    if (!m || !scan) return 0
    const listed = new Set(scan.results.map((r) => r.product_id))
    return suggestions.rows.filter((s) => s.merchant_id === m.id && listed.has(s.product_id) && s.status === 'pending').length
  })()

  return (
    <div>
      <h1 className="sr-only">Dashboard</h1>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <ActivityCard />
        <InfoCard
          rows={[
            { label: 'Store Health', value: <>86<span className="text-sm font-normal opacity-70">/100</span></>, tag: 'demo', testid: 'stat-store-health' },
            { label: 'Profit', value: '$18,400', tag: 'demo', testid: 'stat-profit' },
            { label: 'Agent-driven profit', value: <>$7,920 <span className="text-sm font-normal opacity-70">(43%)</span></>, tag: 'demo', testid: 'stat-agent-profit' },
            { label: 'Total Agent orders', value: <N v={countOf(orders, (r) => r.length)} />, tag: 'live', testid: 'stat-total-orders', strong: true },
            { label: 'Completed', value: <N v={completed} />, tag: 'live', testid: 'stat-completed', sub: true },
            { label: 'Fulfilment', value: <N v={fulfilment} />, tag: 'live', testid: 'stat-fulfilment', sub: true },
            { label: 'Received', value: <N v={received} />, tag: 'live', testid: 'stat-received', sub: true },
            { label: 'Returns / Refunds', value: '0', tag: 'demo', testid: 'stat-returns', sub: true },
            { label: 'Chargebacks', value: <N v={chargebacks} />, tag: 'live', testid: 'stat-chargebacks', sub: true },
            {
              label: 'Catalog',
              value: products.status === 'ready' ? <>{products.products.length} <span className="text-sm font-normal opacity-70">products in the store</span></> : <N v={products.status} />,
              tag: 'live', testid: 'stat-catalog',
            },
          ]}
        />
        <AttentionCard orders={orders} attention={attention} />
        <section className="grid gap-4" aria-label="Actions" data-tour="action-boxes">
          <ActionBox to="/dashboard/orders" title="Order discrepancies" note="Orders flagged Review Required or Hold for Suspicion" count={attention} testid="action-orders" />
          <ActionBox to="/dashboard/optimization" title="Listings optimization" note="Listing suggestions pending your decision (latest scan)" count={pendingListings} testid="action-listings" />
          <ActionBox to="/dashboard/disputes" title="Agent dispute" note="Disputes with no outcome recorded yet" count={openDisputes} testid="action-disputes" />
        </section>
      </div>
      <p className="mt-4 text-xs text-dash-label">
        Store Health, Profit, Agent-driven profit and Returns / Refunds are demo values. Every other figure is read live from
        the store's records.
      </p>
    </div>
  )
}

function ActivityCard() {
  const state = useActivity()
  return (
    <section className="dash-standout rounded-2xl p-5" aria-label="Agent activity" data-tour="activity-card" data-testid="activity-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-dash-navy">Agent activity</h2>
        <Link to="/dashboard/activity" className="text-sm font-semibold text-dash-purple hover:underline">Full view</Link>
      </div>
      <p className="mt-1 text-xs text-dash-navy/80" data-testid="activity-simulated">
        Pipeline stage of each agent session, not live browsing. Simulated agent traffic for {MERCHANT_NAME} only; the
        verified-agent signal is simulated.
      </p>
      <div className="mt-3">
        {state.status === 'loading' && <p role="status" className="text-sm text-dash-navy">Loading…</p>}
        {state.status === 'error' && <p role="alert" className="break-words text-sm text-dash-navy">Could not load: {state.message}</p>}
        {state.status === 'ready' && <ActivityView positions={state.rows} embedded />}
      </div>
    </section>
  )
}

type InfoRow = { label: string; value: ReactNode; tag: 'demo' | 'live'; testid: string; sub?: boolean; strong?: boolean }

function InfoCard({ rows }: { rows: InfoRow[] }) {
  return (
    <section className={GLASS} aria-label="Store information">
      <h2 className="text-lg font-bold text-dash-ink">Store information</h2>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} data-testid={r.testid} className="border-b border-dash-edge last:border-0">
              <th scope="row" className={`py-2.5 text-left font-medium ${r.sub ? 'pl-5 text-dash-label' : 'text-dash-body'}`}>{r.label}</th>
              <td className={`py-2.5 text-right ${r.sub ? 'text-base' : 'text-xl'} font-bold text-dash-ink`}>
                {r.value}
                <Tag kind={r.tag} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function AttentionCard({ orders, attention }: { orders: Rows<OrderRow>; attention: Count }) {
  const navigate = useNavigate()
  const flagged = orders.status === 'ready' ? orders.rows.filter(needsAttention) : []
  return (
    <section className={GLASS} aria-label="Orders requiring attention">
      <Link
        to="/dashboard/orders"
        className="block rounded-xl hover:bg-dash-card-raised"
        data-testid="stat-attention"
        aria-label="Orders requiring attention, open Agent Receipt"
      >
        <span className={`${LABEL} block`}>Orders requiring attention</span>
        <span className="mt-1 block text-3xl font-bold text-dash-attention"><N v={attention} /></span>
        <span className="mt-1 block text-xs text-dash-label">Review Required + Hold for Suspicion · live from Agent orders</span>
      </Link>
      {flagged.length > 0 && (
        <ul className="mt-3 divide-y divide-dash-edge" data-testid="attention-list">
          {flagged.map((o) => (
            <li key={o.key}>
              <button
                type="button"
                onClick={() => navigate('/dashboard/orders', { state: o.receipt ? { openKey: o.receipt.id } : null })}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-dash-card-raised"
                aria-label={`Order ${o.order ?? 'without a number'}, open in Agent Receipt`}
              >
                <span className="min-w-0">
                  <span className="block font-semibold text-dash-ink">Order {o.order ?? '–'}</span>
                  <span className="block truncate text-xs text-dash-label">{o.agent}</span>
                </span>
                <span className="shrink-0"><DecisionBadge value={o.decision} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ActionBox({ to, title, note, count, testid }: { to: string; title: string; note: string; count: Count; testid: string }) {
  return (
    <Link to={to} className={`${GLASS} flex items-center justify-between gap-4 hover:bg-dash-card-raised`} data-testid={testid}>
      <span className="min-w-0">
        <span className="block text-base font-bold text-dash-ink">{title}</span>
        <span className="mt-1 block text-xs text-dash-label">{note}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="text-3xl font-bold text-dash-teal"><N v={count} /></span>
        <span aria-hidden="true" className="text-dash-teal">→</span>
      </span>
    </Link>
  )
}

import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { Decision, Dispute, DisputeEvent, Grant, MismatchResult, Receipt } from '../../shared/schemas'
import { formatMoney } from '../../shared/format'
import { num, str, useRows, type Rows } from '../data'
import { disputeStatus } from '../status'
import { Card, Empty, Live, PageTitle } from '../components/Panel'
import { DecisionBadge } from '../components/Badges'
import VerdictTable from '../components/VerdictTable'
import MerchantActions from '../components/MerchantActions'

type Session = {
  id: string
  detection_source: string
  agent_id: string | null
  agent_verified: boolean
  gap_note: string | null
  opened_at: string
}

export type OrderRow = {
  key: string
  order: string | null
  receipt: Receipt | null
  customer: string
  agent: string
  status: string
  total_cents: number | null
  dispute: string | null
  decision: Decision | null
}

// Orders requiring attention = Review Required + Hold for Suspicion. A dispute is not needed to be flagged.
export const needsAttention = (o: { decision: Decision | null }) => o.decision === 'review_required' || o.decision === 'hold_suspicion'

// A gap session has no receipt. Its order number is the "Order <ref>:" prefix of gap_note.
// (The sessions table has no order column; a schema amendment can replace this later.)
export function parseGap(note: string | null): { order: string | null; text: string } {
  const m = /^Order (\S+): (.*)$/.exec(note ?? '')
  return m ? { order: m[1], text: m[2] } : { order: null, text: note ?? '' }
}

export function buildOrders(
  receipts: Receipt[],
  grants: Grant[],
  disputes: Dispute[],
  events: DisputeEvent[],
  sessions: Session[],
): OrderRow[] {
  const rows: OrderRow[] = receipts.map((r) => {
    const g = grants.find((x) => x.id === r.grant_id)
    const d = disputes.find((x) => x.receipt_id === r.id)
    return {
      key: r.id,
      order: r.order_ref,
      receipt: r,
      customer: g?.shopper_ref ?? '–',
      agent: g ? `${g.agent_id}${g.agent_verified ? ' (verified, simulated)' : ''}` : '–',
      status: str(r.action_summary.order_status) ?? '–',
      total_cents: num(r.action_summary.total_cents),
      dispute: d ? disputeStatus(events.filter((e) => e.dispute_id === d.id)) : null,
      decision: r.decision,
    }
  })
  for (const s of sessions.filter((x) => x.detection_source === 'none')) {
    const gap = parseGap(s.gap_note)
    rows.push({
      key: s.id,
      order: gap.order,
      receipt: null,
      customer: '–',
      agent: 'Unknown agent (unverified)',
      status: gap.text,
      // No receipt exists, so AgentReceipt recorded no amount for this order.
      total_cents: 0,
      dispute: null,
      decision: 'hold_suspicion', // an unverified agent with no session or receipt: the record cannot be trusted
    })
  }
  return rows.sort((a, b) => {
    if (a.order === null && b.order === null) return 0
    if (a.order === null) return 1
    if (b.order === null) return -1
    return Number(a.order) - Number(b.order)
  })
}

const suspicion = (r: Receipt): string[] => {
  const v = (r.audit as { suspicion_reasons?: unknown } | null)?.suspicion_reasons
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// One live read of everything an order row needs. The dashboard home uses it too, so its count can never drift from this page.
export function useAgentOrders(): Rows<OrderRow> {
  const receipts = useRows<Receipt>('receipts', 'chain_seq', true)
  const grants = useRows<Grant>('grants', 'chain_seq', true)
  const disputes = useRows<Dispute>('disputes', 'opened_at', true)
  const events = useRows<DisputeEvent>('dispute_events', 'chain_seq', true)
  const sessions = useRows<Session>('sessions', 'opened_at', true)
  const all: Rows<unknown>[] = [receipts, grants, disputes, events, sessions]
  const failed = all.find((s) => s.status === 'error')
  if (failed) return failed as Rows<OrderRow>
  if (all.some((s) => s.status === 'loading')) return { status: 'loading' }
  return {
    status: 'ready',
    rows: buildOrders(
      (receipts as { rows: Receipt[] }).rows,
      (grants as { rows: Grant[] }).rows,
      (disputes as { rows: Dispute[] }).rows,
      (events as { rows: DisputeEvent[] }).rows,
      (sessions as { rows: Session[] }).rows,
    ),
  }
}

// Display only: the Product row names the actual product (from the receipt's own terms snapshot) with the scope in
// brackets. Stored results, totals, problems and decisions are not touched.
export function withProductName(rows: MismatchResult[], snapshot: Record<string, unknown> | null | undefined): MismatchResult[] {
  const brand = str(snapshot?.brand)
  const name = str(snapshot?.product_name)
  if (!name) return rows
  const full = brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${name}` : name
  return rows.map((r) => {
    if (r.key !== 'product') return r
    const scope = r.merchant_terms ?? r.actual
    return { ...r, actual: scope ? `${full} (${scope})` : full }
  })
}

export default function AgentOrders() {
  const state = useAgentOrders()
  // Agent activity links here with { openKey: <receipt id> } to open that order's existing check.
  const location = useLocation()
  const [open, setOpen] = useState<string | null>(() => {
    const key = (location.state as { openKey?: unknown } | null)?.openKey
    return typeof key === 'string' ? key : null
  })
  const [openRef, setOpenRef] = useState<string | null>(null)

  // The guided tour asks for one order's check to be shown, by order number.
  useEffect(() => {
    const onOpen = (e: Event) => setOpenRef((e as CustomEvent<string>).detail)
    window.addEventListener('agentreceipt:open-order', onOpen)
    return () => window.removeEventListener('agentreceipt:open-order', onOpen)
  }, [])
  useEffect(() => {
    if (!openRef || state.status !== 'ready') return
    const row = state.rows.find((o) => o.order === openRef && o.receipt)
    if (row) setOpen(row.key)
    setOpenRef(null)
  }, [openRef, state])

  return (
    <div>
      <PageTitle title="Agent orders">
        Every order an agent placed at this store, with the receipt written for it. Open a row for the line-by-line check.
        The verified-agent signal is simulated.
      </PageTitle>

      <Live state={state}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty title="No agent orders yet.">
              Orders and their receipts appear here as soon as an agent completes a purchase at the store. This page reads
              the database live, so nothing needs to change when they arrive.
            </Empty>
          ) : (
            <div data-tour="receipt-page">
            <Card label="Agent orders">
              <p className="mb-3 text-sm font-semibold text-dash-ink" role="status">
                Orders requiring attention: <span className="text-dash-attention">{rows.filter(needsAttention).length}</span>
                <span className="ml-2 font-normal text-dash-label">Review Required + Hold for Suspicion. No dispute needed.</span>
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-dash-edge text-xs uppercase tracking-wider text-dash-label">
                      <th className="py-2 pr-4 font-semibold">Order</th>
                      <th className="py-2 pr-4 font-semibold">Receipt</th>
                      <th className="py-2 pr-4 font-semibold">Customer</th>
                      <th className="py-2 pr-4 font-semibold">Agent</th>
                      <th className="py-2 pr-4 font-semibold">Status</th>
                      <th className="py-2 pr-4 font-semibold">Total</th>
                      <th className="py-2 pr-4 font-semibold">Problems</th>
                      <th className="py-2 pr-4 font-semibold">Decision</th>
                      <th className="py-2 font-semibold"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => {
                      const r = o.receipt
                      const isOpen = open === o.key
                      return (
                        <tr key={o.key} data-order-ref={o.order ?? undefined} data-chain-seq={r?.chain_seq} className="border-b border-dash-edge align-top">
                          <td className="py-2 pr-4 font-semibold text-dash-ink">{o.order ?? '–'}</td>
                          <td className="py-2 pr-4">{r?.receipt_ref ?? '–'}</td>
                          <td className="py-2 pr-4">{o.customer}</td>
                          <td className="py-2 pr-4">{o.agent}</td>
                          <td className="py-2 pr-4">
                            {o.status}
                            {o.dispute && <span className="block font-semibold text-dash-attention">{o.dispute}</span>}
                          </td>
                          <td className="py-2 pr-4">{o.total_cents === null ? '–' : formatMoney(o.total_cents)}</td>
                          <td className={`py-2 pr-4 font-bold ${r && r.problems_found > 0 ? 'text-dash-violation' : 'text-dash-ink'}`}>
                            {r ? r.problems_found : '–'}
                          </td>
                          <td className="py-2 pr-4">{o.decision ? <DecisionBadge value={o.decision} /> : '–'}</td>
                          <td className="py-2 text-right">
                            {r && (
                              <button
                                type="button"
                                aria-expanded={isOpen}
                                onClick={() => setOpen(isOpen ? null : o.key)}
                                className="rounded-md px-2 py-1 text-xs font-semibold text-dash-teal hover:bg-dash-card-raised"
                              >
                                {isOpen ? 'Hide check' : 'Show check'}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {rows
                .filter((o) => o.key === open && o.receipt)
                .map((o) => {
                  const r = o.receipt as Receipt
                  return (
                    <div key={o.key} className="mt-5 rounded-lg border border-dash-edge bg-dash-card-raised p-4">
                      <p className="mb-3 text-sm font-semibold text-dash-ink">
                        {r.receipt_ref}: {r.problems_found} {r.problems_found === 1 ? 'problem' : 'problems'} found
                      </p>
                      {r.decision && (
                        <p className="mb-3 text-sm text-dash-ink">
                          <DecisionBadge value={r.decision} />
                          <span className="ml-2">{str((r.audit as Record<string, unknown> | null)?.merchant_action) ?? ''}</span>
                          {str((r.audit as Record<string, unknown> | null)?.flag) && (
                            <span className="ml-2 font-semibold text-dash-attention">{str((r.audit as Record<string, unknown>).flag)}</span>
                          )}
                        </p>
                      )}
                      {suspicion(r).length > 0 && (
                        <p className="mb-3 text-sm text-dash-violation">Why the record is not trusted: {suspicion(r).join('; ')}.</p>
                      )}
                      <VerdictTable rows={withProductName(r.mismatch_results, r.terms_snapshot)} />
                      {r.missing_components.length > 0 && (
                        <p className="mt-3 text-sm text-dash-attention">
                          Missing record components: {r.missing_components.join(', ')}.
                        </p>
                      )}
                      <p className="mt-3 break-all text-xs text-dash-label">
                        {r.schema_label}. Verified-agent status is simulated. Entry hash {r.entry_hash}
                      </p>
                      {(r.decision === 'review_required' || r.decision === 'hold_suspicion') && <MerchantActions receipt={r} />}
                    </div>
                  )
                })}
            </Card>
            </div>
          )
        }
      </Live>
    </div>
  )
}

import type { AgentAction, Decision, Grant, Proposal, Receipt } from '../shared/schemas'
import { parseGap } from './pages/AgentOrders'

// Agent activity map: where each agent session is, read from the chained records only. Pure functions, no I/O,
// no model calls. An agent exists here only because a session row exists for this merchant.

export type Zone = 'browse' | 'displays' | 'cart' | 'checkout'

export const ZONES: { id: Zone; label: string; panel: string }[] = [
  { id: 'browse', label: 'Entrance and browse aisles', panel: 'browsing' },
  { id: 'displays', label: 'Product displays', panel: 'at product displays' },
  { id: 'cart', label: 'Cart area', panel: 'in the cart area' },
  { id: 'checkout', label: 'Checkout line', panel: 'at checkout' },
]

export type ActivitySession = {
  id: string
  merchant_id: string
  detection_source: string
  agent_id: string | null
  agent_verified: boolean
  gap_note: string | null
  opened_at: string
}

export type AgentPosition = {
  session_id: string
  agent: string
  zone: Zone
  stage: string
  order: string | null
  // The receipt, when one exists: the Agent orders row to open.
  receipt_id: string | null
  decision: Decision | null
  // Set when a receipt exists: the verdict has been issued (decision may still be null on an old receipt).
  verdict_issued: boolean
  updated_at: string
}

type Stamped = { created_at?: string | null }
const latest = (...ts: (string | null | undefined)[]) =>
  ts.filter((t): t is string => typeof t === 'string' && t !== '').sort().at(-1) ?? ''

// Stage rules (adapted to the stored shapes):
//   session, no grant                       -> Browse aisles
//   grant, no proposal                      -> Product displays
//   proposal, no checkout action            -> Cart area
//   checkout action                         -> Checkout line ("Order placed, awaiting verdict")
//   receipt (verdict)                       -> stays at Checkout line, with the receipt's decision as the badge
//   gap session (detection_source 'none')   -> Checkout line, Hold for Suspicion, same as the Agent orders row
export function buildPositions(
  merchantId: string | null,
  sessions: ActivitySession[],
  grants: Grant[],
  proposals: Proposal[],
  actions: AgentAction[],
  receipts: Receipt[],
): AgentPosition[] {
  if (!merchantId) return []
  const mine = sessions.filter((s) => s.merchant_id === merchantId)
  return mine
    .map((s): AgentPosition => {
      const g = grants.filter((x) => x.session_id === s.id)
      const grantIds = new Set(g.map((x) => x.id))
      const p = proposals.filter((x) => grantIds.has(x.grant_id))
      const checkout = actions.filter((x) => grantIds.has(x.grant_id) && x.type === 'checkout')
      // A receipt only counts when it belongs to this merchant as well as to this session's grant.
      const r = receipts.filter((x) => grantIds.has(x.grant_id) && x.merchant_id === merchantId).at(-1) ?? null
      const top = [...g].sort((a, b) => b.version - a.version)[0]
      const agent = s.agent_id ?? top?.agent_id ?? 'Unknown agent'
      const updated_at = latest(
        s.opened_at,
        ...g.map((x) => (x as Grant & Stamped).created_at ?? x.confirmed_at),
        ...p.map((x) => (x as Proposal & Stamped).created_at ?? x.shown_at),
        ...checkout.map((x) => (x as AgentAction & Stamped).created_at),
        r ? (r as Receipt & Stamped).created_at ?? r.sealed_at : null,
      )
      const base = { session_id: s.id, agent, updated_at, order: null, receipt_id: null, decision: null, verdict_issued: false }

      if (r) {
        return { ...base, zone: 'checkout', stage: 'Verdict issued', order: r.order_ref, receipt_id: r.id, decision: r.decision, verdict_issued: true }
      }
      if (s.detection_source === 'none') {
        const gap = parseGap(s.gap_note)
        return {
          ...base, agent: 'Unknown agent (unverified)', zone: 'checkout', stage: 'Order arrived with no session record',
          order: gap.order, decision: 'hold_suspicion', verdict_issued: true,
        }
      }
      if (checkout.length > 0) return { ...base, zone: 'checkout', stage: 'Order placed, awaiting verdict' }
      if (p.length > 0) return { ...base, zone: 'cart', stage: 'Proposal presented' }
      if (g.length > 0) return { ...base, zone: 'displays', stage: 'Grant recorded' }
      return { ...base, zone: 'browse', stage: 'Session opened' }
    })
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
}

// "3 in store: 2 browsing, 1 at checkout". Zones with nobody are left out.
export function summary(positions: AgentPosition[]): string {
  if (positions.length === 0) return 'No agents in store right now.'
  const parts = ZONES.map((z) => ({ z, n: positions.filter((p) => p.zone === z.id).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.z.panel}`)
  return `${positions.length} in store: ${parts.join(', ')}`
}

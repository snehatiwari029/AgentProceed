import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeClient, mock, type Result } from './mockSupabase'
import { buildSeed, MERCHANT_ID } from '../../scripts/seed-dashboard-demo'
import { buildPositions, summary, type ActivitySession } from '../dashboard/activity'
import type { AgentAction, Grant, Proposal, Receipt } from '../shared/schemas'

vi.mock('../shared/supabase', () => ({ supabase: fakeClient }))

import AppRoutes from '../app/AppRoutes'
import { ActivityView } from '../dashboard/pages/AgentActivity'

const M = 'merchant-a'
const OTHER = 'merchant-b'
const t = (n: number) => `2026-11-02T10:0${n}:00.000Z`

const session = (id: string, merchant_id = M, extra: Partial<ActivitySession> = {}): ActivitySession => ({
  id, merchant_id, detection_source: 'self_declared_simulated', agent_id: `agent-${id}`, agent_verified: true, gap_note: null, opened_at: t(0), ...extra,
})
const grant = (id: string, session_id: string) => ({ id, session_id, version: 1, agent_id: `agent-${session_id}`, confirmed_at: t(1), created_at: t(1) }) as unknown as Grant
const proposal = (id: string, grant_id: string) => ({ id, grant_id, shown_at: t(2), created_at: t(2) }) as unknown as Proposal
const checkout = (id: string, grant_id: string) => ({ id, grant_id, seq: 1, type: 'checkout', created_at: t(3) }) as unknown as AgentAction
const receipt = (id: string, grant_id: string, decision: Receipt['decision'], merchant_id = M, order_ref = `O-${id}`) =>
  ({ id, grant_id, merchant_id, decision, order_ref, created_at: t(4) }) as unknown as Receipt

// One session in every stage, plus one gap session.
const world = () => {
  const sessions = ['browse', 'displays', 'cart', 'checkout', 'verdict'].map((s) => session(s))
  sessions.push(session('gap', M, { detection_source: 'none', agent_id: null, agent_verified: false, gap_note: 'Order 14522: no session record' }))
  const grants = ['displays', 'cart', 'checkout', 'verdict'].map((s) => grant(`g-${s}`, s))
  const proposals = ['cart', 'checkout', 'verdict'].map((s) => proposal(`p-${s}`, `g-${s}`))
  const actions = ['checkout', 'verdict'].map((s) => checkout(`a-${s}`, `g-${s}`))
  const receipts = [receipt('r-verdict', 'g-verdict', 'review_required')]
  return { sessions, grants, proposals, actions, receipts }
}
const positions = (w = world(), merchant: string | null = M) => buildPositions(merchant, w.sessions, w.grants, w.proposals, w.actions, w.receipts)
const by = (ps: ReturnType<typeof positions>, id: string) => ps.find((p) => p.session_id === id)!

describe('Agent activity: stage mapping', () => {
  it('puts each session in the zone its records support', () => {
    const ps = positions()
    expect(by(ps, 'browse')).toMatchObject({ zone: 'browse', stage: 'Session opened', decision: null, order: null })
    expect(by(ps, 'displays')).toMatchObject({ zone: 'displays', stage: 'Grant recorded', decision: null })
    expect(by(ps, 'cart')).toMatchObject({ zone: 'cart', stage: 'Proposal presented', decision: null })
    expect(by(ps, 'checkout')).toMatchObject({ zone: 'checkout', stage: 'Order placed, awaiting verdict', decision: null })
    // A verdict keeps the icon at checkout and adds the receipt's decision as its badge.
    expect(by(ps, 'verdict')).toMatchObject({ zone: 'checkout', stage: 'Verdict issued', decision: 'review_required', order: 'O-r-verdict', verdict_issued: true })
    // A gap session reads as Agent orders reads it: Hold for Suspicion, with the order from its gap note.
    expect(by(ps, 'gap')).toMatchObject({ zone: 'checkout', decision: 'hold_suspicion', order: '14522', agent: 'Unknown agent (unverified)' })
  })

  it('moves an icon only when a record is added', () => {
    const w = world()
    expect(by(positions(w), 'browse').zone).toBe('browse')
    w.grants.push(grant('g-browse', 'browse'))
    expect(by(positions(w), 'browse').zone).toBe('displays')
    w.proposals.push(proposal('p-browse', 'g-browse'))
    expect(by(positions(w), 'browse').zone).toBe('cart')
    w.actions.push(checkout('a-browse', 'g-browse'))
    expect(by(positions(w), 'browse').zone).toBe('checkout')
  })

  it('a non-checkout action does not move an agent to checkout', () => {
    const w = world()
    w.actions.push({ ...checkout('a-view', 'g-displays'), type: 'view' } as AgentAction)
    expect(by(positions(w), 'displays').zone).toBe('displays')
  })

  it('summarises by zone', () => {
    expect(summary(positions())).toBe('6 in store: 1 browsing, 1 at product displays, 1 in the cart area, 3 at checkout')
    expect(summary([])).toBe('No agents in store right now.')
  })
})

describe('Agent activity: merchant isolation', () => {
  it("shows only this merchant's sessions", () => {
    const w = world()
    w.sessions.push(session('theirs', OTHER))
    w.grants.push(grant('g-theirs', 'theirs'))
    const mine = positions(w)
    expect(mine.map((p) => p.session_id)).not.toContain('theirs')
    expect(positions(w, OTHER).map((p) => p.session_id)).toEqual(['theirs'])
  })

  it("ignores another merchant's receipt on this merchant's grant", () => {
    const w = world()
    w.receipts.push(receipt('r-x', 'g-checkout', 'pass', OTHER))
    expect(by(positions(w), 'checkout')).toMatchObject({ stage: 'Order placed, awaiting verdict', decision: null })
  })

  it('shows nothing when the merchant is not found', () => {
    expect(positions(world(), null)).toEqual([])
  })
})

describe('Agent activity: no icon without a record', () => {
  it('grants, proposals, actions and receipts with no session make no icon', () => {
    const w = world()
    w.grants.push(grant('g-orphan', 'no-such-session'))
    w.proposals.push(proposal('p-orphan', 'g-orphan'))
    w.actions.push(checkout('a-orphan', 'g-orphan'))
    w.receipts.push(receipt('r-orphan', 'g-orphan', 'pass'))
    expect(positions(w)).toHaveLength(w.sessions.length)
    expect(positions(w).map((p) => p.session_id)).not.toContain('no-such-session')
    expect(buildPositions(M, [], w.grants, w.proposals, w.actions, w.receipts)).toEqual([])
  })

  it('renders exactly one icon and one row per session record', () => {
    const ps = positions()
    const { container } = render(<MemoryRouter><ActivityView positions={ps} /></MemoryRouter>)
    expect(container.querySelectorAll('[data-agent-icon]')).toHaveLength(6)
    expect(container.querySelectorAll('[data-agent-row]')).toHaveLength(6)
    expect(container.querySelectorAll('[data-zone="checkout"] [data-agent-icon]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-verdict]')).toHaveLength(2)
  })

  it('empty state is plain text, not a scene', () => {
    const { container } = render(<MemoryRouter><ActivityView positions={[]} /></MemoryRouter>)
    expect(screen.getByTestId('activity-summary')).toHaveTextContent('No agents in store right now.')
    expect(container.querySelectorAll('[data-agent-icon]')).toHaveLength(0)
    // Zone labels are HTML overlays.
    expect(container.querySelector('[data-zone="checkout"]')).toHaveTextContent(/Checkout line/)
    expect(screen.getByText('Stylized store layout.')).toBeInTheDocument()
  })
})

describe('Agent activity page on the demo seed', () => {
  let SEEDED: Record<string, Result> = {}
  let seededSessions = 0
  beforeAll(async () => {
    const { records } = await buildSeed()
    const rows = (tbl: string) => records.filter((r) => r.table === tbl).map((r) => r.row)
    seededSessions = rows('sessions').filter((s) => (s as { merchant_id: string }).merchant_id === MERCHANT_ID).length
    const res = (tbl: string) => ({ data: rows(tbl), error: null })
    SEEDED = {
      sessions: { data: [...rows('sessions'), session('other-merchant', 'someone-else')], error: null },
      grants: res('grants'), proposals: res('proposals'), actions: res('actions'), receipts: res('receipts'),
      disputes: res('disputes'), dispute_events: res('dispute_events'),
      merchants: { data: [{ id: MERCHANT_ID, name: 'Northwind Outfitters' }, { id: 'someone-else', name: 'Other Store' }], error: null },
    }
  })
  beforeEach(() => {
    mock.hang = false
    mock.hangOn = []
    mock.next = { data: [], error: null }
    mock.tables = SEEDED
    mock.inserted = []
    mock.queries = []
    sessionStorage.setItem('agentreceipt-demo-merchant', 'yes')
  })

  it('icon count equals the merchant session count, writes nothing, and opens the existing order detail', async () => {
    const user = userEvent.setup()
    const { container } = render(<MemoryRouter initialEntries={['/dashboard/activity']}><AppRoutes /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Agent activity' })).toBeInTheDocument()
    await screen.findByTestId('store-map')
    expect(seededSessions).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-agent-icon]')).toHaveLength(seededSessions)
    expect(container.querySelector('[data-agent-icon="other-merchant"]')).toBeNull()
    expect(screen.getByTestId('activity-summary')).toHaveTextContent(`${seededSessions} in store`)
    expect(screen.getByRole('link', { name: 'Agent activity' })).toBeInTheDocument()

    // The 12322 row has a receipt: clicking it opens that order's existing check in Agent orders.
    await user.click(screen.getByRole('button', { name: /order 12322, open in Agent orders/ }))
    expect(await screen.findByRole('heading', { name: 'Agent orders' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Hide check' })).toBeInTheDocument()
    expect(screen.getByText(/AR-2026-\d+: 1 problem found|problems? found/)).toBeInTheDocument()
    expect(mock.inserted).toEqual([])
  })

  it('scopes every read to the demo merchant in the query, not after fetching everything', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/dashboard/activity']}><AppRoutes /></MemoryRouter>)
    await screen.findByTestId('store-map')
    await vi.waitFor(() => expect(container.querySelectorAll('[data-agent-icon]')).toHaveLength(seededSessions))
    const q = (t: string) => mock.queries.filter((x) => x.table === t)
    const sessionIds = SEEDED.sessions.data as { id: string; merchant_id: string }[]
    const mine = sessionIds.filter((s) => s.merchant_id === MERCHANT_ID).map((s) => s.id)
    expect(q('merchants').every((x) => x.filters.some((f) => f.op === 'eq' && f.col === 'name' && f.val === 'Northwind Outfitters'))).toBe(true)
    expect(q('sessions').length).toBeGreaterThan(0)
    expect(q('sessions').every((x) => x.filters.some((f) => f.op === 'eq' && f.col === 'merchant_id' && f.val === MERCHANT_ID))).toBe(true)
    for (const x of q('grants')) {
      const f = x.filters.find((y) => y.col === 'session_id')
      expect(f?.op).toBe('in')
      expect([...(f?.val as string[])].sort()).toEqual([...mine].sort())
    }
    for (const t of ['proposals', 'actions']) expect(q(t).every((x) => x.filters.some((f) => f.op === 'in' && f.col === 'grant_id'))).toBe(true)
    expect(q('receipts').every((x) => x.filters.some((f) => f.op === 'eq' && f.col === 'merchant_id' && f.val === MERCHANT_ID))).toBe(true)
    expect(q('receipts').every((x) => x.filters.some((f) => f.op === 'in' && f.col === 'grant_id'))).toBe(true)
    expect(mock.queries.every((x) => x.filters.length > 0)).toBe(true)
    expect(mock.inserted).toEqual([])
  })

  it('says the zones are pipeline stages, not live browsing', async () => {
    render(<MemoryRouter initialEntries={['/dashboard/activity']}><AppRoutes /></MemoryRouter>)
    await screen.findByTestId('store-map')
    expect(screen.getByText(/pipeline stage, not live browsing/)).toBeInTheDocument()
    expect(screen.getByTestId('stage-legend')).toHaveTextContent('Entrance and browse aisles: session opened, no grant yet.')
    expect(screen.getByText('Stylized store layout.')).toBeInTheDocument()
  })
})

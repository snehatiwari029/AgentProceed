import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NINE } from './fixtures'
import { fakeClient, mock, type Result } from './mockSupabase'
import { buildSeed, MERCHANT_ID } from '../../scripts/seed-dashboard-demo'
import { computeEntryHash } from '../../supabase/functions/_shared/hash'

vi.mock('../shared/supabase', () => ({ supabase: fakeClient }))

import AppRoutes from '../app/AppRoutes'
import { runScan } from '../../supabase/functions/optimizer/run'
import { PILLAR_NAMES } from '../../supabase/functions/optimizer/checks'
import { BURTON, NW, scriptedAgent, world } from './optimizerFixtures'
import type { Receipt } from '../shared/schemas'

// Test only: the rows the seed script generates are served by the fake database,
// exactly as they would come back from the real tables.
let SEEDED: Record<string, Result> = {}
beforeAll(async () => {
  const { records } = await buildSeed()
  const by = (t: string) => ({ data: records.filter((r) => r.table === t).map((r) => r.row), error: null })
  SEEDED = {
    sessions: by('sessions'), grants: by('grants'), proposals: by('proposals'), actions: by('actions'),
    receipts: by('receipts'), disputes: by('disputes'), dispute_events: by('dispute_events'), products: { data: NINE, error: null },
    shipments: by('shipments'), merchant_reviews: { data: [], error: null }, merchants: { data: [{ id: MERCHANT_ID, name: 'Northwind Outfitters' }], error: null },
    // The chain view: hashes only.
    chain_entries: { data: records.filter((r) => r.entry_type).map((r) => ({ chain_seq: r.row.chain_seq, entry_hash: r.row.entry_hash })), error: null },
  }
})

// The live dispute row (not the sample example) and its View details button.
const liveRow = async () => (await screen.findAllByText('AR-2026-0043')).map((x) => x.closest('tr')!).find((tr) => !tr.hasAttribute('data-sample-row'))!
const openLive = async (user: ReturnType<typeof userEvent.setup>) => user.click(within(await liveRow()).getByRole('button', { name: 'View details' }))
const openSample = async (user: ReturnType<typeof userEvent.setup>) => user.click(within((await screen.findByTestId('sample-label')).closest('tr')!).getByRole('button', { name: 'View details' }))

const open = (path: string) => {
  sessionStorage.setItem('agentreceipt-demo-merchant', 'yes')
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mock.hang = false
  mock.hangOn = []
  mock.next = { data: [], error: null }
  mock.tables = {}
})

describe('Dashboard pages: empty and error states', () => {
  it.each([
    ['/dashboard/orders', /no agent orders yet/i],
    ['/dashboard/disputes', /no disputes yet/i],
  ])('%s shows a proper empty state, not fake rows or a placeholder', async (path, text) => {
    open(path)
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument()
  })

  it('shows the database error instead of fallback data', async () => {
    mock.next = { data: null, error: { message: 'permission denied for table receipts' } }
    open('/dashboard/orders')
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied for table receipts')
  })
})

describe('Dashboard pages with the seeded rows (read live from the tables)', () => {
  beforeEach(() => {
    mock.tables = SEEDED
  })

  it('Agent orders shows 12322, 13422 and 14522 with customer, verified-simulated agent, status and dispute', async () => {
    const user = userEvent.setup()
    open('/dashboard/orders')
    const hero = (await screen.findByText('12322')).closest('tr')!
    expect(within(hero).getByText('AR-2026-0042')).toBeInTheDocument()
    expect(within(hero).getByText('Jemaih Soresky')).toBeInTheDocument()
    expect(within(hero).getByText('meta-muse-j0376672 (verified, simulated)')).toBeInTheDocument()
    expect(within(hero).getByText('Confirmed')).toBeInTheDocument()
    // the hero is Review Required and NOT a dispute
    expect(within(hero).getByText('Review Required')).toBeInTheDocument()
    expect(within(hero).queryByText('Dispute received')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Orders requiring attention: 2')
    expect(within(hero).getByText('$509.95')).toBeInTheDocument()

    const b = screen.getByText('13422').closest('tr')!
    expect(within(b).getByText('Ivan Dijkstra')).toBeInTheDocument()
    expect(within(b).getByText('$489.83')).toBeInTheDocument()
    expect(within(b).getByText('Won')).toBeInTheDocument()

    const gap = screen.getByText('14522').closest('tr')!
    expect(within(gap).getByText('Unverified agent, no Agent Receipt session opened, no receipt (gap recorded)')).toBeInTheDocument()
    expect(within(gap).getByText('Hold for Suspicion')).toBeInTheDocument()
    expect(within(gap).queryByRole('button')).not.toBeInTheDocument()
    expect(within(b).getByText('Pass')).toBeInTheDocument()

    await user.click(within(hero).getByRole('button', { name: /show check/i }))
    const th = screen.getAllByRole('columnheader').map((c) => c.textContent)
    expect(th).toEqual(expect.arrayContaining(['Field', 'Grant', 'Merchant terms', 'Actual', 'Match', 'Cause', 'Next action / Who acts']))
    expect(screen.queryByRole('columnheader', { name: /liab/i })).not.toBeInTheDocument()
    expect(screen.getAllByText('✕ Mismatch')).toHaveLength(2)
    expect(screen.getByText(/does not decide liability and no network rule moves liability on this screen/i)).toBeInTheDocument()
    expect(screen.getByText(/VI-aligned demo representation/)).toBeInTheDocument()
  })

  it('Home: 2x2 grid; demo values labelled Demo; Orders requiring attention is live (Review Required + Hold for Suspicion only) and links to the orders page', async () => {
    open('/dashboard')
    const card = await screen.findByTestId('stat-attention')
    expect(card).toHaveAttribute('href', '/dashboard/orders')
    // seed: 12322 Review Required + 14522 Hold for Suspicion. Pass orders 13422 and 0041 are not counted.
    await vi.waitFor(() => expect(card).toHaveTextContent(/^Orders requiring attention2/))
    expect(screen.getByTestId('stat-store-health')).toHaveTextContent('86/100')
    expect(screen.getByTestId('stat-profit')).toHaveTextContent('$18,400')
    expect(screen.getByTestId('stat-agent-profit')).toHaveTextContent('$7,920 (43%)')
    for (const id of ['stat-store-health', 'stat-profit', 'stat-agent-profit', 'stat-returns']) expect(screen.getByTestId(id).querySelector('[data-tag="demo"]')).not.toBeNull()
    for (const id of ['stat-total-orders', 'stat-chargebacks', 'stat-catalog']) expect(screen.getByTestId(id).querySelector('[data-tag="live"]')).not.toBeNull()
    // seed: receipts 0041, 12322, 13422 plus the 14522 gap = 4 orders; one dispute (13422) = 1 chargeback, Won = no open dispute.
    await vi.waitFor(() => expect(screen.getByTestId('stat-total-orders')).toHaveTextContent(/^Total Agent orders4/))
    expect(screen.getByTestId('stat-chargebacks')).toHaveTextContent(/^Chargebacks1/)
    expect(screen.getByTestId('stat-received')).toHaveTextContent(/^Received2/)
    expect(screen.getByTestId('stat-fulfilment')).toHaveTextContent(/^Fulfilment/)
    expect(screen.getByTestId('action-orders')).toHaveAttribute('href', '/dashboard/orders')
    expect(screen.getByTestId('action-orders')).toHaveTextContent(/2/)
    expect(screen.getByTestId('action-listings')).toHaveAttribute('href', '/dashboard/optimization')
    expect(screen.getByTestId('action-disputes')).toHaveAttribute('href', '/dashboard/disputes')
    await vi.waitFor(() => expect(screen.getByTestId('action-disputes')).toHaveTextContent(/0/))
    expect(within(screen.getByTestId('attention-list')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Order 14522, open in Agent Receipt', 'Order 12322, open in Agent Receipt'])
    expect(screen.getByTestId('activity-card').className).toMatch(/dash-standout/)
    expect(screen.getByTestId('activity-simulated')).toHaveTextContent(/Simulated agent traffic/)
  })

  it('Home count follows the data: a second Review Required order makes it 3', async () => {
    const extra = (SEEDED.receipts.data as Receipt[]).find((r) => r.receipt_ref === 'AR-2026-0042')!
    mock.tables = { ...SEEDED, receipts: { data: [...(SEEDED.receipts.data as Receipt[]), { ...extra, id: 'extra-1', receipt_ref: 'AR-2026-0044', order_ref: '15001', chain_seq: 99 }], error: null } }
    open('/dashboard')
    await vi.waitFor(() => expect(screen.getByTestId('stat-attention')).toHaveTextContent(/^Orders requiring attention3/))
  })

  it('Agent orders: the Product row names the actual product with the scope in brackets (display only)', async () => {
    const user = userEvent.setup()
    open('/dashboard/orders')
    const hero = (await screen.findByText('12322')).closest('tr')!
    await user.click(within(hero).getByRole('button', { name: /show check/i }))
    expect(screen.getByText('Burton Spellbinder Snowboard 2026/2027 (snowboard)')).toBeInTheDocument()
    expect(within(hero).getByText('Review Required')).toBeInTheDocument()
    expect(screen.getByText('2 problems found', { exact: false })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /hide check/i }))
    const orca = screen.getByText('13422').closest('tr')!
    await user.click(within(orca).getByRole('button', { name: /show check/i }))
    expect(screen.getByText('Lib Tech T. Rice Orca Snowboard 2025/2026 (snowboard)')).toBeInTheDocument()
    expect(within(orca).getByText('Pass')).toBeInTheDocument()
    expect(within(orca).getByText('$489.83')).toBeInTheDocument()
  })

  it('Disputes lists shipped + disputed agent orders only: 13422 (Visa 10.4, Won); 12322, 14522, 15001-type Review / Hold orders do not appear', async () => {
    open('/dashboard/disputes')
    const row = await liveRow()
    expect(screen.queryByText('AR-2026-0042')).not.toBeInTheDocument()
    expect(screen.queryByText('14522')).not.toBeInTheDocument()
    expect(within(row).getByText('13422')).toBeInTheDocument()
    expect(row).toHaveTextContent('Shipped 2026-10-27')
    expect(row).toHaveTextContent('Ordered 2026-10-26')
    expect(within(row).getByText('Claim: Agent overstep — agent exceeded budget / bought outside grant')).toBeInTheDocument()
    expect(within(row).getByText('Visa 10.4 — Other Fraud, Card-Absent Environment')).toBeInTheDocument()
    expect(within(row).getByTestId('pack-status')).toHaveTextContent('Outcome: Won')
    expect(await within(row).findByText('→ Customer says the agent bought outside what they authorised.')).toBeInTheDocument()
    expect(within(row).getByText(/did not authorise or take part in this card-absent/)).toBeInTheDocument()
    expect(within(row).getByText('7 documents missing — see pack')).toBeInTheDocument()
    expect(within(row).getByText('Merchant input required')).toBeInTheDocument()
    expect(screen.getByTestId('disputes-disclaimer')).toHaveTextContent(/Agent Proceed does not submit this pack on your behalf, and does not decide liability/)
    expect(screen.getByText(/Orders on\s+hold, Review Required, or Hold for Suspicion with no shipment do not appear here/)).toBeInTheDocument()
  })

  it('Dispute detail for 13422: claim vs record, timeline, pack in Visa order, tamper line with the receipt hash, missing items, merchant-reported Won', async () => {
    const user = userEvent.setup()
    open('/dashboard/disputes')
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    const hash = (SEEDED.receipts.data as Receipt[]).find((r) => r.order_ref === '13422')!.entry_hash
    expect(await within(detail).findByTestId('tamper-line')).toHaveTextContent(`Receipt chain verified — tamper check passed · ${hash}`)
    // reading order: claim vs record, timeline, pack, missing information, decisions
    const order = ['claim-vs-record', 'timeline', 'evidence-pack', 'needed', 'decisions'].map((id) => within(detail).getByTestId(id))
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const cvr = within(detail).getByTestId('claim-vs-record')
    expect(within(cvr).getByText('Agent overstep — agent exceeded budget / bought outside grant')).toBeInTheDocument()
    expect(within(cvr).getByText(/The customer's description is not a network code/)).toBeInTheDocument()
    expect(cvr.querySelector('[data-element="Budget"]')).toHaveTextContent(/Grant: \$500\.00 max.*Actual: \$489\.83 total.*✓ Match/)
    expect(cvr.querySelector('[data-element="Product"]')).toHaveTextContent('– Not specified by the customer, no check')
    // never specified is not the same as not authorised
    const colour = cvr.querySelector('[data-element="Colour"]')!
    expect(colour).toHaveTextContent('Customer never specified a colour, so no colour was authorised or restricted')
    expect(colour).toHaveTextContent('Grant: not specified by the customer · Actual: no colour recorded for this order')
    expect(colour).not.toHaveTextContent(/not authorised|Agent bought a colour/)
    const tl = within(detail).getByTestId('timeline').textContent ?? ''
    for (const s of ['Grant sealed', 'Action', 'Verdict', 'No merchant review record', 'Shipped 2026-10-27 · delivered 2026-10-29 · delivery proof missing', 'Dispute filed', 'Evidence Packet generated', 'Fought (submitted to acquirer)', 'Date 2026-11-01', 'Won', 'Date 2026-11-02']) expect(tl).toContain(s)
    expect(tl.indexOf('Shipped')).toBeLessThan(tl.indexOf('Dispute filed'))
    expect(tl.indexOf('Dispute filed')).toBeLessThan(tl.indexOf('Fought'))
    const packEl = within(detail).getByTestId('evidence-pack')
    expect([...packEl.querySelectorAll('[data-pack-section]')].map((x) => x.getAttribute('data-pack-section'))).toEqual(['dispute', 'grant', 'action', 'terms', 'verdict', 'receipt', 'merchant_review', 'delivery'])
    expect(within(packEl).getByTestId('text-source')).toHaveTextContent('rules-fallback — deterministic check only, Spark formatting unavailable')
    expect(within(packEl).getByTestId('pack-record')).toHaveTextContent('Matches the pack generation record of 2026-10-30.')
    expect(within(packEl).getByTestId('pack-notes')).toHaveTextContent('CE3.0 eligibility cannot be determined from Agent Receipt record — prior transactions / device data not in record, obtain from acquirer.')
    expect(within(packEl).getByTestId('pack-notes')).toHaveTextContent('Deadline: confirm with acquirer — settlement date not in record.')
    expect(within(detail).getByTestId('merchant-input-flag')).toHaveTextContent('Merchant input required: Carrier; Tracking reference; Proof of delivery.')
    expect(within(detail).getByTestId('decision-history')).toHaveTextContent(/Fought \(submitted to acquirer\)2026-11-01.*\(merchant-reported\).*Won2026-11-02/)
  })

  it('Disputes: changing the pack format rebuilds it in the Mastercard field order and checklist', async () => {
    const user = userEvent.setup()
    open('/dashboard/disputes')
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    await within(detail).findByTestId('tamper-line')
    await user.selectOptions(within(detail).getByLabelText('Pack format'), 'mastercard')
    await within(detail).findByText('Chargeback details')
    const packEl = within(detail).getByTestId('evidence-pack')
    expect([...packEl.querySelectorAll('[data-pack-section]')].map((x) => x.getAttribute('data-pack-section'))).toEqual(['dispute', 'action', 'grant', 'terms', 'delivery', 'merchant_review', 'verdict', 'receipt', 'eligibility'])
    expect(within(detail).getByText(/This dispute was filed under Visa\. The pack below is rebuilt in the Mastercard format/)).toBeInTheDocument()
    expect(within(packEl).getByTestId('pack-record')).toHaveTextContent(/It is not yet recorded as a generated pack for the Mastercard format: Generate pack records this version in the chain\. Opening the page writes nothing\./)
    expect(within(packEl).getByTestId('pack-notes')).toHaveTextContent('Registration status not in record — confirm with acquirer.')
  })

  it('Disputes: an edited receipt fails the tamper check: untrusted record, failing link named, no passed line', async () => {
    const user = userEvent.setup()
    const receipts = (SEEDED.receipts.data as Receipt[]).map((r) =>
      r.order_ref === '13422' ? { ...r, action_summary: { ...r.action_summary, total_cents: 4898 } } : r)
    mock.tables = { ...SEEDED, receipts: { data: receipts, error: null } }
    open('/dashboard/disputes')
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    expect(await within(detail).findByText('Receipt chain failed verification — tamper check failed. This record is untrusted.')).toBeInTheDocument()
    expect(within(detail).getAllByText(/Entry \d+ \(receipt\) no longer matches its hash/).length).toBeGreaterThan(0)
    expect(within(detail).getByTestId('tamper-line')).toHaveTextContent(/^Receipt chain failed verification/)
    expect(within(detail).queryByText(/tamper check passed/)).not.toBeInTheDocument()
  })

  it('Disputes: the evidence package is withheld while the chain is being checked', async () => {
    const user = userEvent.setup()
    mock.hangOn = ['chain_entries'] // the neighbouring-hash read never answers, so the check cannot finish
    open('/dashboard/disputes')
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    expect(within(detail).getByText(/Checking receipt chain… the evidence package is shown after the check/)).toBeInTheDocument()
    expect(within(detail).queryByTestId('evidence-pack')).not.toBeInTheDocument()
    expect(within(detail).queryByTestId('tamper-line')).not.toBeInTheDocument()
  })

  it('Disputes page and pack show no AgentReceipt recommendation, classifier, win probability or score; decision buttons are merchant actions', async () => {
    const user = userEvent.setup()
    open('/dashboard/disputes')
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    await within(detail).findByTestId('tamper-line')
    const text = screen.getByRole('main').textContent ?? ''
    expect(text).not.toMatch(/recommend|win probability|likely to win|\bscore\b|represent\b|you should (fight|concede)|we suggest|investigate, do not represent/i)
    for (const name of ['Mark as Fought (submitted to acquirer)', 'Mark as Conceded', 'Mark as Investigating', 'Mark outcome']) {
      expect(within(detail).getByRole('button', { name })).toBeInTheDocument()
    }
    expect(within(detail).getByText(/You decide, with your acquirer, whether to fight or concede/)).toBeInTheDocument()
  })

  it('Disputes: Mark as Fought shows the pack summary again, then appends through the disputes function only', async () => {
    const user = userEvent.setup()
    const calls: Record<string, unknown>[] = []
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project.test')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, ...JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ type: 'event_recorded', event: {} }))
    }))
    try {
      open('/dashboard/disputes')
      await openLive(user)
      const detail = await screen.findByTestId('dispute-detail')
      await within(detail).findByTestId('tamper-line')
      await user.click(within(detail).getByRole('button', { name: 'Mark as Fought (submitted to acquirer)' }))
      const confirm = within(detail).getByTestId('decision-confirm')
      expect(confirm).toHaveTextContent(/Pack summary, before you record this.*Visa format.*7 items missing from the record; 3 need your input/)
      await user.type(within(confirm).getByLabelText('Decision date'), '2026-11-04')
      await user.type(within(confirm).getByLabelText('Reason'), 'Submitted again by our team.')
      await user.click(within(confirm).getByRole('button', { name: 'Confirm and record' }))
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ url: 'https://project.test/functions/v1/disputes', action: 'record_event', event_type: 'represented', date: '2026-11-04', reason: 'Submitted again by our team.', merchant_id: MERCHANT_ID })
      expect(mock.inserted).toEqual([]) // the browser never writes a table
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it('Record a dispute: a non-agent order shows "Not an Agent Receipt order — no evidence package built." and nothing is built', async () => {
    const user = userEvent.setup()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project.test')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ type: 'not_agent_order', message: 'Not an Agent Receipt order — no evidence package built.', gap: false }))
    }))
    try {
      open('/dashboard/disputes')
      await user.click(await screen.findByRole('button', { name: 'Record a dispute' }))
      await user.type(screen.getByLabelText('Order id'), 'TEST-NOT-AN-ORDER')
      await user.type(screen.getByLabelText('Dispute claim as filed'), 'Customer says unauthorised')
      await user.selectOptions(screen.getByLabelText('Claim type as filed'), 'not_authorised')
      await user.type(screen.getByLabelText('Reason code / condition as filed'), '10.4')
      await user.type(screen.getByLabelText('Dispute date'), '2026-11-03')
      await user.click(screen.getByRole('button', { name: 'Record dispute' }))
      expect(await screen.findByText('Not an Agent Receipt order — no evidence package built.')).toBeInTheDocument()
      expect(calls).toEqual([expect.objectContaining({ action: 'record_dispute', order_ref: 'TEST-NOT-AN-ORDER', processor: 'visa', reason_code: '10.4', dispute_amount_cents: null })])
      expect(screen.queryAllByTestId('dispute-detail')).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  // The live 13422 record (left as it is, option C): no filed processor, code, claim type or dispute date; dispute and
  // merchant entries on Oct 26 with times only; no shipment record. Rebuilt here on a valid hash chain.
  async function liveShape() {
    const receipts = SEEDED.receipts.data as Receipt[]
    const receipt = receipts.find((r) => r.order_ref === '13422')!
    const dispute = { id: 'd-live', receipt_id: receipt.id, reason: 'Claimed agent overstep — agent exceeded budget / bought outside grant', opened_at: '2026-10-26T18:30:00+00:00', created_at: '2026-10-26T18:30:00+00:00' }
    let prev = receipt.entry_hash as string
    const events = []
    const old = [['opened', null, {}, '18:30'], ['recommendation', 'AgentReceipt (automatic)', { recommendation: 'represent' }, '18:31'], ['represented', 'Northwind Outfitters', { receipt_ref: 'AR-2026-0043' }, '18:40'], ['outcome_won', 'Northwind Outfitters', { receipt_ref: 'AR-2026-0043' }, '18:50']] as const
    for (const [i, [type, by, basis, hhmm]] of old.entries()) {
      const row = { id: `e-live-${i}`, dispute_id: 'd-live', event_type: type, decided_by: by, basis, created_at: `2026-10-26T${hhmm}:00+00:00`, chain_seq: (receipt.chain_seq as number) + 1 + i, prev_hash: prev }
      const entry_hash = await computeEntryHash(prev, row)
      events.push({ ...row, entry_hash })
      prev = entry_hash
    }
    const chain = (SEEDED.chain_entries.data as { chain_seq: number; entry_hash: string }[]).filter((c) => c.chain_seq <= (receipt.chain_seq as number)).concat(events.map((e) => ({ chain_seq: e.chain_seq, entry_hash: e.entry_hash })))
    mock.tables = { ...SEEDED, disputes: { data: [dispute], error: null }, dispute_events: { data: events, error: null }, shipments: { data: [], error: null }, chain_entries: { data: chain, error: null } }
  }

  it('live 13422 (unfiled fields): chronological timeline, one dispute-date answer, no "filed as Visa", plain claim reading, Layer 2 statement once', async () => {
    const user = userEvent.setup()
    await liveShape()
    open('/dashboard/disputes')
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    expect(await within(detail).findByTestId('tamper-line')).toHaveTextContent('Receipt chain verified — tamper check passed')
    // 1. chronological: the order before the dispute that it caused
    const titles = [...within(detail).getByTestId('timeline').querySelectorAll('li > span:first-child')].map((x) => x.textContent)
    expect(titles).toEqual(['Grant sealed', 'Action', 'Verdict', 'Merchant review', 'Shipment', 'Dispute filed', 'Fought (submitted to acquirer)', 'Won'])
    // 4. one answer for the dispute date: not filed, recorded on Oct 26 — in the header, the timeline and the pack
    expect(within(detail).getByTestId('dispute-date')).toHaveTextContent('Dispute date not filed — recorded in Agent Proceed 2026-10-26')
    const filedStep = [...within(detail).getByTestId('timeline').querySelectorAll('li')].find((li) => li.textContent!.startsWith('Dispute filed'))!
    expect(filedStep).toHaveTextContent(/^Dispute filed\s*dispute date not filed · recorded 2026-10-26/)
    // steps with no record show no date at all, never a borrowed one
    for (const name of ['Merchant review', 'Shipment']) {
      const li = [...within(detail).getByTestId('timeline').querySelectorAll('li')].find((x) => x.querySelector('span')!.textContent === name)!
      expect(li.querySelectorAll('span')[1]).toHaveTextContent(/^no record$/)
    }
    expect(within(detail).getByTestId('evidence-pack')).toHaveTextContent('Not filed. The dispute was recorded in Agent Proceed on 2026-10-26.')
    expect(detail.textContent).not.toMatch(/Dispute filed 2026-10-26/)
    // 2. the viewed format is never presented as the filed processor
    expect(within(detail).getByTestId('format-note')).toHaveTextContent('Processor not filed. Pack format: Visa — view only.')
    expect(within(detail).getByTestId('pack-explanation')).toHaveTextContent('shown in Visa field order. Processor and reason code are not filed; Visa is only the format you are viewing.')
    expect(detail.textContent).not.toMatch(/filed as Visa/)
    // 3. the agent-overstep claim gets its plain reading
    expect(within(detail).getByTestId('claim-vs-record')).toHaveTextContent('Customer says the agent bought outside what they authorised.')
    expect(detail.textContent).not.toMatch(/no plain-language reading for this claim type/)
    // 5. inside the pack, the Layer 2 statement appears once (the timeline has its own step)
    expect(within(detail).getByTestId('evidence-pack').textContent!.match(/No merchant review record\. The order was Pass at Agent Receipt check, so no review was flagged\./g)).toHaveLength(1)
    // the old recommendation entry is never shown
    expect(detail.textContent).not.toMatch(/recommend/i)
  })

  it('no build vocabulary on screen: the Disputes page and the Agent orders merchant-action panel never say "Layer"', async () => {
    const user = userEvent.setup()
    open('/dashboard/disputes')
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    await within(detail).findByTestId('tamper-line')
    for (const p of ['visa', 'mastercard']) {
      await user.selectOptions(within(detail).getByLabelText('Pack format'), p)
      await within(detail).findByText(p === 'visa' ? 'Dispute condition and transaction' : 'Chargeback details')
      expect(screen.getByRole('main').textContent).not.toMatch(/layer/i)
    }
  })

  const LEGEND_TEXT = 'Blue = real data from the transaction record. Orange = sample data — what we would receive from merchant dispute records when the store is connected.'

  it('legend: the same wording at the top of the list, the detail view and the evidence pack', async () => {
    const user = userEvent.setup()
    open('/dashboard/disputes')
    const list = await screen.findByTestId('legend-list')
    expect(list.querySelector('[data-legend]')!.textContent).toBe(LEGEND_TEXT)
    // first thing on the page after the title: before the record form and the list
    expect(list.compareDocumentPosition(screen.getByRole('region', { name: 'Record a dispute' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    await within(detail).findByTestId('tamper-line')
    expect(within(detail).getByTestId('legend-detail').querySelector('[data-legend]')!.textContent).toBe(LEGEND_TEXT)
    const packEl = within(detail).getByTestId('evidence-pack')
    const legend = within(packEl).getByTestId('legend-pack')
    expect(legend.querySelector('[data-legend]')!.textContent).toBe(LEGEND_TEXT)
    expect(legend.compareDocumentPosition(packEl.querySelector('[data-pack-section]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('sample example: a separate row, labelled once per place, with exactly the sample notice values in orange and the real record in blue', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      open('/dashboard/disputes')
      const label = await screen.findByTestId('sample-label')
      expect(screen.getAllByTestId('sample-label')).toHaveLength(1)
      expect(label).toHaveTextContent('Sample example — not a filed dispute')
      const sampleRow = label.closest('tr')!
      expect(within(sampleRow).getByTestId('pack-status')).toHaveTextContent('Sample — not filed')
      await openSample(user)
      const detail = await screen.findByTestId('dispute-detail')
      await within(detail).findByTestId('tamper-line')
      expect(within(detail).getAllByTestId('sample-detail-label')).toHaveLength(1)
      expect(within(detail).getAllByTestId('sample-pack-label')).toHaveLength(1)
      const packEl = within(detail).getByTestId('evidence-pack')
      const value = (label: string) => [...packEl.querySelectorAll('dt')].find((dt) => dt.textContent === label)!.nextElementSibling as HTMLElement
      const SAMPLE_VALUES: [string, string][] = [
        ['Processor as filed', 'Visa'], ['Reason code / condition as filed', '10.4 — Other Fraud, Card-Absent Environment'], ['Dispute date', '2026-10-30'],
        ['Dispute amount', '$489.83'], ['Processor reference', 'SAMPLE-13422-VISA-104'], ['Acquirer / channel', 'Sample acquirer (demo)'],
        ['Payment credential (last 4 / token only)', '•••• 4242 (sample token / test last 4)'],
      ]
      for (const [l, v] of SAMPLE_VALUES) {
        expect(value(l)).toHaveTextContent(v)
        expect(value(l)).toHaveAttribute('data-value', 'sample')
        expect(value(l)).toHaveClass('text-dash-sample')
      }
      // real fields: blue, unchanged
      for (const [l, v] of [['Cardholder details (as recorded on the grant)', 'Ivan Dijkstra'], ['Dispute claim as filed', 'Agent overstep — agent exceeded budget / bought outside grant'], ['Transaction amount', '$489.83'], ['Budget (maximum total)', '$500.00 max'], ['Total price', '$489.83'], ['Receipt ID', 'AR-2026-0043'], ['Agent Receipt verdict (evidence only)', 'Pass, 0 problems']]) {
        expect(value(l)).toHaveTextContent(v)
        expect(value(l)).toHaveAttribute('data-value', 'record')
        expect(value(l)).toHaveClass('text-dash-real')
      }
      const hash = (SEEDED.receipts.data as Receipt[]).find((r) => r.order_ref === '13422')!.entry_hash
      expect(value('Receipt hash')).toHaveTextContent(hash)
      expect(within(detail).getByTestId('tamper-line')).toHaveTextContent(`Receipt chain verified — tamper check passed · ${hash}`)
      // the customer description is shown apart from the Visa condition
      expect(within(detail).getByTestId('condition-as-filed')).toHaveTextContent('Visa 10.4 — Other Fraud, Card-Absent Environment')
      expect(within(detail).getByTestId('condition-as-filed')).toHaveClass('text-dash-sample')
      // section-level colour: the notice section is orange once; the record sections are blue
      const tone = (k: string) => packEl.querySelector(`[data-pack-section="${k}"]`)!.getAttribute('data-tone')
      expect(tone('dispute')).toBe('sample')
      for (const k of ['grant', 'action', 'terms', 'verdict', 'receipt']) expect(tone(k)).toBe('record')
      // no merchant actions, no recording, no write: nothing is sent anywhere for the sample
      expect(within(detail).queryByRole('button', { name: /Mark as|Generate pack|Regenerate pack|Mark as downloaded/ })).not.toBeInTheDocument()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(mock.inserted).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('live 13422 keeps its record: notice fields still Missing (not sample); record sections blue; no Sample tag, no per-field source line', async () => {
    const user = userEvent.setup()
    // the live record as it is (option C): no filed processor, code, date, amount, reference
    const d = (SEEDED.disputes.data as Record<string, unknown>[]).map((x) => ({ id: x.id, receipt_id: x.receipt_id, reason: x.reason, opened_at: x.opened_at }))
    mock.tables = { ...SEEDED, disputes: { data: d, error: null } }
    open('/dashboard/disputes')
    await openLive(user)
    const detail = await screen.findByTestId('dispute-detail')
    await within(detail).findByTestId('tamper-line')
    expect(within(detail).queryByTestId('sample-detail-label')).not.toBeInTheDocument()
    const packEl = within(detail).getByTestId('evidence-pack')
    expect(packEl.querySelectorAll('[data-value="sample"]')).toHaveLength(0)
    expect(packEl.querySelectorAll('[data-tone="sample"]')).toHaveLength(0)
    const value = (label: string) => [...packEl.querySelectorAll('dt')].find((dt) => dt.textContent === label)!.nextElementSibling as HTMLElement
    for (const l of ['Processor as filed', 'Reason code / condition as filed', 'Dispute date', 'Dispute amount', 'Processor reference', 'Acquirer / channel', 'Payment credential (last 4 / token only)']) {
      expect(value(l)).toHaveAttribute('data-value', 'missing')
      expect(value(l)).toHaveTextContent(/^Missing/)
      expect(value(l)).not.toHaveClass('text-dash-sample')
    }
    for (const k of ['grant', 'action', 'terms', 'verdict', 'receipt']) expect(packEl.querySelector(`[data-pack-section="${k}"]`)).toHaveAttribute('data-tone', 'record')
    // no per-field "Sample" tag and no per-field source line anywhere in the pack
    expect(within(detail).queryAllByText(/^sample$/i)).toHaveLength(0)
    expect(packEl.textContent).not.toMatch(/Source:/)
  })

  it('sample pack: missing items stay Missing (grey chip, never orange); sample values never read as missing', async () => {
    const user = userEvent.setup()
    open('/dashboard/disputes')
    await openSample(user)
    const detail = await screen.findByTestId('dispute-detail')
    await within(detail).findByTestId('tamper-line')
    const packEl = within(detail).getByTestId('evidence-pack')
    const missing = [...packEl.querySelectorAll('[data-value="missing"]')]
    expect(missing.length).toBeGreaterThan(0) // carrier, tracking, proof of delivery are still not in the record
    for (const m of missing) {
      expect(m.textContent).toMatch(/^Missing/)
      expect(m).not.toHaveClass('text-dash-sample')
    }
    for (const s of packEl.querySelectorAll('[data-value="sample"]')) expect(s.textContent).not.toMatch(/Missing/)
    expect(within(detail).queryAllByText(/^sample$/i)).toHaveLength(0)
    expect(packEl.textContent).not.toMatch(/Source:/)
  })

  it('the sample example changes no order: Agent orders and the attention count are unchanged', async () => {
    open('/dashboard')
    expect(await screen.findByTestId('stat-attention')).toHaveTextContent('2')
  })

  it('Agent orders: a Review Required order offers "Record merchant action" (Layer 2); a Pass order does not', async () => {
    const user = userEvent.setup()
    open('/dashboard/orders')
    const hero = (await screen.findByText('12322')).closest('tr')!
    await user.click(within(hero).getByRole('button', { name: /show check/i }))
    const box = await screen.findByTestId('merchant-actions')
    expect(await within(box).findByText('No merchant review record.')).toBeInTheDocument()
    const form = within(box).getByRole('form', { name: 'Record merchant action' })
    expect(within(form).getAllByRole('option').map((o) => o.textContent)).toEqual(expect.arrayContaining([
      'Called customer and confirmed', 'Emailed customer and confirmed', 'Investigated and cleared', 'Overrode with documented reason', 'Kept on hold', 'Cancelled',
      'Phone call', 'Email', 'Chat', 'In-person', 'Other', 'Released for shipment', 'Not released',
    ]))
    // confirmed total / terms appear only for a confirmation, and are never pre-filled
    expect(within(form).queryByLabelText('Confirmed total')).not.toBeInTheDocument()
    await user.selectOptions(within(form).getByLabelText('Action taken'), 'called_confirmed')
    expect(within(form).getByLabelText('Confirmed total')).toHaveValue('')
    expect(within(form).getByLabelText('Confirmed terms')).toHaveValue('')
    await user.click(within(hero).getByRole('button', { name: /hide check/i }))
    const b = screen.getByText('13422').closest('tr')!
    await user.click(within(b).getByRole('button', { name: /show check/i }))
    expect(screen.queryByTestId('merchant-actions')).not.toBeInTheDocument()
  })
})

describe('Optimization for Agents', () => {
  const NORTHWIND = { data: [{ id: NW, name: 'Northwind Outfitters' }], error: null }
  // A real scan, run by the optimizer's own code over the test copy of the 9 Northwind rows, served as table rows.
  async function scanned(opts: Parameters<typeof world>[0] = {}) {
    const w = world(opts)
    await runScan({ merchant_id: NW }, w.deps)
    mock.tables = {
      merchants: NORTHWIND,
      optimizer_scans: { data: w.tables.optimizer_scans, error: null },
      optimizer_suggestions: { data: w.tables.optimizer_suggestions, error: null },
      receipts: SEEDED.receipts,
    }
    return w
  }
  let calls: { url: string; body: Record<string, unknown> }[] = []
  let scanReplyId = 's'
  const VIEW_KEY = 'agentproceed.readAsAgent.v1'
  beforeEach(() => {
    calls = []
    scanReplyId = 's'
    localStorage.clear()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project.test')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push({ url, body })
      const reply = body.action === 'approve_all' ? { type: 'approve_all', approved: 1, skipped_unfilled: 2, skipped_not_pending: 0 }
        : body.action === 'decide' ? { type: 'decision', suggestion_id: body.suggestion_id, status: 'approved' }
          : { type: 'scan', scan_id: scanReplyId, listings_scanned: 9, flags: 1, resolved: 0, still_flagged: 0, markup_status: 'fetched', spark: {} }
      return new Response(JSON.stringify(reply))
    }))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const left = () => screen.getByRole('region', { name: 'Listing optimization: 5 factors' })
  const right = () => screen.getByRole('region', { name: 'Read as Agent' })
  // Each factor shows 3 alerts until "Show all N" is pressed.
  async function showAll(user: ReturnType<typeof userEvent.setup>) {
    for (const b of within(left()).queryAllByRole('button', { name: /^Show all \d+$/ })) await user.click(b)
  }

  it('before any scan: two sections, the scan button on the Read as Agent side, and nothing listed', async () => {
    mock.tables = { merchants: NORTHWIND }
    open('/dashboard/optimization')
    expect(await screen.findByRole('heading', { name: 'Listing Optimizer' })).toBeInTheDocument()
    await screen.findByRole('region', { name: 'Read as Agent' })
    expect(within(left()).getByText(/No scan yet/)).toBeInTheDocument()
    expect(within(right()).getByTestId('read-as-agent-empty')).toHaveTextContent('Press Read as Agent Scan')
    expect(within(right()).getByRole('button', { name: 'Read as Agent Scan' })).toBeInTheDocument()
    expect(screen.queryByTestId('optimizer-suggestion')).not.toBeInTheDocument()
  })

  it('buttons: one "Mark all as done" over the 5 factors; Scan, Mark all as done and Clear all over Read as Agent; no Approve or Reject', async () => {
    await scanned()
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    expect(within(left()).getAllByRole('button').filter((b) => !/Details|Hide details|^Show all \d+$/.test(b.textContent ?? '')).map((b) => b.textContent)).toEqual(['Mark all as done'])
    expect(within(right()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Read as Agent Scan', 'Mark all as done', 'Clear all'])
    expect(screen.queryByRole('button', { name: /^Approve|^Reject/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/It does not apply them/)).not.toBeInTheDocument() // no button explanations
  })

  it('Read as Agent Scan calls the optimizer function with this merchant only', async () => {
    const user = userEvent.setup()
    mock.tables = { merchants: NORTHWIND }
    open('/dashboard/optimization')
    await user.click(await screen.findByRole('button', { name: 'Read as Agent Scan' }))
    expect(calls).toEqual([{ url: 'https://project.test/functions/v1/optimizer', body: { action: 'scan', merchant_id: NW } }])
    expect(await screen.findByText(/Scan finished: 9 listings/)).toBeInTheDocument()
  })

  it('the 5-factor section lists every open alert under its own factor, with the listing it is for', async () => {
    const user = userEvent.setup()
    const w = await scanned()
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    const p1 = w.tables.optimizer_suggestions.filter((s) => s.pillar === 1).length
    expect(within(within(left()).getByTestId('factor-1')).getAllByTestId('optimizer-suggestion')).toHaveLength(3) // 3 until Show all
    expect(within(within(left()).getByTestId('factor-1')).getByRole('button', { name: `Show all ${p1}` })).toBeInTheDocument()
    await showAll(user)
    const header = screen.getByRole('region', { name: 'Optimizer header' })
    expect(header).toHaveTextContent('Northwind Outfitters')
    expect(within(header).getByRole('link', { name: 'View Store' })).toHaveAttribute('href', '/shop')
    expect(screen.getByText('Listings scanned').nextSibling).toHaveTextContent('9')
    for (const p of [1, 2, 3, 4, 5] as const) {
      const group = within(left()).getByTestId(`factor-${p}`)
      expect(within(group).getByRole('heading', { level: 3 })).toHaveTextContent(new RegExp(`^${p}\\. ${PILLAR_NAMES[p].replace(/[()]/g, '\\$&')}`))
      expect(within(group).queryAllByTestId('optimizer-suggestion')).toHaveLength(w.tables.optimizer_suggestions.filter((s) => s.pillar === p).length)
    }
    const returns = within(within(left()).getByTestId('factor-2')).getAllByTestId('optimizer-suggestion')[0]
    expect(returns).toHaveTextContent('Burton Spellbinder')
    expect(returns).toHaveTextContent('Marketing "Easy returns." vs formal terms "Final Sale"')
    expect(within(right()).queryByTestId('optimizer-suggestion')).not.toBeInTheDocument()
  })

  it('the scan summary names the same deconstruction source as the listings, and explains rules-fallback only when a listing used it', async () => {
    const w = await scanned()
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    const spark = (w.tables.optimizer_scans[0] as { spark: Record<string, number> }).spark
    const line = screen.getByText(/^Semantic reading \(pillar deconstruction\):/)
    const onSpark = spark['muse-spark'] ?? 0
    const onFallback = spark['rules-fallback'] ?? 0
    expect(line).toHaveTextContent(`Muse Spark deconstruction on ${onSpark} of 9`)
    if (onFallback > 0) expect(line).toHaveTextContent(`rules-fallback — deterministic check only, Spark deconstruction unavailable on ${onFallback} of 9`)
    else expect(line).not.toHaveTextContent(/rules-fallback/)
  })

  it('shows no Order check linkage: no order numbers, mismatch counts, "linked to" tags or caused-mismatch filter', async () => {
    const user = userEvent.setup()
    const w = await scanned({ agent: scriptedAgent() })
    localStorage.setItem(VIEW_KEY, JSON.stringify({ scanId: w.tables.optimizer_scans[0].id, cleared: false, done: false }))
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    for (const b of screen.getAllByRole('button', { name: 'Details' })) await user.click(b)
    const text = screen.getByRole('main').textContent ?? ''
    for (const banned of ['12322', '13422', '14522', '15001', '15002', 'Budget mismatches', 'Returns mismatches', 'Open Agent orders']) expect(text).not.toContain(banned)
    expect(text).not.toMatch(/linked to|caused a real order mismatch|review required|chargeback|dispute/i)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('5 factors "Mark all as done" marks every open alert whose values are filled; the rest stay open, outlined in red', async () => {
    const user = userEvent.setup()
    const w = await scanned()
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    const ready = w.tables.optimizer_suggestions.filter((s) => s.value_fields.length === 0)
    const needing = w.tables.optimizer_suggestions.length - ready.length
    await user.click(within(left()).getByRole('button', { name: 'Mark all as done' }))
    expect(calls.every((c) => c.body.action === 'decide' && c.body.decision === 'approve')).toBe(true)
    expect(new Set(calls.map((c) => c.body.suggestion_id))).toEqual(new Set(ready.map((s) => s.id)))
    expect(await screen.findByText(`Marked ${ready.length} as done. ${needing} need a value first (outlined in red).`)).toBeInTheDocument()
    const ids = within(left()).getAllByTestId('optimizer-suggestion').find((el) => el.textContent?.includes('Missing identifiers') && el.textContent.includes('Spellbinder'))!
    const gtin = within(ids).getByLabelText(/^To be filled by merchant: GTIN/) // opened by itself
    expect(gtin).toHaveAttribute('aria-invalid', 'true')
    expect(gtin).toHaveClass('border-dash-violation')
  })

  it('values typed on an alert are sent with it by "Mark all as done"', async () => {
    const user = userEvent.setup()
    const w = await scanned()
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    await showAll(user)
    const ids = within(left()).getAllByTestId('optimizer-suggestion').find((el) => el.textContent?.includes('Missing identifiers') && el.textContent.includes('Spellbinder'))!
    await user.click(within(ids).getByRole('button', { name: 'Details' }))
    for (const [f, v] of [['GTIN', '0123'], ['MPN', 'M1'], ['SKU', 'S1']]) await user.type(within(ids).getByLabelText(new RegExp(`^To be filled by merchant: ${f}`)), v)
    await user.click(within(left()).getByRole('button', { name: 'Mark all as done' }))
    expect(calls.find((c) => c.body.suggestion_id === w.find(BURTON, 'p1.identifiers').id)?.body).toMatchObject({ action: 'decide', decision: 'approve', values: { GTIN: '0123', MPN: 'M1', SKU: 'S1' } })
  })

  it('an alert marked as done shows Done and moves below the open ones; a re-scan note shows only when newer than the decision', async () => {
    const user = userEvent.setup()
    const w = await scanned()
    const returns = w.find(BURTON, 'p2.returns')
    Object.assign(returns, { status: 'approved', decided_by: 'Northwind Outfitters (demo merchant sign-in)', decided_at: '2026-10-29T03:40:46.951+00:00', rescan_result: 'Still present on re-scan.', rescan_at: '2026-10-29T03:35:53.16+00:00' })
    const markup = w.find(BURTON, 'p3.markup')
    Object.assign(markup, { status: 'still_flagged', decided_by: 'Northwind Outfitters (demo merchant sign-in)', decided_at: '2026-10-29T03:40:00+00:00', rescan_result: 'Still flagged on re-scan: the deterministic check still fails.', rescan_at: '2026-10-29T03:45:00+00:00' })
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    await showAll(user)
    const f2 = within(within(left()).getByTestId('factor-2')).getAllByTestId('optimizer-suggestion')
    const doneCard = f2.find((el) => el.textContent?.includes('vs formal terms'))!
    expect(f2[f2.length - 1]).toBe(doneCard)
    expect(doneCard).toHaveTextContent('Done')
    await user.click(within(doneCard).getByRole('button', { name: 'Details' }))
    expect(doneCard.textContent).not.toContain('Re-scan (')
    const mk = within(within(left()).getByTestId('factor-3')).getAllByTestId('optimizer-suggestion').find((el) => el.textContent?.includes('Spellbinder'))!
    await user.click(within(mk).getByRole('button', { name: 'Details' }))
    expect(mk.textContent).toContain(`Re-scan (${new Date('2026-10-29T03:45:00+00:00').toLocaleString()}): Still flagged on re-scan`)
  })

  it('Read as Agent alerts appear only after the scan button is pressed, then Mark all as done and Clear all work until the next scan', async () => {
    const user = userEvent.setup()
    const w = await scanned({ agent: scriptedAgent() })
    scanReplyId = w.tables.optimizer_scans[0].id as string
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    expect(within(right()).queryAllByTestId('read-alert')).toHaveLength(0) // the stored scan is not shown until pressed
    await user.click(within(right()).getByRole('button', { name: 'Read as Agent Scan' }))
    const alerts = await within(right()).findAllByTestId('read-alert')
    const spell = alerts.find((a) => a.textContent?.includes('Spellbinder'))!
    expect(spell).toHaveTextContent('Can this be returned?')
    expect(spell).toHaveTextContent('Agent: Yes, easy returns (“Easy returns.”)')
    expect(spell).toHaveTextContent('Your terms: "Final Sale"')
    expect(spell).toHaveTextContent('Mismatch')

    await user.click(within(right()).getByRole('button', { name: 'Mark all as done' }))
    for (const a of within(right()).getAllByTestId('read-alert')) expect(a).toHaveTextContent('Done')
    expect(within(right()).getByRole('button', { name: 'Mark all as done' })).toBeDisabled()

    await user.click(within(right()).getByRole('button', { name: 'Clear all' }))
    expect(within(right()).queryAllByTestId('read-alert')).toHaveLength(0)
    expect(within(right()).getByTestId('read-as-agent-empty')).toHaveTextContent('Cleared. Press Read as Agent Scan to list the alerts again.')
    expect(within(left()).getAllByTestId('optimizer-suggestion').length).toBeGreaterThan(0) // the 5 factors are untouched

    await user.click(within(right()).getByRole('button', { name: 'Read as Agent Scan' }))
    expect(await within(right()).findAllByTestId('read-alert')).toHaveLength(alerts.length)
    expect(within(right()).getAllByTestId('read-alert')[0]).toHaveTextContent('Mismatch')
  })

  it('a cleared Read as Agent list stays cleared when the page is opened again', async () => {
    const w = await scanned({ agent: scriptedAgent() })
    localStorage.setItem(VIEW_KEY, JSON.stringify({ scanId: w.tables.optimizer_scans[0].id, cleared: true, done: false }))
    open('/dashboard/optimization')
    await screen.findAllByTestId('optimizer-suggestion')
    expect(within(right()).getByTestId('read-as-agent-empty')).toHaveTextContent('Cleared.')
  })

  it('Read as Agent says "unavailable" and lists nothing invented when Spark is not available', async () => {
    const user = userEvent.setup()
    const w = await scanned()
    scanReplyId = w.tables.optimizer_scans[0].id as string
    open('/dashboard/optimization')
    await user.click(await screen.findByRole('button', { name: 'Read as Agent Scan' }))
    expect(await within(right()).findByTestId('read-test-unavailable')).toHaveTextContent('Agent read-test unavailable on 9 of 9 listings.')
    expect(within(right()).queryAllByTestId('read-alert')).toHaveLength(0)
    expect(within(right()).queryByTestId('read-test-all-match')).not.toBeInTheDocument()
  })

  it('while the agent is still reading, Read as Agent says so', async () => {
    const user = userEvent.setup()
    const w = await scanned({ agent: scriptedAgent() })
    for (const r of w.tables.optimizer_scans[0].results as { read_test: { source: string } }[]) r.read_test.source = 'pending'
    scanReplyId = w.tables.optimizer_scans[0].id as string
    open('/dashboard/optimization')
    await user.click(await screen.findByRole('button', { name: 'Read as Agent Scan' }))
    expect(await within(right()).findByTestId('read-test-pending')).toHaveTextContent('Agent is reading your listings… 0 of 9 done.')
  })

  it('a scan stored before Agent read-test existed lists no Read as Agent alerts', async () => {
    const user = userEvent.setup()
    const w = await scanned()
    for (const r of w.tables.optimizer_scans[0].results as Record<string, unknown>[]) delete r.read_test
    scanReplyId = w.tables.optimizer_scans[0].id as string
    open('/dashboard/optimization')
    await user.click(await screen.findByRole('button', { name: 'Read as Agent Scan' }))
    await screen.findByText(/Scan finished/)
    expect(within(right()).queryAllByTestId('read-alert')).toHaveLength(0)
  })

})

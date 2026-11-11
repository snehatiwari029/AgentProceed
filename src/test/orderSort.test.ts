import { describe, expect, it } from 'vitest'
import { buildOrders, placedLabel } from '../dashboard/pages/AgentOrders'
import type { Receipt } from '../shared/schemas'

const receipt = (id: string, order: string, sealed_at: string | null, created_at?: string) =>
  ({ id, order_ref: order, grant_id: 'g', sealed_at, created_at, action_summary: {}, decision: 'pass' }) as unknown as Receipt

describe('Agent orders: placed time and order', () => {
  it('lists orders newest first by placed time, with a gap session placed at its opened time', () => {
    const rows = buildOrders(
      [receipt('a', '12322', '2026-10-26T17:11:00Z'), receipt('b', '15001', null, '2026-11-10T09:00:00Z'), receipt('c', '13422', '2026-10-26T18:06:00Z')],
      [], [], [],
      [{ id: 's', detection_source: 'none', agent_id: null, agent_verified: false, gap_note: 'Order 14522: no receipt', opened_at: '2026-10-27T08:00:00Z' }],
    )
    expect(rows.map((r) => r.order)).toEqual(['15001', '14522', '13422', '12322'])
    expect(rows[0].placed_at).toBe('2026-11-10T09:00:00Z')
  })

  it('falls back to the higher order number when times tie or are missing, and puts rows with no time last', () => {
    const rows = buildOrders([receipt('a', '15001', null), receipt('b', '15003', null), receipt('c', '12000', '2026-01-01T00:00:00Z')], [], [], [], [])
    expect(rows.map((r) => r.order)).toEqual(['12000', '15003', '15001'])
  })

  it('shows a dash when there is no time', () => {
    expect(placedLabel(null)).toBe('–')
    expect(placedLabel('2026-10-26T17:11:00Z')).toMatch(/2026/)
  })
})

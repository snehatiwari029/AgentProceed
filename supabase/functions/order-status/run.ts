// The order system's order-status lookup. Pure TypeScript: the database is injected so tests run it.
// Session id in, order number out. Nothing else leaves: no receipt contents, no verdict, no other order.
// It only reads (one grant id, one order number) and never writes.
export interface OrderStatusDb {
  grantIdForSession(sessionId: string): Promise<string | null>
  orderRefForGrant(grantId: string): Promise<string | null>
}

export type OrderStatusReply = { type: 'order_status'; order_number: string | null } | { type: 'error'; message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function orderStatus(raw: unknown, db: OrderStatusDb): Promise<OrderStatusReply> {
  const sid = (raw as { session_id?: unknown } | null)?.session_id
  if (typeof sid !== 'string' || !UUID.test(sid)) return { type: 'error', message: 'session_id is required.' }
  const grantId = await db.grantIdForSession(sid)
  const order_number = grantId ? await db.orderRefForGrant(grantId) : null
  return { type: 'order_status', order_number }
}

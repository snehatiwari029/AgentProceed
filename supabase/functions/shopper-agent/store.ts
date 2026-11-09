// Supabase-backed Store. Runs in the edge function with the service role (auto-injected, never in the repo).
// The product query lists its columns on purpose: the fine-print columns are not on the list, so the agent cannot see them.
import { appendChained, type ChainDb } from './chain.ts'
import { MERCHANT_NAME, type ProductRow, type Step, type Store } from './agent.ts'
import type { PaymentEvent, PaymentStore } from './payment.ts'

export const PRODUCT_COLUMNS =
  'id,name,brand,category,size_cm,colour,price_cents,currency,marketing_blurb,standard_shipping_cents,standard_delivery_days,expedited_shipping_cents,expedited_delivery_days'

// deno-lint-ignore no-explicit-any
type Db = any

function must<T>(res: { data?: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

export function createStore(db: Db, newId: () => string = () => crypto.randomUUID()): Store {
  const chainDb: ChainDb = {
    async latestHash() {
      const r = await db.from('chain_entries').select('entry_hash').order('chain_seq', { ascending: false }).limit(1)
      const rows = must<{ entry_hash: string }[]>(r, 'read chain')
      return rows?.[0]?.entry_hash ?? null
    },
    async insert(table, row) {
      must(await db.from(table).insert(row), `insert ${table}`)
    },
  }
  return {
    async listProducts() {
      const r = await db.from('products').select(PRODUCT_COLUMNS).order('sort_order', { ascending: true })
      return must<ProductRow[]>(r, 'read products')
    },
    async merchantId() {
      const r = await db.from('merchants').select('id').eq('name', MERCHANT_NAME).limit(1)
      const rows = must<{ id: string }[]>(r, 'read merchant')
      if (!rows?.[0]) throw new Error('Merchant not found')
      return rows[0].id
    },
    async hasStep(sessionId, step: Step) {
      const r = await db.from('session_events').select('id').eq('session_id', sessionId).eq('step', step).limit(1)
      return (must<unknown[]>(r, 'read session log') ?? []).length > 0
    },
    async createSession(row) {
      must(await db.from('sessions').insert(row), 'insert session')
    },
    async logStep(sessionId, step, detail, simulated) {
      must(await db.from('session_events').insert({ id: newId(), session_id: sessionId, step, detail, simulated }), `log ${step}`)
    },
    async addGrant(row) {
      await appendChained(chainDb, 'grants', row)
    },
    async addProposal(row) {
      await appendChained(chainDb, 'proposals', row)
    },
    async addAction(grantId, type, detail, believed) {
      const r = await db.from('actions').select('seq').eq('grant_id', grantId).order('seq', { ascending: false }).limit(1)
      const seq = ((must<{ seq: number }[]>(r, 'read action seq')?.[0]?.seq) ?? 0) + 1
      await appendChained(chainDb, 'actions', {
        id: newId(), grant_id: grantId, seq, type, detail, agent_believed_terms: believed, image_evidence_ref: null,
      })
      return seq
    },
  }
}

// PayPal Sandbox records for one session: its own checkout total (read back from the stored checkout action, never
// from the phone), its payment events, and new payment events appended to the hash chain.
export function createPaymentStore(db: Db): PaymentStore {
  const chainDb: ChainDb = {
    async latestHash() {
      const r = await db.from('chain_entries').select('entry_hash').order('chain_seq', { ascending: false }).limit(1)
      const rows = must<{ entry_hash: string }[]>(r, 'read chain')
      return rows?.[0]?.entry_hash ?? null
    },
    async insert(table, row) {
      must(await db.from(table).insert(row), `insert ${table}`)
    },
  }
  return {
    async checkoutFor(sessionId) {
      const g = must<{ id: string; currency: string | null }[]>(
        await db.from('grants').select('id,currency').eq('session_id', sessionId).limit(1), 'read session grant')
      const grant = g?.[0]
      if (!grant) return null
      const a = must<{ detail: Record<string, unknown> }[]>(
        await db.from('actions').select('detail').eq('grant_id', grant.id).eq('type', 'checkout').order('seq', { ascending: false }).limit(1),
        'read checkout action')
      const detail = a?.[0]?.detail
      const total = detail?.total_cents
      if (!detail || typeof total !== 'number') return null
      return {
        grantId: grant.id, totalCents: total, currency: grant.currency ?? 'USD',
        rail: typeof detail.payment_rail === 'string' ? detail.payment_rail : null,
        productName: typeof detail.product_name === 'string' ? detail.product_name : null,
      }
    },
    async paymentEvents(sessionId) {
      const r = await db.from('payment_events').select('event,paypal_order_id,capture_id,status,amount_cents,currency')
        .eq('session_id', sessionId).order('chain_seq', { ascending: true })
      return must<PaymentEvent[]>(r, 'read payment events') ?? []
    },
    async addPaymentEvent(row) {
      await appendChained(chainDb, 'payment_events', row)
    },
  }
}

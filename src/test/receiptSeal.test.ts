import { describe, expect, it } from 'vitest'
import { computeEntryHash, GENESIS_HASH } from '../../supabase/functions/receipt-seal/hash'
import { NO_KEY, PREDATES_SIGNING, customIdFor, merchantKeyFromSeed, sealFromCustomId, seal, verify, verifySignature, type SealDb, type SealDeps } from '../../supabase/functions/receipt-seal/seal'
import { createPayPalClient, PAYPAL_SANDBOX_BASE } from '../../supabase/functions/shopper-agent/paypal'
import { SEAL_NOT_READY, startPayPal, type PaymentEvent, type PaymentStore } from '../../supabase/functions/shopper-agent/payment'

const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60' // RFC 8032 test vector 1
const RFC_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const SID = '11111111-2222-4333-8444-555555555555'
const ORDER = '12123471LF747714E'

async function sealedReceipt(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001', receipt_ref: 'AR-2026-0059', order_ref: '15016', grant_id: 'g-1', merchant_id: 'm-1',
    decision: 'pass', problems_found: 0, sealed_at: '2026-11-12T05:10:00.000Z', chain_seq: 7, prev_hash: GENESIS_HASH, ...over,
  }
  row.entry_hash = await computeEntryHash(row.prev_hash as string, row)
  return row
}

function world(receipt: Record<string, unknown> | null, opts: { customId?: string | null; appearAfter?: number } = {}) {
  const sigs: Record<string, unknown>[] = []
  let reads = 0
  let t = 0
  const db: SealDb = {
    receiptForSession: async () => (++reads > (opts.appearAfter ?? 0) ? receipt : null),
    receiptById: async (id) => (receipt && receipt.id === id ? receipt : null),
    receiptForPayPalOrder: async (id) => (id === ORDER ? receipt : null),
    signatureFor: async (id) => sigs.find((s) => s.receipt_id === id) ?? null,
    insertSignature: async (row) => { if (sigs.some((s) => s.receipt_id === row.receipt_id)) return 'exists'; sigs.push(row); return 'inserted' },
  }
  const auditorCalls: string[] = []
  const deps = async (): Promise<SealDeps> => ({
    db, key: await merchantKeyFromSeed(SEED), runAuditor: async (s) => void auditorCalls.push(s),
    paypalCustomId: async (id) => (id === ORDER ? { found: true, custom_id: opts.customId ?? null, status: 'COMPLETED' } : { found: false, custom_id: null, status: null }),
    now: () => new Date(Date.UTC(2026, 10, 12, 4, 0, 0) + t), newId: () => 'sig-1', sleep: async (ms) => { t += ms }, waitMs: 10_000,
  })
  return { db, sigs, deps, auditorCalls }
}

describe('Receipt seal: Ed25519 merchant signature', () => {
  it('derives the RFC 8032 public key from the seed and signs/verifies the seal string', async () => {
    const key = await merchantKeyFromSeed(SEED)
    expect(key.publicKeyHex).toBe(RFC_PUBLIC)
    expect(key.keyId).toMatch(/^ed25519:[0-9a-f]{16}$/)
    const s = `sha256:${'ab'.repeat(32)}`
    const sig = await key.sign(s)
    expect(sig).toMatch(/^[0-9a-f]{128}$/)
    expect(await verifySignature(key.publicKeyHex, s, sig)).toBe(true)
    expect(await verifySignature(key.publicKeyHex, `sha256:${'cd'.repeat(32)}`, sig)).toBe(false)
    await expect(merchantKeyFromSeed('not-hex')).rejects.toThrow(/64 hex/)
  })

  it('custom_id is "ap1:" + seal, and only a well-formed ap1 seal is read back', () => {
    const s = `sha256:${'0f'.repeat(32)}`
    expect(customIdFor(s)).toBe(`ap1:${s}`)
    expect(customIdFor(s).length).toBeLessThanOrEqual(127)
    expect(sealFromCustomId(`ap1:${s}`)).toBe(s)
    expect(sealFromCustomId(s)).toBeNull()
    expect(sealFromCustomId(`cs1:${s}`)).toBeNull()
    expect(sealFromCustomId(SID)).toBeNull()
  })

  it('seal: signs the receipt once (a repeat returns the stored signature) and waits for a receipt still being sealed', async () => {
    const r = await sealedReceipt()
    const w = world(r, { appearAfter: 2 })
    const deps = await w.deps()
    const out = await seal({ session_id: SID }, deps)
    expect(out).toMatchObject({ type: 'sealed', receipt_ref: 'AR-2026-0059', seal_hash: r.entry_hash, custom_id: `ap1:${r.entry_hash}`, public_key: RFC_PUBLIC })
    expect(w.auditorCalls).toEqual([]) // the receipt appeared while waiting: the auditor is not asked again
    const again = await seal({ session_id: SID }, deps)
    expect(again).toEqual(out)
    expect(w.sigs).toHaveLength(1)
  })

  it('seal: asks the auditor only if the receipt never appears; no key means no signature', async () => {
    const w = world(null)
    expect(await seal({ session_id: SID }, await w.deps())).toMatchObject({ type: 'error' })
    expect(w.auditorCalls).toEqual([SID])
    expect(await seal({ session_id: SID }, { ...(await w.deps()), key: null })).toEqual({ type: 'error', message: NO_KEY })
  })

  it('verify: match when PayPal custom_id carries the seal, the receipt recomputes and the signature verifies', async () => {
    const r = await sealedReceipt()
    const w = world(r, { customId: `ap1:${r.entry_hash}` })
    const deps = await w.deps()
    await seal({ session_id: SID }, deps)
    const v = await verify({ paypal_order_id: ORDER }, deps)
    expect(v).toMatchObject({ type: 'verify', result: 'match', custom_id: `ap1:${r.entry_hash}`, seal_hash: r.entry_hash })
    if (v.type === 'verify') expect(v.checks.map((c) => [c.key, c.ok])).toEqual([['custom_id', true], ['receipt', true], ['recompute', true], ['anchor', true], ['key', true], ['signature', true]])
  })

  it('verify: mismatch when custom_id is missing or different, or the receipt was edited after sealing', async () => {
    const r = await sealedReceipt()
    for (const customId of [null, SID, `ap1:sha256:${'1'.repeat(64)}`]) {
      const w = world(r, { customId })
      const deps = await w.deps()
      await seal({ session_id: SID }, deps)
      expect(await verify({ paypal_order_id: ORDER }, deps)).toMatchObject({ result: 'mismatch' })
    }
    // Edited after sealing: the stored fields no longer hash to the seal.
    const w = world(r, { customId: `ap1:${r.entry_hash}` })
    const deps = await w.deps()
    await seal({ session_id: SID }, deps)
    r.decision = 'review_required'
    const v = await verify({ paypal_order_id: ORDER }, deps)
    expect(v).toMatchObject({ result: 'mismatch' })
    if (v.type === 'verify') expect(v.checks.find((c) => c.key === 'recompute')?.ok).toBe(false)
  })

  it('verify: a receipt id without a PayPal order checks the signature only; bad input is refused', async () => {
    const r = await sealedReceipt()
    const w = world(r)
    const deps = await w.deps()
    await seal({ session_id: SID }, deps)
    const v = await verify({ receipt_id: r.id }, deps)
    expect(v).toMatchObject({ result: 'match', custom_id: null })
    if (v.type === 'verify') expect(v.checks.map((c) => c.key)).toEqual(['receipt', 'recompute', 'key', 'signature'])
    expect(await verify({ paypal_order_id: 'nope!' }, deps)).toMatchObject({ type: 'error' })
    expect(await verify({ paypal_order_id: 'AAAAAAAAAAAAAAAAA' }, deps)).toMatchObject({ type: 'error', message: 'PayPal Sandbox has no order AAAAAAAAAAAAAAAAA.' })
  })
})

describe('Receipt seal: orders sealed before signing went live', () => {
  const OLD = '2026-11-11T20:35:31.808Z' // order 15010's receipt, sealed before signing existed
  it('an unsigned receipt sealed before signing is "unsigned" with a plain message, not "mismatch"', async () => {
    const r = await sealedReceipt({ sealed_at: OLD })
    const w = world(r, { customId: SID }) // its PayPal order carries the session id, as created then
    const v = await verify({ paypal_order_id: ORDER }, await w.deps())
    expect(v).toMatchObject({ type: 'verify', result: 'unsigned', message: PREDATES_SIGNING, signature: null })
    if (v.type !== 'verify') return
    expect(v.checks.find((c) => c.key === 'recompute')?.ok).toBe(true)
    expect(v.checks.find((c) => c.key === 'signature')?.detail).toBe(PREDATES_SIGNING)
    expect(v.checks.find((c) => c.key === 'custom_id')?.detail).toMatch(/created before receipt signing/)
    expect(await verify({ receipt_id: r.id }, await w.deps())).toMatchObject({ result: 'unsigned' })
  })

  it('still "mismatch" when an old receipt no longer recomputes, or when a receipt sealed after signing has no signature', async () => {
    const old = await sealedReceipt({ sealed_at: OLD })
    old.decision = 'review_required' // edited after sealing
    expect(await verify({ paypal_order_id: ORDER }, await world(old, { customId: SID }).deps())).toMatchObject({ result: 'mismatch', message: null })
    const late = await sealedReceipt({ sealed_at: '2026-11-12T05:30:00.000Z' })
    const v = await verify({ paypal_order_id: ORDER }, await world(late, { customId: `ap1:${late.entry_hash}` }).deps())
    expect(v).toMatchObject({ result: 'mismatch' })
    if (v.type === 'verify') expect(v.checks.find((c) => c.key === 'signature')?.detail).toBe('No signature stored for this receipt')
  })
})

describe('Receipt seal: written into the PayPal order custom_id before payment', () => {
  const SEAL = `sha256:${'5b'.repeat(32)}`
  function payDeps(seal: (() => Promise<{ custom_id: string } | null>) | undefined) {
    const seen: { url: string; body?: string }[] = []
    const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      seen.push({ url, body: init.body })
      const path = url.replace(PAYPAL_SANDBOX_BASE, '')
      if (path === '/v1/oauth2/token') return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) }
      return { ok: true, status: 201, json: async () => ({ id: ORDER, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER}` }] }) }
    }
    const events: PaymentEvent[] = []
    const store: PaymentStore = {
      checkoutFor: async () => ({ grantId: 'g-1', totalCents: 37083, currency: 'USD', rail: 'paypal_sandbox', productName: 'Outerspace Living Snowboard' }),
      paymentEvents: async () => events,
      addPaymentEvent: async (row) => void events.push(row as unknown as PaymentEvent),
    }
    return { seen, events, deps: { client: createPayPalClient('id', 'secret', fetchFn), store, siteUrl: 'https://site.test', newId: () => 'e-1', seal } }
  }

  it('creates the PayPal order with custom_id = "ap1:" + seal', async () => {
    const p = payDeps(async () => ({ custom_id: `ap1:${SEAL}` }))
    const r = await startPayPal({ session_id: SID }, p.deps)
    expect(r).toMatchObject({ type: 'payment', status: 'approval_needed', paypal_order_id: ORDER })
    const create = p.seen.find((s) => s.url.endsWith('/v2/checkout/orders'))!
    expect(JSON.parse(create.body!).purchase_units[0]).toMatchObject({ reference_id: SID, custom_id: `ap1:${SEAL}` })
  })

  it('does not create a PayPal order until the receipt is sealed and signed', async () => {
    for (const seal of [async () => null, async () => { throw new Error('down') }, async () => ({ custom_id: SID })]) {
      const p = payDeps(seal)
      expect(await startPayPal({ session_id: SID }, p.deps)).toMatchObject({ type: 'payment', status: 'failed', message: SEAL_NOT_READY })
      expect(p.seen.some((s) => s.url.endsWith('/v2/checkout/orders'))).toBe(false)
      expect(p.events).toHaveLength(0)
    }
  })

  it('without the seal step (not configured), custom_id stays the session id as before', async () => {
    const p = payDeps(undefined)
    await startPayPal({ session_id: SID }, p.deps)
    const create = p.seen.find((s) => s.url.endsWith('/v2/checkout/orders'))!
    expect(JSON.parse(create.body!).purchase_units[0].custom_id).toBe(SID)
  })
})

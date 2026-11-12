// Receipt seal formalization: an Ed25519 merchant signature over each Agent Receipt's seal, and a public verify that
// checks the seal written into the PayPal order's custom_id. Pure TypeScript: the database, PayPal and the clock are
// injected, so tests run it without the network. Runs in the `receipt-seal` edge function with the service role.
//
// The seal is the receipt's own entry_hash ("sha256:<64 hex>"), exactly as the auditor sealed it. Nothing here
// changes the receipt, the hash chain or the verdict: the signature is stored in its own table (receipt_signatures).
//
//   signed message = UTF-8 bytes of the seal string, e.g. "sha256:5b4e…d845"
//   custom_id      = "ap1:" + seal                     (written on the PayPal order before payment, by shopper-agent)
//   key            = Ed25519, from the 32-byte seed in the Supabase secret MERCHANT_ED25519_SEED (never in the repo or
//                    the browser); only the public key is published (action public_key, and on each signature row).
//
// Actions:
//   public_key  the merchant's public key and the message format (public).
//   seal        session_id -> the order's receipt seal, signed (signs once; a repeat returns the stored signature).
//               Waits for the auditor's receipt if it is still being sealed. Used before the PayPal order is created.
//   verify      paypal_order_id (or receipt_id) -> reads custom_id from live PayPal Sandbox, recomputes the receipt's
//               hash from its stored fields, and checks the Ed25519 signature against the published key.
import { computeEntryHash } from './hash.ts'

type Row = Record<string, unknown>

export const CUSTOM_ID_PREFIX = 'ap1:'
export const SEAL_RE = /^sha256:[0-9a-f]{64}$/
export const ALG = 'Ed25519'
export const MESSAGE_FORMAT = 'Ed25519 signature over the UTF-8 bytes of the receipt seal string ("sha256:<64 hex>"); PayPal custom_id = "ap1:" + seal.'
const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420'
const UUID = /^[0-9a-f-]{36}$/i
const PAYPAL_ORDER_ID = /^[A-Z0-9]{8,32}$/

export const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')
export const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)))
const b64urlToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))

export type MerchantKey = { sign(message: string): Promise<string>; publicKeyHex: string; keyId: string }

// The merchant key from its 32-byte seed (64 hex). The private key stays inside this object.
export async function merchantKeyFromSeed(seedHex: string): Promise<MerchantKey> {
  const seed = seedHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('MERCHANT_ED25519_SEED must be 64 hex characters (32 bytes).')
  const pkcs8 = unhex(PKCS8_ED25519_PREFIX + seed)
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', priv)
  if (typeof jwk.x !== 'string') throw new Error('Could not derive the Ed25519 public key.')
  const publicKeyHex = hex(b64urlToBytes(jwk.x))
  const keyId = `ed25519:${(await sha256(publicKeyHex)).slice(0, 16)}`
  return {
    publicKeyHex, keyId,
    sign: async (message) => hex(await crypto.subtle.sign({ name: 'Ed25519' }, priv, new TextEncoder().encode(message))),
  }
}

async function sha256(text: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

export async function verifySignature(publicKeyHex: string, message: string, signatureHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex) || !/^[0-9a-f]{128}$/.test(signatureHex)) return false
  try {
    const pub = await crypto.subtle.importKey('raw', unhex(publicKeyHex), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, pub, unhex(signatureHex), new TextEncoder().encode(message))
  } catch {
    return false
  }
}

export const customIdFor = (seal: string) => `${CUSTOM_ID_PREFIX}${seal}`
export function sealFromCustomId(customId: unknown): string | null {
  if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null
  const seal = customId.slice(CUSTOM_ID_PREFIX.length)
  return SEAL_RE.test(seal) ? seal : null
}

export interface SealDb {
  receiptForSession(sessionId: string): Promise<Row | null>
  receiptById(id: string): Promise<Row | null>
  receiptForPayPalOrder(paypalOrderId: string): Promise<Row | null>
  signatureFor(receiptId: string): Promise<Row | null>
  insertSignature(row: Row): Promise<'inserted' | 'exists'>
}

export type SealDeps = {
  db: SealDb
  key: MerchantKey | null // null when MERCHANT_ED25519_SEED is not set
  // Asks the auditor to seal the order's receipt (idempotent per order). Used only if the receipt never appears.
  runAuditor: (sessionId: string) => Promise<void>
  // Reads a PayPal Sandbox order (GET /v2/checkout/orders/{id}); returns its first purchase unit's custom_id.
  paypalCustomId: ((paypalOrderId: string) => Promise<{ found: boolean; custom_id: string | null; status: string | null }>) | null
  now: () => Date
  newId: () => string
  sleep: (ms: number) => Promise<void>
  waitMs?: number // how long to wait for a receipt still being sealed (default 20s)
}

export type Signature = { seal_hash: string; custom_id: string; signature: string; key_id: string; public_key: string; alg: string; signed_at: string }
export type Check = { key: string; label: string; ok: boolean; detail: string }
export type Reply =
  | { type: 'public_key'; alg: string; key_id: string; public_key: string; message_format: string }
  | ({ type: 'sealed'; receipt_ref: string | null; order_ref: string | null } & Signature)
  | {
    type: 'verify'; result: 'match' | 'mismatch'; paypal_order_id: string | null; paypal_status: string | null
    custom_id: string | null; receipt_ref: string | null; order_ref: string | null; seal_hash: string | null
    signature: string | null; key_id: string | null; public_key: string | null; checks: Check[]
  }
  | { type: 'error'; message: string }

export const NO_KEY = 'The merchant signing key is not set up on the server (MERCHANT_ED25519_SEED).'
const err = (message: string): Reply => ({ type: 'error', message })
const str = (v: unknown) => (typeof v === 'string' ? v : null)

function sigOut(row: Row): Signature {
  return {
    seal_hash: String(row.seal_hash), custom_id: customIdFor(String(row.seal_hash)), signature: String(row.signature),
    key_id: String(row.key_id), public_key: String(row.public_key), alg: String(row.alg), signed_at: String(row.signed_at),
  }
}

// Signs one receipt's seal once. A repeat (or a race) returns the stored signature.
export async function ensureSignature(receipt: Row, deps: SealDeps): Promise<Signature> {
  const existing = await deps.db.signatureFor(String(receipt.id))
  if (existing) return sigOut(existing)
  if (!deps.key) throw new Error(NO_KEY)
  const seal = String(receipt.entry_hash)
  if (!SEAL_RE.test(seal)) throw new Error('The receipt has no seal hash.')
  const row = {
    id: deps.newId(), receipt_id: receipt.id, merchant_id: receipt.merchant_id, seal_hash: seal, alg: ALG,
    key_id: deps.key.keyId, public_key: deps.key.publicKeyHex, signature: await deps.key.sign(seal), signed_at: deps.now().toISOString(),
  }
  if ((await deps.db.insertSignature(row)) === 'exists') {
    const again = await deps.db.signatureFor(String(receipt.id))
    if (again) return sigOut(again)
  }
  return sigOut(row)
}

export async function seal(body: Row, deps: SealDeps): Promise<Reply> {
  const sid = body.session_id
  if (typeof sid !== 'string' || !UUID.test(sid)) return err('session_id is required.')
  if (!deps.key) return err(NO_KEY)
  // The auditor seals the receipt in the background right after the order; wait for it before asking again.
  let receipt = await deps.db.receiptForSession(sid)
  const until = deps.now().getTime() + (deps.waitMs ?? 20_000)
  while (!receipt && deps.now().getTime() < until) {
    await deps.sleep(1_500)
    receipt = await deps.db.receiptForSession(sid)
  }
  if (!receipt) {
    await deps.runAuditor(sid)
    receipt = await deps.db.receiptForSession(sid)
  }
  if (!receipt) return err('No receipt has been sealed for this order yet.')
  try {
    return { type: 'sealed', receipt_ref: str(receipt.receipt_ref), order_ref: str(receipt.order_ref), ...(await ensureSignature(receipt, deps)) }
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Could not sign the receipt seal.')
  }
}

// Public verify. Given a PayPal order id: custom_id from live PayPal, the receipt recomputed from its stored fields,
// and the signature checked against the merchant's published key. Given a receipt id (no PayPal order): the same
// without the PayPal check.
export async function verify(body: Row, deps: SealDeps): Promise<Reply> {
  if (!deps.key) return err(NO_KEY)
  const ppId = typeof body.paypal_order_id === 'string' ? body.paypal_order_id.trim() : null
  const receiptId = typeof body.receipt_id === 'string' ? body.receipt_id : null
  if (ppId !== null && !PAYPAL_ORDER_ID.test(ppId)) return err('That is not a PayPal order id.')
  if (ppId === null && (receiptId === null || !UUID.test(receiptId))) return err('paypal_order_id (or receipt_id) is required.')

  const checks: Check[] = []
  let customId: string | null = null
  let ppStatus: string | null = null
  let receipt: Row | null
  if (ppId) {
    if (!deps.paypalCustomId) return err('PayPal Sandbox is not set up on the server.')
    const pp = await deps.paypalCustomId(ppId)
    if (!pp.found) return err(`PayPal Sandbox has no order ${ppId}.`)
    customId = pp.custom_id
    ppStatus = pp.status
    receipt = await deps.db.receiptForPayPalOrder(ppId)
  } else receipt = await deps.db.receiptById(receiptId as string)

  const sig = receipt ? await deps.db.signatureFor(String(receipt.id)) : null
  const stored = receipt ? str(receipt.entry_hash) : null
  const recomputed = receipt && typeof receipt.prev_hash === 'string' ? await computeEntryHash(receipt.prev_hash, receipt) : null
  const anchored = sealFromCustomId(customId)

  if (ppId) {
    checks.push({ key: 'custom_id', label: 'PayPal custom_id carries an ap1 seal', ok: anchored !== null, detail: customId ? `custom_id = ${customId}` : 'custom_id is empty on the PayPal order' })
  }
  checks.push({ key: 'receipt', label: 'Agent Receipt found for this order', ok: !!receipt, detail: receipt ? `${str(receipt.receipt_ref)} · order ${str(receipt.order_ref) ?? '–'}` : 'No receipt is linked to this order' })
  checks.push({
    key: 'recompute', label: 'Receipt hash recomputes from its stored fields', ok: !!stored && recomputed === stored,
    detail: recomputed ? `recomputed ${recomputed}${stored && recomputed !== stored ? ` ≠ stored ${stored}` : ''}` : 'Nothing to recompute',
  })
  if (ppId) {
    checks.push({ key: 'anchor', label: 'custom_id seal equals the receipt seal', ok: !!anchored && anchored === stored && anchored === recomputed, detail: anchored ? `${anchored}` : 'No seal in custom_id' })
  }
  const keyOk = !!sig && sig.public_key === deps.key.publicKeyHex
  checks.push({ key: 'key', label: 'Signed with the merchant\'s published key', ok: keyOk, detail: sig ? `${String(sig.key_id)}` : 'No signature stored for this receipt' })
  const sigOk = !!sig && !!stored && String(sig.seal_hash) === stored && (await verifySignature(deps.key.publicKeyHex, stored, String(sig.signature)))
  checks.push({ key: 'signature', label: 'Ed25519 signature over the seal verifies', ok: sigOk, detail: sig ? `signature ${String(sig.signature).slice(0, 24)}…` : 'No signature stored for this receipt' })

  return {
    type: 'verify', result: checks.every((c) => c.ok) ? 'match' : 'mismatch', paypal_order_id: ppId, paypal_status: ppStatus,
    custom_id: customId, receipt_ref: receipt ? str(receipt.receipt_ref) : null, order_ref: receipt ? str(receipt.order_ref) : null,
    seal_hash: stored, signature: sig ? String(sig.signature) : null, key_id: sig ? String(sig.key_id) : null, public_key: deps.key.publicKeyHex, checks,
  }
}

export async function publicKey(_body: Row, deps: SealDeps): Promise<Reply> {
  if (!deps.key) return err(NO_KEY)
  return { type: 'public_key', alg: ALG, key_id: deps.key.keyId, public_key: deps.key.publicKeyHex, message_format: MESSAGE_FORMAT }
}

export const ROUTES: Record<string, (body: Row, deps: SealDeps) => Promise<Reply>> = { public_key: publicKey, seal, verify }

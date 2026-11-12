// PayPal Sandbox Disputes API (customer disputes v1), for the Dispute page's "Submit evidence to PayPal (Sandbox)".
// Same pattern as the Orders client in shopper-agent/paypal.ts: plain REST, OAuth client credentials, fetch injected so
// tests run without the network. The base URL is fixed to PayPal's Sandbox, so this build cannot reach live PayPal.
// The client id and secret come only from the Supabase edge-function secrets PAYPAL_CLIENT_ID and PAYPAL_SECRET (read
// by name in index.ts); they never reach the browser.
//
// Steps, in order (submitEvidence):
//   1. OAuth access token (client credentials).
//   2. List disputes filtered by disputed_transaction_id (the PayPal capture id) and take PayPal's canonical dispute_id
//      from the response. The PP-R case number the buyer sees is never used as the id.
//   3. Dispute details: is there a HATEOAS `provide_evidence` link? If not (for example the dispute is still in INQUIRY),
//      stop and say evidence submission is not available yet. Nothing is sent.
//   4. POST /v1/customer/disputes/{dispute_id}/provide-evidence (multipart/form-data, part "input"), then read the
//      dispute again for its updated status.

export const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'

// PayPal dispute ids (PP-D-…) and transaction / capture ids: letters, digits and dashes only (safe in a URL path).
export const PAYPAL_DISPUTE_ID = /^[A-Z0-9-]{4,64}$/i
export const PAYPAL_TRANSACTION_ID = /^[A-Z0-9]{8,32}$/

export type DisputesFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | FormData; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly issue: string | null, readonly detail: string | null = null, readonly dispute: DisputeSummary | null = null, readonly attempts: Attempt[] = []) {
    super(message)
    this.name = 'PayPalError'
  }
}

type Link = { rel?: unknown; href?: unknown; method?: unknown }
export type DisputeSummary = {
  dispute_id: string
  status: string | null
  reason: string | null
  stage: string | null // dispute_life_cycle_stage: INQUIRY, CHARGEBACK, PRE_ARBITRATION, ARBITRATION
  dispute_state: string | null
  amount: string | null
  currency: string | null
  create_time: string | null
  update_time: string | null
  seller_response_due_date: string | null
  links: string[] // HATEOAS rels, for display
}

// candidates: PayPal evidence entries to try, in order. PayPal decides which types a dispute accepts; the next one is
// tried only when PayPal answers EVIDENCE_TYPE_IS_NOT_ALLOWED. The notes are the same for every type.
// blocked: the record holds nothing PayPal accepts for this dispute (said plainly; nothing is sent, nothing is made up).
export type EvidenceCandidate = { evidence_type: string; evidence_info?: Record<string, unknown> }
export type EvidenceInput = { candidates: EvidenceCandidate[]; notes: string } | { blocked: string }
export type Attempt = { evidence_type: string; status: number; issue: string | null }

export type SubmitResult =
  | { outcome: 'no_dispute'; transaction_id: string; message: string }
  | { outcome: 'not_available'; transaction_id: string; dispute: DisputeSummary; message: string }
  | { outcome: 'not_submitted'; transaction_id: string; dispute: DisputeSummary; message: string }
  | { outcome: 'submitted'; transaction_id: string; dispute_before: DisputeSummary; dispute: DisputeSummary; response: unknown; request: unknown; attempts: Attempt[] }

export interface PayPalDisputesClient {
  // evidence is built from the dispute PayPal returned (its reason is part of the notes).
  submitEvidence(transactionId: string, evidence: (dispute: DisputeSummary) => EvidenceInput, requestId: string): Promise<SubmitResult>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

const issueOf = (body: unknown): string | null => {
  const b = body as { details?: { issue?: unknown }[]; name?: unknown; error?: unknown } | null
  const issue = b?.details?.[0]?.issue ?? b?.name ?? b?.error
  return typeof issue === 'string' ? issue.slice(0, 80) : null
}
// PayPal's own explanation, shown plainly on the page (no secrets are ever in it).
const detailOf = (body: unknown): string | null => {
  const b = body as { message?: unknown; error_description?: unknown; details?: { issue?: unknown; description?: unknown; field?: unknown; value?: unknown }[] } | null
  const parts = [
    str(b?.message) ?? str(b?.error_description),
    ...(b?.details ?? []).map((d) => [str(d.issue), str(d.field), str(d.value), str(d.description)].filter(Boolean).join(': ')),
  ]
  const t = parts.filter(Boolean).join(' · ')
  return t ? t.slice(0, 600) : null
}

export function summarize(d: Record<string, unknown>): DisputeSummary {
  const amount = (d.dispute_amount ?? null) as { value?: unknown; currency_code?: unknown } | null
  return {
    dispute_id: String(d.dispute_id ?? ''),
    status: str(d.status),
    reason: str(d.reason),
    stage: str(d.dispute_life_cycle_stage),
    dispute_state: str(d.dispute_state),
    amount: str(amount?.value),
    currency: str(amount?.currency_code),
    create_time: str(d.create_time),
    update_time: str(d.update_time),
    seller_response_due_date: str(d.seller_response_due_date),
    links: ((d.links ?? []) as Link[]).map((l) => str(l.rel)).filter((r): r is string => !!r),
  }
}

// The provide_evidence action link, accepted only when it points at the Sandbox host.
export function provideEvidenceHref(d: Record<string, unknown>): string | null {
  const link = ((d.links ?? []) as Link[]).find((l) => l.rel === 'provide_evidence')
  const href = str(link?.href)
  return href && href.startsWith(`${PAYPAL_SANDBOX_BASE}/`) ? href : null
}

// Several disputes on one transaction: an open one first, then the newest.
const OPEN_FIRST = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const closed = (x: Record<string, unknown>) => (x.status === 'RESOLVED' ? 1 : 0)
  return closed(a) - closed(b) || String(b.create_time ?? '').localeCompare(String(a.create_time ?? ''))
}

export function createPayPalDisputesClient(clientId: string, secret: string, fetchFn: DisputesFetch = fetch as unknown as DisputesFetch): PayPalDisputesClient {
  if (!clientId || !secret) throw new Error('PayPal Sandbox is not configured')
  let token: { value: string; until: number } | null = null

  async function accessToken(): Promise<string> {
    if (token && token.until > Date.now() + 60_000) return token.value
    const res = await fetchFn(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    if (!res.ok || typeof body?.access_token !== 'string') throw new PayPalError('PayPal Sandbox sign-in failed', res.status, issueOf(body), detailOf(body))
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 300
    token = { value: body.access_token, until: Date.now() + ttl * 1000 }
    return token.value
  }

  async function call(method: 'GET' | 'POST', url: string, what: string, extra: { body?: FormData; requestId?: string } = {}): Promise<unknown> {
    if (!url.startsWith(`${PAYPAL_SANDBOX_BASE}/`)) throw new Error('Only PayPal Sandbox is allowed')
    const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' }
    if (extra.requestId) headers['PayPal-Request-Id'] = extra.requestId
    // multipart/form-data: fetch sets the Content-Type with its boundary itself.
    const res = await fetchFn(url, { method, headers, body: extra.body, signal: AbortSignal.timeout(20_000) })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new PayPalError(`PayPal Sandbox ${what} returned ${res.status}`, res.status, issueOf(body), detailOf(body))
    return body
  }

  const details = async (id: string) => (await call('GET', `${PAYPAL_SANDBOX_BASE}/v1/customer/disputes/${id}`, 'dispute details')) as Record<string, unknown>

  return {
    async submitEvidence(transactionId, evidence, requestId) {
      if (!PAYPAL_TRANSACTION_ID.test(transactionId)) throw new Error('Bad PayPal transaction id')
      const list = (await call('GET', `${PAYPAL_SANDBOX_BASE}/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(transactionId)}`, 'list disputes')) as { items?: Record<string, unknown>[] } | null
      const items = (list?.items ?? []).filter((i) => typeof i.dispute_id === 'string' && PAYPAL_DISPUTE_ID.test(i.dispute_id))
      if (items.length === 0) return { outcome: 'no_dispute', transaction_id: transactionId, message: `PayPal Sandbox has no dispute on transaction ${transactionId}.` }
      const disputeId = [...items].sort(OPEN_FIRST)[0].dispute_id as string

      const before = await details(disputeId)
      if (!provideEvidenceHref(before)) {
        const s = summarize(before)
        return {
          outcome: 'not_available', transaction_id: transactionId, dispute: s,
          message: `Evidence submission is not available yet for PayPal dispute ${disputeId}: PayPal offers no provide_evidence action at this stage (status ${s.status ?? 'unknown'}, lifecycle stage ${s.stage ?? 'unknown'}). Nothing was sent.`,
        }
      }

      const e = evidence(summarize(before))
      if ('blocked' in e) return { outcome: 'not_submitted', transaction_id: transactionId, dispute: summarize(before), message: e.blocked }
      const attempts: Attempt[] = []
      for (const c of e.candidates) {
        const type = c.evidence_type
        const input = { evidences: [{ evidence_type: type, ...(c.evidence_info ? { evidence_info: c.evidence_info } : {}), notes: e.notes.slice(0, 2000) }] }
        const form = new FormData()
        form.append('input', new Blob([JSON.stringify(input)], { type: 'application/json' }), 'input.json')
        try {
          const response = await call('POST', `${PAYPAL_SANDBOX_BASE}/v1/customer/disputes/${disputeId}/provide-evidence`, 'provide-evidence', { body: form, requestId: `${requestId}-${type}` })
          attempts.push({ evidence_type: type, status: 200, issue: null })
          const after = await details(disputeId)
          return { outcome: 'submitted', transaction_id: transactionId, dispute_before: summarize(before), dispute: summarize(after), response, request: input, attempts }
        } catch (x) {
          if (!(x instanceof PayPalError)) throw x
          attempts.push({ evidence_type: type, status: x.status, issue: x.issue })
          if (x.issue !== 'EVIDENCE_TYPE_IS_NOT_ALLOWED') throw new PayPalError(x.message, x.status, x.issue, x.detail, summarize(before), attempts)
        }
      }
      throw new PayPalError('PayPal Sandbox accepted none of the evidence types tried', 400, 'EVIDENCE_TYPE_IS_NOT_ALLOWED', attempts.map((a) => a.evidence_type).join(', '), summarize(before), attempts)
    },
  }
}

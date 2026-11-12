import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Dispute, DisputeEvent, MerchantReview, Receipt, Shipment } from '../../shared/schemas'
import { verifyOrderChain, type OrderChainCheck } from '../../shared/chain'
import { formatMoney } from '../../shared/format'
import {
  CLAIM_TYPES, CLAIM_TYPE_LABEL, DISCLAIMER, PROCESSORS, PROCESSOR_LABEL, SAMPLE_LABEL, buildPack, merchantInputNeeds,
  type Gate, type Pack, type Processor, type TextSource, type Texts,
} from '../../../supabase/functions/disputes/pack'
import { DISPUTE_STATUS, PACK_STATUSES, packStatus, shownEvents } from '../status'
import { loadOrderChain, num, str, useRows, type Rows } from '../data'
import { callDisputes, MERCHANT_NAME } from '../disputes'
import { sampleDisputeFor, SAMPLE_ORDER_REF } from '../sampleDispute'
import { packExport, packToHtml } from '../packView'
import { Card, Empty, Live, PageTitle } from '../components/Panel'
import VerdictTable from '../components/VerdictTable'
import PayPalEvidence, { type EvidenceSubmission } from '../components/PayPalEvidence'
import WebhookDispute, { type WebhookDisputeRow } from '../components/WebhookDispute'

type Merchant = { id: string; name: string }
type Row = Record<string, unknown>

// One dispute's own records, read by id (never another order's): grant, proposal, checkout action, receipt, shipment,
// merchant review records and the dispute's events. The tamper check runs on exactly these chain records.
type Loaded = {
  grant: Row | null
  proposal: Row | null
  action: Row | null
  shipment: Shipment | null
  reviews: MerchantReview[]
  events: DisputeEvent[]
  check: OrderChainCheck
}
type Load = { status: 'checking' } | { status: 'error'; message: string } | { status: 'done'; data: Loaded }

function useDisputeRecord(receipt: Receipt, disputeId: string, reload: number): Load {
  const [state, setState] = useState<Load>({ status: 'checking' })
  useEffect(() => {
    let cancelled = false
    setState({ status: 'checking' })
    loadOrderChain(receipt as unknown as Parameters<typeof loadOrderChain>[0], disputeId)
      .then(async ({ records, hashAt }) => {
        const check = await verifyOrderChain(records, hashAt)
        const of = (t: string) => records.filter((r) => r.entry_type === t).map((r) => r.row as Row)
        const actions = of('action').filter((a) => a.type === 'checkout').sort((a, b) => Number(b.seq) - Number(a.seq))
        return {
          grant: of('grant')[0] ?? null, proposal: of('proposal')[0] ?? null, action: actions[0] ?? null,
          shipment: (of('shipment')[0] as unknown as Shipment) ?? null,
          reviews: of('merchant_review').sort((a, b) => Number(a.chain_seq) - Number(b.chain_seq)) as unknown as MerchantReview[],
          events: of('dispute_event').sort((a, b) => Number(a.chain_seq) - Number(b.chain_seq)) as unknown as DisputeEvent[],
          check,
        }
      })
      .then(
        (data) => { if (!cancelled) setState({ status: 'done', data }) },
        (e: unknown) => { if (!cancelled) setState({ status: 'error', message: e instanceof Error ? e.message : 'Could not read the record.' }) },
      )
    return () => { cancelled = true }
  }, [receipt, disputeId, reload])
  return state
}

const gateOf = (c: OrderChainCheck): Gate =>
  c.ok && c.receipt_hash
    ? { status: 'passed', receipt_hash: c.receipt_hash }
    : { status: 'failed', message: c.failed?.message ?? 'The chain did not verify.', failing_link: c.failed ? `entry ${c.failed.chain_seq} (${c.failed.entry_type ?? 'unknown'}), stored ${c.failed.stored_hash ?? 'none'}, recomputed ${c.failed.recomputed_hash ?? 'none'}` : null }

const latestPackEvent = (events: DisputeEvent[], processor: Processor) =>
  [...events].reverse().find((e) => e.event_type === 'pack_generated' && e.basis.processor === processor) ?? null

function usePack(d: Dispute, receipt: Receipt, merchant: Merchant, load: Load, processor: Processor, override: { texts: Texts | null; source: TextSource } | null) {
  const [pack, setPack] = useState<Pack | null>(null)
  useEffect(() => {
    if (load.status !== 'done') { setPack(null); return }
    let cancelled = false
    const rec = latestPackEvent(load.data.events, processor)
    const texts = override ? override.texts : ((rec?.basis.texts as Texts | null | undefined) ?? null)
    const source = override ? override.source : rec?.basis.text_source === 'muse-spark' ? 'muse-spark' : 'rules-fallback'
    buildPack({
      processor, merchant, receipt: receipt as unknown as Row, grant: load.data.grant, proposal: load.data.proposal, action: load.data.action,
      shipment: load.data.shipment as unknown as Row | null, reviews: load.data.reviews as unknown as Row[], dispute: d as unknown as Row,
      gate: gateOf(load.data.check), texts, text_source: source,
    }).then((p) => { if (!cancelled) setPack(p) })
    return () => { cancelled = true }
  }, [d, receipt, merchant, load, processor, override])
  return pack
}

const short = (h: string | null | undefined) => (h ? `${h.slice(0, 15)}…${h.slice(-6)}` : 'none')
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null)
const disputeDay = (d: Dispute) => d.dispute_date ?? d.opened_at.slice(0, 10)
// The dispute date as filed, or, when it was not filed, when the dispute was recorded in AgentReceipt (said as such).
const disputeDateLabel = (d: Dispute) => (d.dispute_date ? d.dispute_date : `dispute date not filed · recorded ${d.opened_at.slice(0, 10)}`)
const filedProcessor = (d: Dispute): Processor | null => (d.processor === 'visa' || d.processor === 'mastercard' ? d.processor : null)

const INPUT = 'w-full rounded-md border border-dash-edge bg-dash-card-raised px-2 py-1.5 text-sm text-dash-ink'
const BTN = 'rounded-md border border-dash-teal px-3 py-1.5 text-sm font-semibold text-dash-teal hover:bg-dash-card-raised disabled:cursor-not-allowed disabled:opacity-50'
const LABEL = 'block text-xs font-semibold uppercase tracking-wider text-dash-label'
// Data legend. Real record values are blue, sample dispute-notice values are orange (section accent + value colour,
// never a per-field tag). Missing keeps its own grey "Missing" chip, so it never reads as sample.
const REAL = 'text-dash-real'
const SAMPLE = 'text-dash-sample'
const TONE: Record<'record' | 'sample', string> = { record: 'border-l-4 border-dash-real pl-3', sample: 'border-l-4 border-dash-sample pl-3' }
function MissingChip() {
  return <span className="mr-1 inline-block rounded border border-dashed border-dash-label px-1 text-xs font-semibold uppercase tracking-wider text-dash-label">Missing</span>
}
export function Legend({ testid }: { testid: string }) {
  return (
    <div className="mb-4 rounded-lg border border-dash-edge bg-dash-card-raised px-3 py-2 text-sm text-dash-body" data-testid={testid}>
      <p data-legend>
        <span className={`font-semibold ${REAL}`}>Blue</span>{' = real data from the transaction record. '}
        <span className={`font-semibold ${SAMPLE}`}>Orange</span>{' = sample data — what we would receive from merchant dispute records when the store is connected.'}
      </p>
      <p className="mt-1 text-xs text-dash-label"><MissingChip />= not in the record; each missing item says where to obtain it.</p>
    </div>
  )
}

export default function Disputes() {
  const [reload, setReload] = useState(0)
  const merchants = useRows<Merchant>('merchants', 'name', true)
  const disputes = useRows<Dispute>('disputes', 'opened_at', false, reload)
  const receipts = useRows<Receipt>('receipts', 'chain_seq', false, reload)
  const events = useRows<DisputeEvent>('dispute_events', 'chain_seq', true, reload)
  const shipments = useRows<Shipment>('shipments', 'chain_seq', true, reload)
  // PayPal Sandbox payments (read-only). Not part of the page's load state: if it cannot be read, the page is unchanged.
  const payments = useRows<PaymentRow>('payment_events', 'chain_seq', true, reload)
  // Evidence submissions PayPal accepted (read-only). Like payments, not part of the page's load state.
  const submissions = useRows<EvidenceSubmission>('paypal_evidence_submissions', 'submitted_at', true, reload)
  // PayPal disputes received through the verified PayPal webhook (read-only). Not part of the page's load state either.
  const webhookDisputes = useRows<WebhookDisputeRow>('paypal_dispute_records', 'created_at', false, reload)
  const [open, setOpen] = useState<string | null>(null)
  const [auto, setAuto] = useState<string | null>(null)

  const all = [merchants, disputes, receipts, events, shipments]
  const failed = all.find((x) => x.status === 'error')
  const state: Rows<number> = failed ? (failed as Rows<number>) : all.some((x) => x.status === 'loading') ? { status: 'loading' } : { status: 'ready', rows: [0] }

  // The guided tour asks for one dispute to be opened, by order number.
  const [openRef, setOpenRef] = useState<string | null>(null)
  useEffect(() => {
    const onOpen = (e: Event) => setOpenRef((e as CustomEvent<string>).detail)
    window.addEventListener('agentreceipt:open-dispute', onOpen)
    return () => window.removeEventListener('agentreceipt:open-dispute', onOpen)
  }, [])

  return (
    <div>
      <PageTitle title="Disputes">
        Disputes for shipped orders only. A dispute pack is built only after an order ships and a dispute arrives. Orders on
        hold, Review Required, or Hold for Suspicion with no shipment do not appear here.
      </PageTitle>
      <p className="-mt-3 mb-6 max-w-3xl text-sm text-dash-body" data-testid="disputes-disclaimer">
        Evidence Packet prepares the pack. You submit it to your acquirer, and you decide with your acquirer whether to fight or
        concede. {DISCLAIMER}
      </p>

      <Legend testid="legend-list" />
      <Live state={state}>
        {() => {
          const merchant = merchants.status === 'ready' ? merchants.rows.find((m) => m.name === MERCHANT_NAME) : undefined
          const none = <Empty title="No disputes yet.">A dispute appears here when a shipped agent order is disputed and you record it, together with the evidence package built from that order's record. This page reads the database live.</Empty>
          if (!merchant) return disputes.status === 'ready' && disputes.rows.length === 0 ? none : <Empty title="Merchant not found.">No merchant named {MERCHANT_NAME} in the merchants table.</Empty>
          const rcpts = receipts.status === 'ready' ? receipts.rows : []
          const evs = events.status === 'ready' ? events.rows : []
          const ships = shipments.status === 'ready' ? shipments.rows : []
          const paid = paypalCaptures(rcpts.filter((r) => r.merchant_id === merchant.id), payments.status === 'ready' ? payments.rows : [], submissions.status === 'ready' ? submissions.rows : [])
          // This merchant's disputes only: a dispute belongs to the merchant of its order's receipt.
          const rows: ListRow[] = (disputes.status === 'ready' ? disputes.rows : [])
            .map((d) => ({ d, receipt: rcpts.find((r) => r.id === d.receipt_id && r.merchant_id === merchant.id) }))
            .filter((x): x is { d: Dispute; receipt: Receipt } => !!x.receipt)
            .map((x) => ({ ...x, events: evs.filter((e) => e.dispute_id === x.d.id), shipment: ships.find((s) => s.receipt_id === x.receipt.id) ?? null, paypal: paid.find((p) => p.receipt.id === x.receipt.id) ?? null }))
          // The sample example: order 13422's real record with sample dispute-notice data. Built here, never stored.
          const base = rcpts.find((r) => r.order_ref === SAMPLE_ORDER_REF && r.merchant_id === merchant.id)
          if (base) rows.push({ d: sampleDisputeFor(base), receipt: base, events: [], shipment: ships.find((s) => s.receipt_id === base.id) ?? null, sample: true })
          return (
            <DisputesBody
              merchant={merchant} rows={rows} paid={paid} webhook={webhookDisputes.status === 'ready' ? webhookDisputes.rows : []} open={open} setOpen={setOpen} auto={auto}
              openRef={openRef} clearOpenRef={() => setOpenRef(null)}
              onRecorded={(id) => { setAuto(id); setOpen(id); setReload((n) => n + 1) }}
              onChanged={() => setReload((n) => n + 1)} reload={reload} clearAuto={() => setAuto(null)}
            />
          )
        }}
      </Live>
    </div>
  )
}

type ListRow = { d: Dispute; receipt: Receipt; events: DisputeEvent[]; shipment: Shipment | null; sample?: boolean; paypal?: PayPalCapture | null }

// ---------- PayPal Sandbox ----------
type PaymentRow = { grant_id: string; event: string; paypal_order_id: string | null; capture_id: string | null; chain_seq: number }
type PayPalCapture = { receipt: Receipt; paypal_order_id: string | null; capture_id: string; submission: EvidenceSubmission | null }
// Orders paid through PayPal Sandbox: the last captured payment of each order's grant, newest order first.
function paypalCaptures(receipts: Receipt[], payments: PaymentRow[], submissions: EvidenceSubmission[]): PayPalCapture[] {
  const out: PayPalCapture[] = []
  for (const r of receipts) {
    const cap = payments.filter((p) => p.grant_id === r.grant_id && p.event === 'captured' && p.capture_id).pop()
    // The latest accepted submission on this order's own transaction.
    const submission = submissions.filter((x) => x.receipt_id === r.id && x.capture_id === cap?.capture_id).pop() ?? null
    if (cap?.capture_id) out.push({ receipt: r, paypal_order_id: cap.paypal_order_id, capture_id: cap.capture_id, submission })
  }
  return out.sort((a, b) => (b.receipt.sealed_at ?? '').localeCompare(a.receipt.sealed_at ?? ''))
}

function PayPalDisputes({ merchant, paid, rows, webhook }: { merchant: Merchant; paid: PayPalCapture[]; rows: ListRow[]; webhook: WebhookDisputeRow[] }) {
  // An unmatched webhook dispute is shown here too: it has no order of this merchant to hang on.
  const unmatched = webhook.filter((w) => !w.matched)
  if (paid.length === 0 && unmatched.length === 0) return null
  return (
    <Card label="PayPal Sandbox disputes">
      <p className="mb-3 text-sm text-dash-body" data-testid="paypal-disputes-intro">
        Orders paid through PayPal Sandbox (test money). Submit evidence sends this order&apos;s evidence to the PayPal dispute on its
        transaction: receipt hash, PayPal order and transaction IDs, reason code and the pre-fulfillment verdict. PayPal decides
        whether evidence can be submitted at the dispute&apos;s current stage; the answer is shown as PayPal returned it. Sandbox only.
      </p>
      <div className="flex flex-col gap-3">
        {paid.map((p) => {
          const sum = p.receipt.action_summary
          const product = [str(sum.brand), str(sum.product_name)].filter(Boolean).join(' ')
          const total = num(sum.total_cents)
          return (
            <div key={p.receipt.id}>
              <p className="mb-1 text-xs text-dash-label">{product || 'Product not in record'}{total === null ? '' : ` · ${formatMoney(total)}`} · {p.receipt.receipt_ref}</p>
              <PayPalEvidence
                merchantId={merchant.id} receiptId={p.receipt.id} disputeId={rows.find((r) => !r.sample && r.receipt.id === p.receipt.id)?.d.id ?? null}
                orderRef={p.receipt.order_ref} paypalOrderId={p.paypal_order_id} captureId={p.capture_id} submission={p.submission}
              />
              {webhook.filter((w) => w.receipt_id === p.receipt.id).map((w) => <WebhookDispute key={w.paypal_dispute_id} d={w} />)}
            </div>
          )
        })}
      </div>
      {unmatched.length > 0 && (
        <div className="mt-4" data-testid="webhook-unmatched">
          <p className="text-xs font-semibold uppercase tracking-wider text-dash-label">Received by PayPal webhook, not matched to a recorded order</p>
          {unmatched.map((w) => <WebhookDispute key={w.paypal_dispute_id} d={w} />)}
        </div>
      )}
    </Card>
  )
}

function DisputesBody(props: {
  merchant: Merchant; rows: ListRow[]; paid: PayPalCapture[]; webhook: WebhookDisputeRow[]; open: string | null; setOpen: (id: string | null) => void; auto: string | null; clearAuto: () => void
  openRef: string | null; clearOpenRef: () => void; onRecorded: (id: string) => void; onChanged: () => void; reload: number
}) {
  const { merchant, rows, open, setOpen, openRef, clearOpenRef } = props
  const [proc, setProc] = useState<'all' | Processor>('all')
  const [status, setStatus] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    if (!openRef) return
    const r = rows.find((x) => x.receipt.order_ref === openRef)
    if (r) setOpen(r.d.id)
    clearOpenRef()
  }, [openRef, rows, setOpen, clearOpenRef])

  const shown = rows
    .filter((r) => proc === 'all' || r.d.processor === proc)
    .filter((r) => status === 'all' || packStatus(r.events) === status)
    .filter((r) => (!from || disputeDay(r.d) >= from) && (!to || disputeDay(r.d) <= to))
    .sort((a, b) => disputeDay(b.d).localeCompare(disputeDay(a.d)))
  const selected = rows.find((r) => r.d.id === open)

  return (
    <div className="flex flex-col gap-6">
      <RecordDispute merchant={merchant} onRecorded={props.onRecorded} />
      <PayPalDisputes merchant={merchant} paid={props.paid} rows={rows} webhook={props.webhook} />

      {rows.length === 0 ? (
        <Empty title="No disputes yet.">
          A dispute appears here when a shipped agent order is disputed and you record it, together with the evidence package
          built from that order's record. This page reads the database live.
        </Empty>
      ) : (
        <Card label="Disputes list">
          <div className="mb-4 flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
            <label className="text-sm">
              <span className={LABEL}>Processor</span>
              <select className={INPUT} value={proc} onChange={(e) => setProc(e.target.value as 'all' | Processor)} aria-label="Filter by processor">
                <option value="all">All</option>
                {PROCESSORS.map((p) => <option key={p} value={p}>{PROCESSOR_LABEL[p]}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className={LABEL}>Pack status</span>
              <select className={INPUT} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by pack status">
                <option value="all">All</option>
                {PACK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className={LABEL}>Dispute date from</span>
              <input type="date" className={INPUT} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Dispute date from" />
            </label>
            <label className="text-sm">
              <span className={LABEL}>to</span>
              <input type="date" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Dispute date to" />
            </label>
            <span className="text-xs text-dash-label">Sorted by dispute date, newest first.</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-dash-edge text-xs uppercase tracking-wider text-dash-label">
                  <th className="py-2 pr-3 font-semibold">Order</th>
                  <th className="py-2 pr-3 font-semibold">Product / total</th>
                  <th className="py-2 pr-3 font-semibold">Claim as filed</th>
                  <th className="py-2 pr-3 font-semibold">Processor</th>
                  <th className="py-2 pr-3 font-semibold">Reason code / condition</th>
                  <th className="py-2 pr-3 font-semibold">Pack status</th>
                  <th className="py-2 pr-3 font-semibold">Missing</th>
                  <th className="py-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => <ListLine key={r.d.id} row={r} merchant={merchant} reload={props.reload} isOpen={open === r.d.id} onToggle={() => setOpen(open === r.d.id ? null : r.d.id)} />)}
              </tbody>
            </table>
            {shown.length === 0 && <p className="mt-3 text-sm text-dash-body">No dispute matches these filters.</p>}
          </div>
        </Card>
      )}

      {selected && (
        <DisputeDetail
          key={selected.d.id} row={selected} merchant={merchant} reload={props.reload} onChanged={props.onChanged}
          autoGenerate={props.auto === selected.d.id} clearAuto={props.clearAuto}
        />
      )}
    </div>
  )
}

function ListLine({ row, merchant, reload, isOpen, onToggle }: { row: ListRow; merchant: Merchant; reload: number; isOpen: boolean; onToggle: () => void }) {
  const { d, receipt, shipment, events } = row
  const load = useDisputeRecord(receipt, d.id, reload)
  const filed = filedProcessor(d)
  const pack = usePack(d, receipt, merchant, load, filed ?? 'visa', null)
  const sum = receipt.action_summary
  const product = [str(sum.brand), str(sum.product_name)].filter(Boolean).join(' ')
  const total = num(sum.total_cents)
  const mi = pack ? merchantInputNeeds(pack).length : 0
  // Notice values: orange on the sample example, blue when filed, grey "Missing" when not in the record.
  const noticeCls = row.sample ? SAMPLE : REAL
  return (
    <tr className={`border-b border-dash-edge align-top ${row.sample ? 'bg-dash-card-raised' : ''}`} data-dispute-order={row.sample ? undefined : receipt.order_ref ?? undefined} data-sample-row={row.sample ? 'true' : undefined}>
      <td className="py-2 pr-3">
        {row.sample && <span className={`mb-1 block text-xs font-bold ${SAMPLE}`} data-testid="sample-label">Sample example — not a filed dispute</span>}
        <span className={`font-semibold ${REAL}`}>{receipt.order_ref ?? '–'}</span>
        <span className={`block text-xs ${REAL}`}>{receipt.receipt_ref}</span>
        <span className="block text-xs text-dash-label">Ordered <span className={REAL}>{day(receipt.sealed_at) ?? 'date not in record'}</span></span>
        <span className="block text-xs text-dash-label">{shipment ? <>Shipped <span className={REAL}>{shipment.shipped_on}</span></> : <><MissingChip />Shipment date not in record</>}</span>
      </td>
      <td className={`py-2 pr-3 ${REAL}`}>{product || '–'}<span className="block">{total === null ? '–' : formatMoney(total)}</span><span className="block text-xs text-dash-label">{merchant.name}</span></td>
      <td className="py-2 pr-3">
        <span className={REAL}>Claim: {d.reason}</span>
        {pack && <span className="block text-xs text-dash-body">→ {pack.texts.claim_plain}</span>}
      </td>
      <td className="py-2 pr-3">{filed ? <span className={noticeCls}>{PROCESSOR_LABEL[filed]}</span> : <span className="text-dash-label"><MissingChip />Not filed</span>}<span className="block text-xs">{d.channel ? <span className={noticeCls}>{d.channel}</span> : <span className="text-dash-label">Acquirer channel not in record</span>}</span></td>
      <td className="py-2 pr-3">
        {d.reason_code ? <span className={noticeCls}>{`${filed ? PROCESSOR_LABEL[filed] : ''} ${d.reason_code}`}</span> : <span className="text-dash-label"><MissingChip />Not filed</span>}
        {pack && <span className="block text-xs text-dash-body">→ {pack.claim.condition_plain}</span>}
        {pack?.claim.code_flag && <span className="block text-xs font-semibold text-dash-attention">{pack.claim.code_flag}</span>}
      </td>
      <td className="py-2 pr-3 font-semibold text-dash-ink" data-testid="pack-status">{row.sample ? 'Sample — not filed' : packStatus(events)}</td>
      <td className="py-2 pr-3">
        {load.status === 'checking' && <span className="text-xs text-dash-label">Checking…</span>}
        {load.status === 'error' && <span className="text-xs text-dash-violation">Could not read the record</span>}
        {pack && (pack.needs.length ? <span className="text-dash-attention">{pack.needs.length} {pack.needs.length === 1 ? 'document' : 'documents'} missing — see pack</span> : <span>None</span>)}
        {pack && mi > 0 && <span className="block text-xs font-semibold text-dash-attention">Merchant input required</span>}
      </td>
      <td className="py-2 text-right">
        <button type="button" aria-expanded={isOpen} onClick={onToggle} className="rounded-md px-2 py-1 text-xs font-semibold text-dash-teal hover:bg-dash-card-raised">
          {isOpen ? 'Hide details' : 'View details'}
        </button>
      </td>
    </tr>
  )
}

// ---------- Record a dispute ----------
function RecordDispute({ merchant, onRecorded }: { merchant: Merchant; onRecorded: (id: string) => void }) {
  const [show, setShow] = useState(false)
  const [f, setF] = useState({ order_ref: '', processor: 'visa' as Processor, claim: '', claim_type: '', reason_code: '', dispute_date: '', amount: '', processor_reference: '', channel: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const submit = async () => {
    setMsg(null)
    const amount = f.amount.trim() === '' ? null : Math.round(Number(f.amount) * 100)
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) { setMsg({ kind: 'error', text: 'Dispute amount must be a positive amount.' }); return }
    setBusy(true)
    const r = await callDisputes({
      action: 'record_dispute', merchant_id: merchant.id, order_ref: f.order_ref.trim(), processor: f.processor, claim: f.claim, claim_type: f.claim_type,
      reason_code: f.reason_code, dispute_date: f.dispute_date, dispute_amount_cents: amount, processor_reference: f.processor_reference.trim() || null, channel: f.channel.trim() || null,
    })
    setBusy(false)
    if (r.type === 'not_agent_order') setMsg({ kind: 'info', text: `${r.message}${r.gap ? ' Agent Receipt recorded a gap for this order (no receipt), so there is no record to build from.' : ''}` })
    else if (r.type === 'out_of_scope') setMsg({ kind: 'info', text: r.message })
    else if (r.type === 'dispute_recorded') { setMsg({ kind: 'info', text: 'Dispute recorded. The evidence package is built from this order’s record below.' }); onRecorded(r.dispute_id) }
    else if (r.type === 'error') setMsg({ kind: 'error', text: r.message })
  }
  return (
    <Card label="Record a dispute">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold text-dash-ink">Record a dispute</p>
          <p className="text-sm text-dash-body">Enter the dispute exactly as your processor or acquirer filed it. The reason code is stored as filed.</p>
        </div>
        <button type="button" className={BTN} aria-expanded={show} onClick={() => setShow(!show)}>{show ? 'Close' : 'Record a dispute'}</button>
      </div>
      {show && (
        <form className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <label><span className={LABEL}>Order id</span><input className={INPUT} value={f.order_ref} onChange={set('order_ref')} required aria-label="Order id" /></label>
          <label><span className={LABEL}>Processor as filed</span>
            <select className={INPUT} value={f.processor} onChange={set('processor')} aria-label="Processor as filed">
              {PROCESSORS.map((p) => <option key={p} value={p}>{PROCESSOR_LABEL[p]} (via acquirer)</option>)}
            </select>
          </label>
          <label><span className={LABEL}>Acquirer / channel (if known)</span><input className={INPUT} value={f.channel} onChange={set('channel')} aria-label="Acquirer / channel" /></label>
          <label className="md:col-span-2"><span className={LABEL}>Dispute claim as filed</span><input className={INPUT} value={f.claim} onChange={set('claim')} required aria-label="Dispute claim as filed" /></label>
          <label><span className={LABEL}>Claim type as filed</span>
            <select className={INPUT} value={f.claim_type} onChange={set('claim_type')} required aria-label="Claim type as filed">
              <option value="">Choose…</option>
              {CLAIM_TYPES.map((c) => <option key={c} value={c}>{CLAIM_TYPE_LABEL[c]}</option>)}
            </select>
          </label>
          <label><span className={LABEL}>Reason code / condition as filed</span><input className={INPUT} value={f.reason_code} onChange={set('reason_code')} required aria-label="Reason code / condition as filed" placeholder="e.g. 10.4 or 4837" /></label>
          <label><span className={LABEL}>Dispute date</span><input type="date" className={INPUT} value={f.dispute_date} onChange={set('dispute_date')} required aria-label="Dispute date" /></label>
          <label><span className={LABEL}>Dispute amount (USD, if filed)</span><input inputMode="decimal" className={INPUT} value={f.amount} onChange={set('amount')} aria-label="Dispute amount" /></label>
          <label><span className={LABEL}>Processor reference (if known)</span><input className={INPUT} value={f.processor_reference} onChange={set('processor_reference')} aria-label="Processor reference" /></label>
          <div className="flex items-end md:col-span-2"><button type="submit" className={BTN} disabled={busy}>{busy ? 'Recording…' : 'Record dispute'}</button></div>
        </form>
      )}
      {msg && <p role="status" className={`mt-3 text-sm font-semibold ${msg.kind === 'error' ? 'text-dash-violation' : 'text-dash-ink'}`}>{msg.text}</p>}
    </Card>
  )
}

// ---------- Detail view ----------
const RESULT_TEXT: Record<string, { text: string; cls: string }> = {
  match: { text: '✓ Match', cls: 'text-dash-teal font-semibold' },
  mismatch: { text: '✕ Mismatch', cls: 'text-dash-violation font-bold' },
  unspecified: { text: '– Not specified by the customer, no check', cls: 'text-dash-label font-semibold' },
  not_in_record: { text: '⚠ Not in Agent Receipt record', cls: 'text-dash-attention font-bold' },
  in_record: { text: 'In record (merchant review)', cls: 'text-dash-ink font-semibold' },
}

function Block({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section className="mt-6 border-t border-dash-edge pt-4" data-testid={testid}>
      <h3 className="mb-3 text-base font-bold text-dash-ink">{title}</h3>
      {children}
    </section>
  )
}

function DisputeDetail({ row, merchant, reload, onChanged, autoGenerate, clearAuto }: {
  row: ListRow; merchant: Merchant; reload: number; onChanged: () => void; autoGenerate: boolean; clearAuto: () => void
}) {
  const { d, receipt } = row
  const filed = filedProcessor(d)
  const [processor, setProcessor] = useState<Processor>(filed ?? 'visa')
  const [override, setOverride] = useState<{ texts: Texts | null; source: TextSource } | null>(null)
  const load = useDisputeRecord(receipt, d.id, reload)
  const pack = usePack(d, receipt, merchant, load, processor, override)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const events = load.status === 'done' ? load.data.events : row.events

  // Generate = Spark plain-language texts (validated server-side) + record of the pack version. Template texts if Spark is unavailable.
  const generate = async () => {
    if (load.status !== 'done') return
    setBusy('generate'); setMsg(null)
    const t = await callDisputes({ action: 'format_pack', merchant_id: merchant.id, dispute_id: d.id, processor })
    const ov = t.type === 'texts' ? { texts: t.texts, source: t.text_source } : { texts: null, source: 'rules-fallback' as const }
    const built = await buildPack({
      processor, merchant, receipt: receipt as unknown as Row, grant: load.data.grant, proposal: load.data.proposal, action: load.data.action,
      shipment: load.data.shipment as unknown as Row | null, reviews: load.data.reviews as unknown as Row[], dispute: d as unknown as Row,
      gate: gateOf(load.data.check), texts: ov.texts, text_source: ov.source,
    })
    const r = await callDisputes({ action: 'record_pack', merchant_id: merchant.id, dispute_id: d.id, processor, pack_hash: built.pack_hash, text_source: built.text_source, texts: built.text_source === 'muse-spark' ? built.texts : null })
    setBusy(null)
    if (r.type === 'error') { setMsg(r.message); return }
    if (t.type === 'texts' && t.reason) setMsg(`Spark formatting unavailable: ${t.reason} Template text used (rules-fallback).`)
    if (t.type === 'error') setMsg(`Spark formatting unavailable: ${t.message} Template text used (rules-fallback).`)
    setOverride(null)
    onChanged()
  }
  useEffect(() => {
    if (row.sample || !autoGenerate || load.status !== 'done' || !pack) return
    clearAuto()
    if (!latestPackEvent(load.data.events, processor)) void generate()
  }, [autoGenerate, load, pack])

  return (
    <div data-testid="dispute-detail" data-dispute-detail={receipt.order_ref ?? undefined}>
      <Card label={`Dispute detail ${receipt.order_ref ?? receipt.receipt_ref}`}>
        <Legend testid="legend-detail" />
        {row.sample && <p className={`mb-3 font-bold ${SAMPLE}`} data-testid="sample-detail-label">{SAMPLE_LABEL}</p>}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-bold text-dash-ink">Order {receipt.order_ref ?? '–'} · {receipt.receipt_ref}</p>
            <p className={`text-sm ${row.sample ? SAMPLE : 'text-dash-body'}`} data-testid="dispute-date">{d.dispute_date ? `Dispute filed ${d.dispute_date}` : `Dispute date not filed — recorded in Agent Proceed ${d.opened_at.slice(0, 10)}`} · {filed ? PROCESSOR_LABEL[filed] : 'processor not filed'} {d.reason_code ?? ''}</p>
          </div>
          <label className="text-sm">
            <span className={LABEL}>Pack format</span>
            <select className={INPUT} value={processor} onChange={(e) => { setProcessor(e.target.value as Processor); setOverride(null) }} aria-label="Pack format">
              {PROCESSORS.map((p) => <option key={p} value={p}>{PROCESSOR_LABEL[p]}{p === filed ? ' (as filed)' : ' — view only'}</option>)}
            </select>
          </label>
        </div>
        {!filed && (
          <p className="mt-2 text-sm font-semibold text-dash-attention" data-testid="format-note">
            Processor not filed. Pack format: {PROCESSOR_LABEL[processor]} — view only. This is the field order you are viewing, not the processor the dispute was filed under.
          </p>
        )}
        {filed && processor !== filed && (
          <p className="mt-2 text-sm font-semibold text-dash-attention">
            This dispute was filed under {PROCESSOR_LABEL[filed]}. The pack below is rebuilt in the {PROCESSOR_LABEL[processor]} format, with its own field order and checklist.
          </p>
        )}
        <p className="mt-3 text-xs text-dash-label">{DISCLAIMER}</p>

        {load.status === 'checking' && <p className="mt-4 text-sm text-dash-body" role="status">Checking receipt chain… the evidence package is shown after the check.</p>}
        {load.status === 'error' && <p className="mt-4 text-sm text-dash-violation" role="alert">Could not read this order&apos;s record: {load.message}. The evidence package is not shown.</p>}
        {load.status === 'done' && pack && (
          <>
            {!pack.trusted && (
              <div className="mt-4 rounded-lg border border-dash-violation p-3 text-sm" data-testid="chain-check" role="status">
                <p className="font-bold text-dash-violation">Receipt chain failed verification — tamper check failed. This record is untrusted.</p>
                <p className="mt-1 text-dash-body">{load.data.check.failed?.message}</p>
                {load.data.check.failed && <p className="mt-1 font-mono text-xs text-dash-label">Stored {short(load.data.check.failed.stored_hash)} · recomputed {short(load.data.check.failed.recomputed_hash)}</p>}
              </div>
            )}
            <ClaimVsRecord pack={pack} />
            <Timeline row={row} data={load.data} />
            <PackView pack={pack} events={events} busy={busy} onGenerate={generate} merchant={merchant} dispute={d} onChanged={onChanged} />
            <Needed pack={pack} />
            {row.sample ? (
              <Block title="Merchant decision and outcome" testid="decisions">
                <p className="text-sm text-dash-body">Not available on the sample example: it is not a filed dispute, so there is nothing to fight, concede or submit.</p>
              </Block>
            ) : (
              <Decisions pack={pack} merchant={merchant} dispute={d} events={events} onChanged={onChanged} />
            )}
            {!row.sample && row.paypal && (
              <Block title="PayPal Sandbox dispute" testid="paypal-dispute">
                <PayPalEvidence
                  merchantId={merchant.id} receiptId={receipt.id} disputeId={d.id} orderRef={receipt.order_ref}
                  paypalOrderId={row.paypal.paypal_order_id} captureId={row.paypal.capture_id} submission={row.paypal.submission}
                />
              </Block>
            )}
            <Block title="Related (navigation only)">
              <p className="text-sm text-dash-body">
                <Link className="font-semibold text-dash-teal" to="/dashboard/orders">Agent orders — this order&apos;s Agent Receipt check</Link>
                {' · '}
                <Link className="font-semibold text-dash-teal" to="/dashboard/optimization">Listing Optimizer — listing guidance</Link>
              </p>
              <p className="mt-1 text-xs text-dash-label">Links are for navigation. They do not say what caused this dispute.</p>
            </Block>
          </>
        )}
        {msg && <p role="status" className="mt-3 text-sm font-semibold text-dash-attention">{msg}</p>}
      </Card>
    </div>
  )
}

function ClaimVsRecord({ pack }: { pack: Pack }) {
  return (
    <Block title="Claim vs record" testid="claim-vs-record">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-dash-edge p-3 text-sm">
          <p className={LABEL}>Claim, as filed</p>
          <p className={`mt-1 font-semibold ${REAL}`}>{pack.claim.as_filed}</p>
          <p className="mt-1 text-dash-body">{pack.texts.claim_plain}</p>
          <p className={`${LABEL} mt-3`}>Reason code / condition, as filed</p>
          <p className={`mt-1 font-semibold ${pack.claim.condition_as_filed ? (pack.sample ? SAMPLE : REAL) : 'text-dash-label'}`} data-testid="condition-as-filed">
            {pack.claim.condition_as_filed ? `${pack.filed_processor ? PROCESSOR_LABEL[pack.filed_processor] : ''} ${pack.claim.condition_as_filed}` : <><MissingChip />Not filed</>}
          </p>
          <p className="mt-1 text-dash-body">{pack.claim.condition_plain}</p>
          {pack.claim.code_flag && <p className="mt-1 font-semibold text-dash-attention">{pack.claim.code_flag}</p>}
          <p className="mt-2 text-xs text-dash-label">The customer&apos;s description is not a network code; the condition is shown separately, as filed.</p>
        </div>
        <div className="rounded-lg border border-dash-edge p-3 text-sm">
          <p className={LABEL}>What the Agent Receipt record shows (order record and merchant review only)</p>
          <ul className="mt-1 flex flex-col gap-2">
            {pack.claim_vs_record.map((e) => (
              <li key={e.element} data-element={e.element}>
                <span className="font-semibold text-dash-ink">{e.element}</span>
                <span className="block text-xs text-dash-label">{e.claim}</span>
                <span className={`block ${REAL}`}>{e.record}</span>
                <span className={RESULT_TEXT[e.result].cls}>{RESULT_TEXT[e.result].text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Block>
  )
}

// A step's own date (or timestamp), and its place in the order's life: grant 0, action 1, verdict 2, merchant review 3,
// shipment 4, dispute filed 5, pack and merchant entries 6. Steps are sorted by day, then by that place, then by time,
// so records that carry only a date never jump ahead of same-day records that carry a time.
type Step = { at: string; rank: number; title: string; detail: string; source: string; dateLabel?: string; sample?: boolean }

function Timeline({ row, data }: { row: ListRow; data: Loaded }) {
  const { d, receipt } = row
  const steps: Step[] = []
  const g = data.grant
  if (g) steps.push({ at: String(g.confirmed_at ?? ''), rank: 0, title: 'Grant sealed', detail: `Budget ${num(g.amount_max_cents) === null ? '–' : formatMoney(num(g.amount_max_cents) as number)} max · product scope ${str(g.product_scope) ?? 'unspecified'}`, source: `Grant record ${short(str(g.entry_hash))}` })
  const a = data.action
  if (a) {
    const det = (a.detail as Row) ?? {}
    steps.push({ at: String(det.sealed_at ?? a.created_at ?? ''), rank: 1, title: 'Action', detail: `${str(det.product_name) ?? '–'} · total ${num(det.total_cents) === null ? '–' : formatMoney(num(det.total_cents) as number)}`, source: `Action record ${short(str(a.entry_hash))}` })
  }
  steps.push({ at: receipt.sealed_at ?? '', rank: 2, title: 'Verdict', detail: `${receipt.decision ? { pass: 'Pass', review_required: 'Review Required', hold_suspicion: 'Hold for Suspicion' }[receipt.decision] : 'No decision'} · ${receipt.problems_found} problems`, source: `Receipt ${receipt.receipt_ref}` })
  if (data.reviews.length === 0) {
    const flagged = receipt.decision === 'review_required' || receipt.decision === 'hold_suspicion'
    steps.push({ at: receipt.sealed_at ?? '', rank: 3, title: 'Merchant review', dateLabel: 'no record', detail: flagged ? 'No merchant review record.' : 'No merchant review record. The order was Pass at Agent Receipt check, so no review was flagged.', source: 'Merchant review records' })
  }
  for (const r of data.reviews) steps.push({ at: r.recorded_at, rank: 3, title: 'Merchant review (recorded at review time)', detail: `${r.action_taken.replace(/_/g, ' ')} · ${r.method} · ${r.release_decision === 'released' ? 'released for shipment' : 'not released'}`, source: `Merchant review record ${short(r.entry_hash)}` })
  if (data.shipment) {
    steps.push({ at: data.shipment.shipped_on, rank: 4, title: 'Shipped', detail: `Shipped ${data.shipment.shipped_on}${data.shipment.delivered_on ? ` · delivered ${data.shipment.delivered_on}` : ' · delivery date not in record'} · delivery proof ${data.shipment.delivery_proof_ref ? 'present' : 'missing'}`, source: data.shipment.source })
  } else {
    steps.push({ at: receipt.sealed_at ?? '', rank: 4, title: 'Shipment', dateLabel: 'no record', detail: 'Shipment date not in record. Delivery proof missing.', source: 'No shipment record' })
  }
  steps.push({
    at: d.dispute_date ?? d.opened_at, rank: 5, title: d.sample ? 'Dispute filed (sample notice)' : 'Dispute filed', dateLabel: disputeDateLabel(d), sample: d.sample === true,
    detail: `${d.reason} · ${d.processor ? PROCESSOR_LABEL[d.processor] : 'processor not filed'} ${d.reason_code ?? ''} · amount ${d.dispute_amount_cents == null ? 'not in record' : formatMoney(d.dispute_amount_cents)}`,
    source: d.sample ? 'Sample dispute notice — not filed, not stored' : d.dispute_date ? 'Dispute record (as filed)' : 'Dispute record: the filed dispute date is not in the record; the date shown is when it was recorded in Agent Proceed',
  })
  for (const e of shownEvents(data.events)) {
    if (e.event_type === 'opened') continue
    const date = typeof e.basis.date === 'string' ? e.basis.date : null
    const at = date ?? String(e.basis.generated_at ?? e.basis.recorded_at ?? e.created_at ?? '')
    const detail = e.event_type === 'pack_generated'
      ? `${PROCESSOR_LABEL[e.basis.processor as Processor] ?? ''} format · ${e.basis.text_source === 'muse-spark' ? 'Muse Spark texts' : 'rules-fallback texts'} · version ${short(e.basis.pack_hash as string)}`
      : [date ? `Date ${date}` : null, typeof e.basis.reason === 'string' ? `“${e.basis.reason}”` : null, e.decided_by ? `by ${e.decided_by}` : null].filter(Boolean).join(' · ')
    steps.push({ at, rank: 6, title: DISPUTE_STATUS[e.event_type], detail, source: `Dispute entry ${short(e.entry_hash)}` })
  }
  const order = steps.map((s, i) => ({ s, i }))
  order.sort((x, y) => x.s.at.slice(0, 10).localeCompare(y.s.at.slice(0, 10)) || x.s.rank - y.s.rank || x.s.at.localeCompare(y.s.at) || x.i - y.i)
  steps.splice(0, steps.length, ...order.map((o) => o.s))
  return (
    <Block title="Timeline" testid="timeline">
      <ol className="flex flex-col gap-2 border-l border-dash-edge pl-4 text-sm">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="font-semibold text-dash-ink">{s.title}</span>
            <span className={`ml-2 text-xs ${s.sample ? SAMPLE : s.dateLabel === 'no record' ? 'text-dash-label' : REAL}`}>{s.dateLabel ?? s.at.slice(0, 10)}</span>
            <span className={`block ${s.sample ? SAMPLE : s.dateLabel === 'no record' ? 'text-dash-label' : REAL}`} data-step-value={s.sample ? 'sample' : s.dateLabel === 'no record' ? 'missing' : 'record'}>{s.detail}</span>
            <span className="block text-xs text-dash-label">Source: {s.source}</span>
          </li>
        ))}
      </ol>
    </Block>
  )
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function PackView({ pack, events, busy, onGenerate, merchant, dispute, onChanged }: {
  pack: Pack; events: DisputeEvent[]; busy: string | null; onGenerate: () => void; merchant: Merchant; dispute: Dispute; onChanged: () => void
}) {
  const rec = latestPackEvent(events, pack.processor)
  const [marking, setMarking] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const name = `evidence-pack-${pack.order_ref ?? pack.receipt_ref}-${pack.processor}`
  const markDownloaded = async () => {
    setMarking(true); setErr(null)
    const r = await callDisputes({ action: 'record_event', merchant_id: merchant.id, dispute_id: dispute.id, event_type: 'pack_downloaded', date: null, reason: null })
    setMarking(false)
    if (r.type === 'error') setErr(r.message)
    else onChanged()
  }
  return (
    <Block title={`Evidence Packet — ${pack.processor_label} field order`} testid="evidence-pack">
      <Legend testid="legend-pack" />
      {pack.sample && <p className={`mb-2 font-bold ${SAMPLE}`} data-testid="sample-pack-label">{SAMPLE_LABEL}</p>}
      <p className="text-sm text-dash-body" data-testid="pack-explanation">{pack.texts.explanation}</p>
      <p className={`mt-1 text-xs font-semibold ${pack.text_source === 'muse-spark' ? 'text-dash-teal' : 'text-dash-attention'}`} data-testid="text-source">{pack.text_label}</p>
      <p className="mt-2 break-all font-mono text-xs text-dash-label">Pack version (hash of its JSON): {pack.pack_hash}</p>
      <p className="text-xs text-dash-label" data-testid="pack-record">
        {pack.sample ? 'Sample example: shown here only, never recorded, never filed.' : rec
          ? rec.basis.pack_hash === pack.pack_hash
            ? `Matches the pack generation record of ${String(rec.basis.generated_at ?? rec.created_at ?? '').slice(0, 10)}.`
            : `Differs from the pack generation record of ${String(rec.basis.generated_at ?? rec.created_at ?? '').slice(0, 10)}: the record or texts changed after that pack was generated. Regenerate to record this version.`
          : `This pack is built from the record each time you open it; Download JSON and Printable pack give exactly this version (the hash above). It is not yet recorded as a generated pack for the ${pack.processor_label} format: Generate pack records this version in the chain. Opening the page writes nothing.`}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={BTN} onClick={() => download(`${name}.json`, JSON.stringify(packExport(pack, events), null, 2), 'application/json')}>Download JSON</button>
        <button type="button" className={BTN} onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.write(packToHtml(pack, events)); w.document.close(); w.focus(); w.print() } }}>Printable pack (print / save as PDF)</button>
        {!pack.sample && <button type="button" className={BTN} onClick={markDownloaded} disabled={marking}>Mark as downloaded</button>}
        {!pack.sample && <button type="button" className={BTN} onClick={onGenerate} disabled={busy !== null}>{busy === 'generate' ? 'Generating…' : rec ? 'Regenerate pack' : 'Generate pack'}</button>}
      </div>
      {err && <p className="mt-2 text-sm text-dash-violation">{err}</p>}
      <p className="mt-2 text-xs text-dash-label">Downloading does not mark the pack as submitted. Mark it yourself when you submit it to your acquirer.</p>

      {pack.sections.map((s) => (
        <div key={s.key} className={`mt-5 ${TONE[s.tone ?? 'record']}`} data-pack-section={s.key} data-tone={s.tone ?? 'record'}>
          <p className="mb-2 text-sm font-bold text-dash-ink">{s.title}</p>
          {s.key === 'merchant_review' && <p className="mb-2 text-sm text-dash-body" data-testid="merchant-review-statement">{pack.merchant_review_statement}</p>}
          {s.items.length > 0 && (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm md:grid-cols-[16rem_1fr]">
              {s.items.map((i, k) => (
                <div key={k} className="contents">
                  <dt className="text-dash-label">{i.label}</dt>
                  <dd
                    className={i.label === 'Tamper check' ? (pack.trusted ? `font-semibold ${REAL} break-all` : 'font-bold text-dash-violation') : i.status === 'missing' ? 'text-dash-label' : i.status === 'unspecified' ? 'text-dash-label' : `${i.origin === 'sample' ? SAMPLE : REAL} break-words`}
                    data-value={i.label === 'Tamper check' ? 'gate' : i.status === 'missing' ? 'missing' : i.origin === 'sample' ? 'sample' : i.status === 'unspecified' ? 'unspecified' : 'record'}
                    {...(i.label === 'Tamper check' ? { 'data-testid': 'tamper-line' } : {})}
                  >
                    {i.status === 'missing' && i.label !== 'Tamper check' ? <><MissingChip />{i.obtain_from}{i.note ? ` (${i.note})` : ''}</> : i.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {s.verdict && <VerdictTable rows={s.verdict as never} />}
        </div>
      ))}
      <div className="mt-5">
        <p className="mb-2 text-sm font-bold text-dash-ink">Rules and deadlines</p>
        <ul className="list-disc pl-5 text-sm text-dash-body" data-testid="pack-notes">{pack.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className="mt-2 text-xs text-dash-label">{pack.guide}</p>
      </div>
    </Block>
  )
}

function Needed({ pack }: { pack: Pack }) {
  const mi = merchantInputNeeds(pack)
  return (
    <Block title="Missing information" testid="needed">
      {mi.length > 0 && <p className="mb-2 font-bold text-dash-attention" data-testid="merchant-input-flag">Merchant input required: {mi.map((n) => n.item).join('; ')}.</p>}
      {pack.needs.length === 0 ? (
        <p className="text-sm text-dash-body">Every item this format lists is in the record.</p>
      ) : (
        <table className="w-full border-collapse text-left text-sm">
          <thead><tr className="border-b border-dash-edge text-xs uppercase tracking-wider text-dash-label"><th className="py-2 pr-3">Needed</th><th className="py-2 pr-3">Why</th><th className="py-2">Where to obtain it</th></tr></thead>
          <tbody>
            {pack.needs.map((n) => (
              <tr key={n.item} className="border-b border-dash-edge align-top">
                <td className="py-2 pr-3 font-semibold text-dash-ink">{n.item}{n.merchant_input && <span className="block text-xs text-dash-attention">Merchant input</span>}</td>
                <td className="py-2 pr-3">{n.why}</td>
                <td className="py-2">{n.obtain_from}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-dash-label">The package is available with the information in the record. Nothing missing is filled in by Agent Proceed or by a model.</p>
    </Block>
  )
}

type Pending = { type: 'represented' | 'conceded' | 'investigating' | 'outcome' | 'merchant_note' } | null
const DECISION_BUTTON: Record<'represented' | 'conceded' | 'investigating', string> = {
  represented: 'Mark as Fought (submitted to acquirer)', conceded: 'Mark as Conceded', investigating: 'Mark as Investigating',
}

function Decisions({ pack, merchant, dispute, events, onChanged }: { pack: Pack; merchant: Merchant; dispute: Dispute; events: DisputeEvent[]; onChanged: () => void }) {
  const [pending, setPending] = useState<Pending>(null)
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('')
  const [outcome, setOutcome] = useState('outcome_won')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const history = useMemo(() => shownEvents(events).filter((e) => !['opened', 'pack_generated'].includes(e.event_type)), [events])
  const start = (p: Pending) => { setPending(p); setDate(''); setReason(''); setErr(null) }
  const confirm = async () => {
    if (!pending) return
    setBusy(true); setErr(null)
    const event_type = pending.type === 'outcome' ? outcome : pending.type
    const r = await callDisputes({ action: 'record_event', merchant_id: merchant.id, dispute_id: dispute.id, event_type, date: date || null, reason: reason.trim() || null })
    setBusy(false)
    if (r.type === 'error') { setErr(r.message); return }
    setPending(null)
    onChanged()
  }
  return (
    <Block title="Merchant decision and outcome" testid="decisions">
      <p className="mb-3 text-sm text-dash-body">You decide, with your acquirer, whether to fight or concede. These buttons record your own decision and the outcome your acquirer reports. Each entry is appended with a timestamp; nothing earlier is overwritten.</p>
      <div className="flex flex-wrap gap-2">
        {(['represented', 'conceded', 'investigating'] as const).map((t) => <button key={t} type="button" className={BTN} onClick={() => start({ type: t })}>{DECISION_BUTTON[t]}</button>)}
        <button type="button" className={BTN} onClick={() => start({ type: 'outcome' })}>Mark outcome</button>
        <button type="button" className={BTN} onClick={() => start({ type: 'merchant_note' })}>Add dispute-time note</button>
      </div>
      {pending && (
        <div className="mt-4 rounded-lg border border-dash-edge bg-dash-card-raised p-4 text-sm" data-testid="decision-confirm">
          {(pending.type === 'represented' || pending.type === 'conceded') && (
            <div className="mb-3">
              <p className="font-semibold text-dash-ink">Pack summary, before you record this</p>
              <ul className="mt-1 list-disc pl-5 text-dash-body">
                <li>{pack.processor_label} format · {pack.claim.condition_as_filed ?? 'reason code not filed'} · claim: {pack.claim.as_filed}</li>
                <li>{pack.needs.length} {pack.needs.length === 1 ? 'item' : 'items'} missing from the record; {merchantInputNeeds(pack).length} need your input</li>
                <li>{pack.tamper_line}</li>
                <li className="break-all">Pack version {pack.pack_hash}</li>
              </ul>
            </div>
          )}
          {pending.type === 'outcome' && (
            <label className="mb-2 block"><span className={LABEL}>Outcome reported by your acquirer</span>
              <select className={INPUT} value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
                <option value="outcome_won">Won</option><option value="outcome_lost">Lost</option><option value="outcome_conceded">Conceded</option><option value="outcome_pending">Pending</option>
              </select>
            </label>
          )}
          {pending.type !== 'merchant_note' && (
            <label className="mb-2 block"><span className={LABEL}>{pending.type === 'represented' ? 'Date you submitted the pack to your acquirer' : pending.type === 'outcome' ? 'Outcome date (if known)' : 'Date'}</span>
              <input type="date" className={INPUT} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Decision date" />
            </label>
          )}
          <label className="mb-2 block"><span className={LABEL}>{pending.type === 'merchant_note' ? 'Dispute-time note (labelled separately from any review-time record)' : 'Reason, in your own words'}</span>
            <textarea className={INPUT} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          </label>
          <div className="flex gap-2">
            <button type="button" className={BTN} onClick={confirm} disabled={busy}>{busy ? 'Recording…' : 'Confirm and record'}</button>
            <button type="button" className="rounded-md px-3 py-1.5 text-sm font-semibold text-dash-body hover:bg-dash-card" onClick={() => setPending(null)}>Cancel</button>
          </div>
          {err && <p className="mt-2 text-dash-violation">{err}</p>}
        </div>
      )}
      <ol className="mt-4 text-sm" data-testid="decision-history">
        {history.length === 0 && <li className="text-dash-body">No merchant decision or outcome recorded yet.</li>}
        {history.map((e) => (
          <li key={e.id} className="flex flex-wrap gap-x-3 py-1">
            <span className="font-semibold text-dash-ink">{DISPUTE_STATUS[e.event_type]}</span>
            {typeof e.basis.date === 'string' && <span>{e.basis.date}</span>}
            {typeof e.basis.reason === 'string' && <span className="text-dash-body">“{e.basis.reason}”</span>}
            <span className="text-dash-label">{e.decided_by ? `recorded by ${e.decided_by}` : ''} (merchant-reported)</span>
          </li>
        ))}
      </ol>
    </Block>
  )
}

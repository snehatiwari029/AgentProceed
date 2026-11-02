import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useRows } from '../data'
import { Card, Empty, Live, PageTitle } from '../components/Panel'
import { CATEGORY_LABELS, PILLAR_NAMES, type Category, type Pillar, type PillarResult } from '../../../supabase/functions/optimizer/checks'
import { RESULT_LABEL, type ReadResult, type ReadTest } from '../../../supabase/functions/optimizer/readtest'
import { callOptimizer, filledIn, rankSuggestions, STATUS_LABEL, type Scan, type ScanListing, type Suggestion } from '../optimizer'

// The dashboard is Northwind's (demo sign-in). Everything below is filtered to this merchant.
const MERCHANT_NAME = 'Northwind Outfitters'

// The optimizer is a five-pillar guideline only. Order check linkage (mismatch counts, order numbers, "linked to" tags
// and a "caused a real order mismatch" filter) was removed on 2026-10-29: a weak listing may simply be skipped by an
// agent rather than cause a dispute, and the counts conflated problem instances with orders. Do not reintroduce it.

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

// Colour is never the only signal: every chip and card also says what it means in words.
const RESULT_STYLE: Record<PillarResult, { text: string; cls: string }> = {
  contradiction: { text: 'Contradiction', cls: 'border-dash-violation text-dash-violation' },
  missing: { text: 'Missing', cls: 'border-dash-attention text-dash-attention' },
  pass: { text: 'Pass', cls: 'border-dash-teal text-dash-teal' },
  not_checked: { text: 'Not checked', cls: 'border-dash-edge text-dash-label' },
}
const SEVERITY: Record<string, { label: string; border: string; text: string }> = {
  violation: { label: 'Fix first', border: 'border-dash-violation', text: 'text-dash-violation' },
  attention: { label: 'Blocks agent parsing', border: 'border-dash-attention', text: 'text-dash-attention' },
  lower: { label: 'Lower impact', border: 'border-dash-edge', text: 'text-dash-label' },
}

type Filters = { pillar: 'all' | Pillar; type: 'all' | 'contradiction' | 'missing' }
const matches = (s: Suggestion, f: Filters) =>
  (f.pillar === 'all' || s.pillar === f.pillar) && (f.type === 'all' || s.flag_type === f.type)

export default function Optimization() {
  const [reload, setReload] = useState(0)
  const merchants = useRows<{ id: string; name: string }>('merchants', 'name', true)
  const scans = useRows<Scan>('optimizer_scans', 'scanned_at', false, reload)
  const suggestions = useRows<Suggestion>('optimizer_suggestions', 'category', true, reload)

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Listing Optimizer">
        What an agent shopping for a customer cannot find, parse or compare in your listings, and the fix for each.
        You approve every fix; nothing here edits a listing, price, term or page.
      </PageTitle>
      <Live state={merchants}>
        {(rows) => {
          const merchant = rows.find((m) => m.name === MERCHANT_NAME)
          if (!merchant) return <Empty title="Merchant not found.">No merchant named {MERCHANT_NAME} in the merchants table.</Empty>
          return (
            <Live state={scans}>
              {(scanRows) => (
                <Live state={suggestions}>
                  {(sugRows) => (
                    <Workspace
                      merchant={merchant}
                      scan={scanRows.find((s) => s.merchant_id === merchant.id) ?? null}
                      suggestions={sugRows.filter((s) => s.merchant_id === merchant.id)}
                      onChanged={() => setReload((n) => n + 1)}
                    />
                  )}
                </Live>
              )}
            </Live>
          )
        }}
      </Live>
    </div>
  )
}

function Workspace({ merchant, scan, suggestions, onChanged }: {
  merchant: { id: string; name: string }
  scan: Scan | null
  suggestions: Suggestion[]
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [filters, setFilters] = useState<Filters>({ pillar: 'all', type: 'all' })
  const current = useMemo(() => {
    const listed = new Set(scan?.results.map((r) => r.product_id) ?? [])
    return suggestions.filter((s) => listed.has(s.product_id))
  }, [scan, suggestions])
  const shown = current.filter((s) => matches(s, filters))
  const pendingShown = shown.filter((s) => s.status === 'pending')
  // Approve All approves only what it can: a suggestion with an empty To-be-filled field stays pending.
  const approvable = pendingShown.filter(filledIn)
  const needValue = pendingShown.length - approvable.length

  async function scanNow() {
    setBusy('scan')
    setMessage(null)
    const r = await callOptimizer({ action: 'scan', merchant_id: merchant.id })
    setBusy(null)
    if (r.type === 'scan') {
      setMessage({ ok: true, text: `Scan finished: ${r.listings_scanned} listings, ${r.flags} flags. Resolved on re-scan: ${r.resolved}. Still flagged after approval: ${r.still_flagged}.` })
      onChanged()
    } else setMessage({ ok: false, text: r.type === 'error' ? r.message : 'Unexpected answer.' })
  }

  async function approveAll() {
    setBusy('all')
    setMessage(null)
    const r = await callOptimizer({ action: 'approve_all', merchant_id: merchant.id, suggestion_ids: approvable.map((s) => s.id) })
    setBusy(null)
    if (r.type === 'approve_all') {
      setMessage({ ok: true, text: `Approved ${r.approved}. ${r.skipped_unfilled} left pending because a To-be-filled field is empty. Nothing in your store was changed.` })
      onChanged()
    } else setMessage({ ok: false, text: r.type === 'error' ? r.message : 'Unexpected answer.' })
  }

  return (
    <>
      <Card label="Optimizer header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-lg font-bold text-dash-ink">{merchant.name}</p>
            <Link to="/shop" className="text-sm font-semibold text-dash-teal hover:underline">View Store</Link>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <button
              type="button" onClick={scanNow} disabled={busy !== null}
              className="rounded-md border border-dash-teal px-4 py-2 text-sm font-semibold text-dash-teal hover:bg-dash-card-raised disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'scan' ? 'Scanning…' : 'Scan Now'}
            </button>
            <div className="max-w-xs">
              <button
                type="button" onClick={approveAll} disabled={busy !== null || approvable.length === 0}
                className="rounded-md border border-dash-edge px-4 py-2 text-sm font-semibold text-dash-ink hover:bg-dash-card-raised disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'all' ? 'Approving…' : `Approve All (${approvable.length})`}
              </button>
              <p className="mt-1 text-xs text-dash-label">
                Approves the pending suggestions shown below. It does not apply them: no listing, price, term or page
                changes. You apply each fix in your store, then Scan Now verifies it. Suggestions with an empty
                To-be-filled field stay pending.
              </p>
              {needValue > 0 && (
                <p className="mt-1 text-xs text-dash-attention" data-testid="approve-all-skipped">
                  {needValue} more pending suggestion{needValue > 1 ? 's' : ''} shown need{needValue > 1 ? '' : 's'} a To-be-filled value first and will stay pending.
                </p>
              )}
            </div>
          </div>
        </div>
        {message && (
          <p role="status" className={`mt-3 text-sm ${message.ok ? 'text-dash-body' : 'text-dash-violation'}`}>{message.text}</p>
        )}
      </Card>

      {!scan ? (
        <Empty title="No scan yet.">Click Scan Now to scan your listings. Results come only from a scan of your live catalogue.</Empty>
      ) : (
        <>
          <ScanSummary scan={scan} suggestions={current} />
          <FilterBar filters={filters} onChange={setFilters} />
          <ListingList scan={scan} suggestions={current} filters={filters} merchantId={merchant.id} onChanged={onChanged} />
        </>
      )}
    </>
  )
}

function ScanSummary({ scan, suggestions }: { scan: Scan; suggestions: Suggestion[] }) {
  const withContradiction = scan.results.filter((r) => r.pillars.some((p) => p.result === 'contradiction')).length
  const withMissing = scan.results.filter((r) => r.pillars.some((p) => p.result === 'missing')).length
  const open = rankSuggestions(suggestions.filter((s) => s.status !== 'resolved' && s.status !== 'rejected'))
  const top = open[0]
  const topText = top ? `${CATEGORY_LABELS[top.category as Category]}s first` : 'Nothing open'
  const m = scan.markup
  // Pillar deconstruction only (the Agent Read-Test has its own Spark call and its own label on each listing).
  // Same wording as each listing's label (checks.ts), so the banner and the listing can never read differently.
  const onSpark = scan.spark['muse-spark'] ?? 0
  const onFallback = scan.spark['rules-fallback'] ?? 0
  const sparkText = [
    `Muse Spark deconstruction on ${onSpark} of ${scan.listings_scanned}`,
    ...(onFallback > 0 ? [`rules-fallback — deterministic check only, Spark deconstruction unavailable on ${onFallback} of ${scan.listings_scanned}`] : []),
  ].join('; ')

  return (
    <Card label="Scan summary">
      <dl className="grid gap-4 sm:grid-cols-4">
        {[
          ['Listings scanned', String(scan.listings_scanned)],
          ['With at least one Contradiction', String(withContradiction)],
          ['With at least one Missing flag', String(withMissing)],
          ['Top priority', topText],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-dash-label">{k}</dt>
            <dd className="mt-1 text-lg font-bold text-dash-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-4 flex flex-col gap-1 text-xs text-dash-label">
        <li>Last scan: {new Date(scan.scanned_at).toLocaleString()}. Catalogue: {scan.catalogue_source}.</li>
        <li>
          Schema.org check:{' '}
          {m.status === 'fetched'
            ? `HTML as served at ${m.url} (HTTP ${m.http_status}, ${m.bytes} bytes). No JavaScript is run, as many crawlers read it. ${m.products_found} Product block(s) found.`
            : `not checked — ${m.error}`}
        </li>
        <li>Semantic reading (pillar deconstruction): {sparkText}.</li>
      </ul>
    </Card>
  )
}

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const sel = 'rounded-md border border-dash-edge bg-dash-card-raised px-2 py-1 text-sm text-dash-ink'
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-4 text-sm">
      <label className="flex items-center gap-2">
        Pillar
        <select className={sel} value={String(filters.pillar)} onChange={(e) => onChange({ ...filters, pillar: e.target.value === 'all' ? 'all' : (Number(e.target.value) as Pillar) })}>
          <option value="all">All pillars</option>
          {([1, 2, 3, 4, 5] as Pillar[]).map((p) => <option key={p} value={p}>{p}. {PILLAR_NAMES[p]}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2">
        Flag type
        <select className={sel} value={filters.type} onChange={(e) => onChange({ ...filters, type: e.target.value as Filters['type'] })}>
          <option value="all">All</option>
          <option value="contradiction">Contradiction</option>
          <option value="missing">Missing</option>
        </select>
      </label>
    </div>
  )
}

function ListingList({ scan, suggestions, filters, merchantId, onChanged }: {
  scan: Scan; suggestions: Suggestion[]; filters: Filters; merchantId: string; onChanged: () => void
}) {
  const filtering = filters.pillar !== 'all' || filters.type !== 'all'
  // The worked example opens by default: the first listing with a Contradiction.
  const firstContradiction = scan.results.find((r) => r.pillars.some((p) => p.result === 'contradiction'))?.product_id ?? null
  const [open, setOpen] = useState<Set<string>>(() => new Set(firstContradiction ? [firstContradiction] : []))
  const listings = scan.results.filter((r) => !filtering || suggestions.some((s) => s.product_id === r.product_id && matches(s, filters)))
  if (listings.length === 0) return <Empty title="No listings match these filters.">Change a filter to see more.</Empty>

  return (
    <ul className="flex flex-col gap-4" aria-label="Listings">
      {listings.map((r) => {
        const isOpen = open.has(r.product_id)
        const mine = rankSuggestions(suggestions.filter((s) => s.product_id === r.product_id && (!filtering || matches(s, filters))))
        const topPillar = r.pillars.find((p) => p.result === 'contradiction') ?? r.pillars.find((p) => p.result === 'missing')
        return (
          <li key={r.product_id} className="rounded-xl border border-dash-edge bg-dash-card p-5" data-testid="optimizer-listing">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-dash-ink">{r.product_name}</p>
                <p className="mt-1 text-sm text-dash-body">
                  {r.product_scope ?? 'scope missing'} · {r.size_cm !== null ? `${r.size_cm} cm` : 'size missing'} · {r.colour ?? 'colour missing'} · {money(r.price_cents)}
                </p>
                {topPillar && <p className="mt-1 text-sm text-dash-body">Pillar {topPillar.pillar}: {topPillar.summary}</p>}
              </div>
              <button
                type="button" aria-expanded={isOpen}
                onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(r.product_id)) n.delete(r.product_id); else n.add(r.product_id); return n })}
                className="rounded-md border border-dash-edge px-3 py-1.5 text-sm font-semibold text-dash-ink hover:bg-dash-card-raised"
              >
                {isOpen ? 'Hide checklist' : 'Show checklist and fixes'}
              </button>
            </div>
            <ul className="mt-3 flex flex-wrap gap-2" aria-label={`Pillar summary for ${r.product_name}`}>
              {r.pillars.map((p) => (
                <li key={p.pillar} className={`rounded border px-2 py-0.5 text-xs font-bold ${RESULT_STYLE[p.result].cls}`}>
                  P{p.pillar} {RESULT_STYLE[p.result].text}
                </li>
              ))}
            </ul>
            {isOpen && <ListingDetail listing={r} suggestions={mine} merchantId={merchantId} onChanged={onChanged} />}
          </li>
        )
      })}
    </ul>
  )
}

function ListingDetail({ listing, suggestions, merchantId, onChanged }: { listing: ScanListing; suggestions: Suggestion[]; merchantId: string; onChanged: () => void }) {
  const d = listing.semantic.deconstructed
  const parts = d ? Object.entries(d).filter(([, v]) => v !== null) : []
  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-dash-edge pt-4">
      <p className="text-xs text-dash-label">
        Semantic reading: <span className={listing.semantic.source === 'muse-spark' ? 'text-dash-teal' : 'text-dash-attention'}>{listing.semantic.label}</span>. {listing.semantic.reason}
        {parts.length > 0 && <> Spark read the copy as: {parts.map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')}.</>}
      </p>
      <table className="w-full text-left text-sm" data-tour="pillars">
        <caption className="mb-2 text-left font-semibold text-dash-ink">Pillar 1–5 checklist</caption>
        <thead className="text-xs text-dash-label">
          <tr><th className="py-1 pr-3">Pillar</th><th className="py-1 pr-3">Result</th><th className="py-1">Evidence</th></tr>
        </thead>
        <tbody>
          {listing.pillars.map((p) => (
            <tr key={p.pillar} className="border-t border-dash-edge align-top">
              <td className="py-2 pr-3 text-dash-ink">{p.pillar}. {p.name}</td>
              <td className={`py-2 pr-3 font-bold ${RESULT_STYLE[p.result].cls.split(' ')[1]}`}>{RESULT_STYLE[p.result].text}</td>
              <td className="py-2">
                <ul className="flex flex-col gap-1">
                  {suggestions.filter((s) => s.pillar === p.pillar).map((s) => <li key={s.id}>{s.subtype}: {s.title}</li>)}
                  {p.notes.map((n) => <li key={n} className="text-dash-label">{n}</li>)}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {listing.read_test && <AgentReadTest test={listing.read_test} />}
      <div>
        <p className="font-semibold text-dash-ink">Suggested fixes, highest impact first</p>
        <ul className="mt-2 flex flex-col gap-3">
          {suggestions.map((s) => <SuggestionCard key={`${s.id}-${s.status}`} s={s} merchantId={merchantId} onChanged={onChanged} />)}
        </ul>
      </div>
    </div>
  )
}

const READ_STYLE: Record<ReadResult, string> = { match: 'text-dash-teal', mismatch: 'text-dash-violation', not_stated: 'text-dash-label' }

// Agent read-test: its own row group, apart from the pillar checklist and the fixes. It never adds a flag or a fix.
// Agent answers come from a blind Spark read of the displayed listing; formal terms come from the catalogue; code decides
// the result. The two are shown in separate columns so an agent answer is never read as part of the terms.
function AgentReadTest({ test }: { test: ReadTest }) {
  return (
    <section aria-label="Read as Agent" data-testid="agent-read-test" className="rounded-lg border border-dash-edge p-3">
      <p className="font-semibold text-dash-ink">Read as Agent</p>
      <p className="mt-1 text-xs text-dash-label">
        A shopping agent read this listing as shoppers see it, without your formal terms, and answered four fixed questions.
        Code compared each answer with your formal terms. Nothing here changes your listing.
      </p>
      {test.source !== 'muse-spark' ? (
        <p className="mt-2 text-sm text-dash-attention" data-testid="read-test-unavailable">{test.label}. {test.reason}</p>
      ) : (
        <>
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-xs text-dash-label">
              <tr><th className="py-1 pr-3">Question</th><th className="py-1 pr-3">Agent answer</th><th className="py-1 pr-3">Formal term</th><th className="py-1">Result (code)</th></tr>
            </thead>
            <tbody>
              {test.questions.map((x) => (
                <tr key={x.key} className="border-t border-dash-edge align-top" data-testid={`read-test-${x.key}`}>
                  <td className="py-2 pr-3 text-dash-ink">{x.question}</td>
                  <td className="py-2 pr-3">
                    <p className="text-dash-ink">{x.agent_answer}</p>
                    {x.agent_quotes.map((qt) => <p key={qt} className="text-xs text-dash-label">Quote: "{qt}"</p>)}
                    {x.agent_detail && <p className="text-xs text-dash-label">{x.agent_detail}</p>}
                  </td>
                  <td className="py-2 pr-3 text-dash-body">{x.formal_term}</td>
                  <td className="py-2">
                    <p className={`font-bold ${READ_STYLE[x.result]}`}>{RESULT_LABEL[x.result]}</p>
                    <p className="text-xs text-dash-label">{x.code_note}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {test.questions.filter((x) => x.customer_line).map((x) => (
              <li key={x.key} className="text-dash-violation" data-testid="read-test-customer-line">{x.customer_line}</li>
            ))}
            {test.summary && <li className="text-dash-teal" data-testid="read-test-all-match">{test.summary}</li>}
          </ul>
          {test.dropped.length > 0 && (
            <p className="mt-2 text-xs text-dash-label">Removed by the quote check (not in the displayed listing): {test.dropped.join('; ')}.</p>
          )}
        </>
      )}
    </section>
  )
}

function SuggestionCard({ s, merchantId, onChanged }: { s: Suggestion; merchantId: string; onChanged: () => void }) {
  const editable = s.status === 'pending' || s.status === 'rejected'
  const [fix, setFix] = useState(s.merchant_fix_text ?? s.suggested_fix)
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(s.value_fields.map((f) => [f, s.merchant_values?.[f] ?? ''])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(false) // Approve was clicked with a required field empty
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})
  const sev = SEVERITY[s.severity] ?? SEVERITY.lower
  const unfilled = s.value_fields.filter((f) => !values[f]?.trim())

  async function act(decision: 'approve' | 'reject') {
    if (decision === 'approve' && unfilled.length > 0) {
      // Nothing is sent: show which fields are missing, and put the cursor in the first one.
      setTried(true)
      setError(`Fill ${unfilled.join(', ')} before approving. The optimizer never fills a missing value.`)
      inputs.current[unfilled[0]]?.focus()
      return
    }
    setBusy(true)
    setError(null)
    const r = await callOptimizer({ action: 'decide', merchant_id: merchantId, suggestion_id: s.id, decision, fix_text: fix, values })
    setBusy(false)
    if (r.type === 'decision') onChanged()
    else setError(r.type === 'error' ? r.message : 'Unexpected answer.')
  }

  return (
    <li className={`rounded-lg border-l-4 ${sev.border} bg-dash-card-raised p-4`} data-testid="optimizer-suggestion">
      <p className="flex flex-wrap gap-x-3 text-xs font-bold">
        <span className={sev.text}>{CATEGORY_LABELS[s.category as Category]} · {sev.label}</span>
        <span className="text-dash-label">Pillar {s.pillar} · {s.subtype}</span>
        {s.source !== 'deterministic' && <span className="text-dash-label">{s.source}</span>}
      </p>
      <p className="mt-1 font-semibold text-dash-ink">{s.title}</p>
      <ul className="mt-2 list-disc pl-5 text-sm">
        {s.evidence.map((e) => <li key={e} className="break-words">{e}</li>)}
      </ul>
      <p className="mt-2 text-sm"><span className="text-dash-label">Impact: </span>{s.impact}</p>
      {editable ? (
        <label className="mt-3 block text-sm">
          <span className="text-dash-label">Suggested fix (you can edit it before approving)</span>
          <textarea
            value={fix} onChange={(e) => setFix(e.target.value)} rows={Math.min(14, fix.split('\n').length + 1)}
            className="mt-1 w-full rounded-md border border-dash-edge bg-dash-card p-2 font-mono text-xs text-dash-ink"
          />
        </label>
      ) : (
        <pre className="mt-3 whitespace-pre-wrap break-words rounded-md border border-dash-edge bg-dash-card p-2 font-mono text-xs text-dash-ink">{s.merchant_fix_text ?? s.suggested_fix}</pre>
      )}
      {s.value_fields.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {s.value_fields.map((f) => (
            <label key={f} className="text-sm">
              <span className="text-dash-label">To be filled by merchant: {f}{editable && <span className="text-dash-attention"> (required to approve)</span>}</span>
              <input
                ref={(el) => { inputs.current[f] = el }}
                value={values[f] ?? ''} disabled={!editable} placeholder="Empty — type your value"
                aria-invalid={tried && unfilled.includes(f)}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                className={`mt-1 w-full rounded-md border bg-dash-card px-2 py-1 text-dash-ink placeholder:text-dash-label ${
                  tried && unfilled.includes(f) ? 'border-2 border-dash-violation' : 'border-dash-edge'
                }`}
              />
              {tried && unfilled.includes(f) && <span className="mt-1 block text-xs text-dash-violation">Required before approving.</span>}
            </label>
          ))}
        </div>
      )}
      <p className="mt-3 text-sm font-semibold text-dash-ink">
        Status: {STATUS_LABEL[s.status]}
        {s.decided_at && s.status !== 'pending' && <span className="font-normal text-dash-label"> · {s.decided_by}, {new Date(s.decided_at).toLocaleString()}</span>}
      </p>
      {/* A re-scan note is shown only if that re-scan ran after the merchant's latest decision; an older note would read
          as a verdict on the decision when no scan has run since. */}
      {s.rescan_result && s.rescan_at && (!s.decided_at || Date.parse(s.rescan_at) >= Date.parse(s.decided_at)) && (
        <p className="mt-1 text-sm text-dash-body">Re-scan ({new Date(s.rescan_at).toLocaleString()}): {s.rescan_result}</p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-dash-violation">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {editable && (
          <button
            type="button" onClick={() => act('approve')} disabled={busy}
            className="rounded-md border border-dash-teal px-3 py-1.5 text-sm font-semibold text-dash-teal hover:bg-dash-card disabled:cursor-not-allowed disabled:opacity-50"
          >
            Approve
          </button>
        )}
        {(s.status === 'pending' || s.status === 'approved' || s.status === 'still_flagged') && (
          <button
            type="button" onClick={() => act('reject')} disabled={busy}
            className="rounded-md border border-dash-edge px-3 py-1.5 text-sm font-semibold text-dash-body hover:bg-dash-card disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reject
          </button>
        )}
        {editable && <span className="text-xs text-dash-label">Approving records your decision. It does not change your listing.</span>}
      </div>
    </li>
  )
}

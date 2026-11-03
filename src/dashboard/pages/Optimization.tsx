import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useRows } from '../data'
import { Card, Empty, Live, PageTitle } from '../components/Panel'
import { CATEGORY_LABELS, PILLAR_NAMES, type Category, type Pillar } from '../../../supabase/functions/optimizer/checks'
import { callOptimizer, rankSuggestions, STATUS_LABEL, type Scan, type Suggestion } from '../optimizer'

// The dashboard is Northwind's (demo sign-in). Everything below is filtered to this merchant.
const MERCHANT_NAME = 'Northwind Outfitters'

// The optimizer is a five-pillar guideline only. Order check linkage (mismatch counts, order numbers, "linked to" tags
// and a "caused a real order mismatch" filter) was removed on 2026-10-29: a weak listing may simply be skipped by an
// agent rather than cause a dispute, and the counts conflated problem instances with orders. Do not reintroduce it.

// Colour is never the only signal: every card also says what it means in words.
const SEVERITY: Record<string, { label: string; border: string; text: string }> = {
  violation: { label: 'Fix first', border: 'border-dash-violation', text: 'text-dash-violation' },
  attention: { label: 'Blocks agent parsing', border: 'border-dash-attention', text: 'text-dash-attention' },
  lower: { label: 'Lower impact', border: 'border-dash-edge', text: 'text-dash-label' },
}


export default function Optimization() {
  const [reload, setReload] = useState(0)
  const merchants = useRows<{ id: string; name: string }>('merchants', 'name', true)
  const scans = useRows<Scan>('optimizer_scans', 'scanned_at', false, reload)
  const suggestions = useRows<Suggestion>('optimizer_suggestions', 'category', true, reload)

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Listing Optimizer">
        What an agent shopping for a customer cannot find, parse or compare in your listings, and the fix for each.
        Nothing here edits a listing, price, term or page.
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

// What this browser did with the Read as Agent alerts of one scan. A new scan starts fresh.
type ReadView = { scanId: string; cleared: boolean; done: boolean }
const VIEW_KEY = 'agentproceed.readAsAgent.v1'
function loadView(): ReadView | null {
  try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null'); return v && typeof v.scanId === 'string' ? v : null } catch { return null }
}
function saveView(v: ReadView) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)) } catch { /* the page still works for this visit */ }
}

const btn = 'rounded-md border px-3 py-1.5 text-sm font-semibold hover:bg-dash-card-raised disabled:cursor-not-allowed disabled:opacity-50'

function Workspace({ merchant, scan, suggestions, onChanged }: {
  merchant: { id: string; name: string }
  scan: Scan | null
  suggestions: Suggestion[]
  onChanged: () => void
}) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [view, setView] = useState<ReadView | null>(loadView)
  const update = (v: ReadView) => { saveView(v); setView(v) }
  // Blind read-tests finish after the scan replies. While any is still running on a recent scan, re-read the page data.
  const refresh = useRef(onChanged)
  refresh.current = onChanged
  const readsRunning = !!scan?.results.some((r) => r.read_test?.source === 'pending') &&
    Date.now() - new Date(scan!.scanned_at).getTime() < 180_000
  useEffect(() => {
    if (!readsRunning) return
    const t = setInterval(() => refresh.current(), 4000)
    return () => clearInterval(t)
  }, [readsRunning])
  const current = useMemo(() => {
    const listed = new Set(scan?.results.map((r) => r.product_id) ?? [])
    return suggestions.filter((s) => listed.has(s.product_id))
  }, [scan, suggestions])

  return (
    <>
      <Card label="Optimizer header">
        <p className="text-lg font-bold text-dash-ink">{merchant.name}</p>
        <Link to="/shop" className="text-sm font-semibold text-dash-teal hover:underline">View Store</Link>
        {message && (
          <p role="status" className={`mt-3 text-sm ${message.ok ? 'text-dash-body' : 'text-dash-violation'}`}>{message.text}</p>
        )}
      </Card>
      {scan && <ScanSummary scan={scan} suggestions={current} />}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <FactorSection scan={scan} suggestions={current} merchantId={merchant.id} onChanged={onChanged} onMessage={setMessage} />
        <ReadAsAgentSection
          scan={scan} merchantId={merchant.id} view={view && scan && view.scanId === scan.id ? view : null}
          onScanned={(id) => { update({ scanId: id, cleared: false, done: false }); onChanged() }}
          onView={update} onMessage={setMessage}
        />
      </div>
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

function SectionHead({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dash-edge pb-3">
      <h2 className="text-lg font-bold text-dash-ink">{title}</h2>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

// Left: the five-factor alerts (the optimizer's suggestions), grouped by factor.
function FactorSection({ scan, suggestions, merchantId, onChanged, onMessage }: {
  scan: Scan | null; suggestions: Suggestion[]; merchantId: string; onChanged: () => void
  onMessage: (m: { ok: boolean; text: string } | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [needs, setNeeds] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState<Set<Pillar>>(new Set())
  // What the merchant typed on each card: its To-be-filled values and its edited fix.
  const edits = useRef<Record<string, { values: Record<string, string>; fix: string }>>({})
  const names = useMemo(() => new Map(scan?.results.map((r) => [r.product_id, r.product_name]) ?? []), [scan])
  const open = suggestions.filter((s) => s.status !== 'resolved' && s.status !== 'rejected')
  const pending = open.filter((s) => s.status === 'pending')

  async function markAllDone() {
    setBusy(true)
    onMessage(null)
    const ready: Suggestion[] = []
    const missing = new Set<string>()
    for (const s of pending) {
      const e = edits.current[s.id]
      const values = { ...s.merchant_values, ...(e?.values ?? {}) }
      if (s.value_fields.every((f) => (values[f] ?? '').trim() !== '')) ready.push(s)
      else missing.add(s.id)
    }
    const replies = await Promise.all(ready.map((s) => callOptimizer({
      action: 'decide', merchant_id: merchantId, suggestion_id: s.id, decision: 'approve',
      fix_text: edits.current[s.id]?.fix ?? s.merchant_fix_text ?? s.suggested_fix, values: edits.current[s.id]?.values ?? {},
    })))
    setBusy(false)
    setNeeds(missing)
    const done = replies.filter((r) => r.type === 'decision').length
    onMessage({ ok: done === ready.length, text: `Marked ${done} as done.${missing.size ? ` ${missing.size} need a value first (outlined in red).` : ''}` })
    onChanged()
  }

  return (
    <section aria-label="Listing optimization: 5 factors" data-tour="pillars" className="flex flex-col gap-4 rounded-xl border border-dash-edge bg-dash-card p-5">
      <SectionHead title="Listing optimization: 5 factors">
        <button type="button" onClick={markAllDone} disabled={busy || pending.length === 0} className={`${btn} border-dash-teal text-dash-teal`}>
          {busy ? 'Marking…' : 'Mark all as done'}
        </button>
      </SectionHead>
      {!scan ? (
        <p className="text-sm text-dash-label">No scan yet. Press Read as Agent Scan.</p>
      ) : (
        ([1, 2, 3, 4, 5] as Pillar[]).map((p) => {
          const mine = rankSuggestions(open.filter((s) => s.pillar === p))
          // Open alerts first, then the ones marked as done.
          const ordered = [...mine.filter((s) => s.status !== 'approved'), ...mine.filter((s) => s.status === 'approved')]
          return (
            <div key={p} data-testid={`factor-${p}`}>
              <h3 className="font-semibold text-dash-ink">
                {p}. {PILLAR_NAMES[p]} <span className="text-sm font-normal text-dash-label">({mine.filter((s) => s.status !== 'approved').length} open)</span>
              </h3>
              {ordered.length === 0 ? (
                <p className="mt-1 text-sm text-dash-teal">No alerts.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {(showAll.has(p) || needs.size > 0 ? ordered : ordered.slice(0, 3)).map((s) => (
                    <SuggestionCard
                      key={`${s.id}-${s.status}`} s={s} listing={names.get(s.product_id) ?? ''} needsValue={needs.has(s.id)}
                      onEdit={(values, fix) => { edits.current[s.id] = { values, fix } }}
                    />
                  ))}
                  {ordered.length > 3 && !(showAll.has(p) || needs.size > 0) && (
                    <li>
                      <button type="button" onClick={() => setShowAll((x) => new Set(x).add(p))} className="text-sm font-semibold text-dash-teal hover:underline">
                        Show all {ordered.length}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )
        })
      )}
    </section>
  )
}

type ReadAlert = { key: string; listing: string; question: string; answer: string; quote: string | null; formal: string; line: string | null }

// Right: what a blind shopping agent got wrong when it read each listing (the read-test mismatches).
// Shown after this browser presses Read as Agent Scan; Clear all hides them until the next scan.
function ReadAsAgentSection({ scan, merchantId, view, onScanned, onView, onMessage }: {
  scan: Scan | null; merchantId: string; view: ReadView | null
  onScanned: (scanId: string) => void; onView: (v: ReadView) => void
  onMessage: (m: { ok: boolean; text: string } | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const tests = scan?.results.map((r) => ({ listing: r.product_name, id: r.product_id, t: r.read_test })) ?? []
  const running = tests.filter((x) => x.t?.source === 'pending').length
  const unavailable = tests.filter((x) => x.t?.source === 'unavailable').length
  const alerts: ReadAlert[] = tests.flatMap((x) => x.t?.source !== 'muse-spark' ? [] : x.t.questions.filter((q) => q.result === 'mismatch').map((q) => ({
    key: `${x.id}-${q.key}`, listing: x.listing, question: q.question, answer: q.agent_answer, quote: q.agent_quotes[0] ?? null, formal: q.formal_term, line: q.customer_line,
  })))
  const visible = !!view && !view.cleared

  async function scanNow() {
    setBusy(true)
    onMessage(null)
    const r = await callOptimizer({ action: 'scan', merchant_id: merchantId })
    setBusy(false)
    if (r.type === 'scan') {
      onMessage({ ok: true, text: `Scan finished: ${r.listings_scanned} listings, ${r.flags} alerts.` })
      onScanned(r.scan_id)
    } else onMessage({ ok: false, text: r.type === 'error' ? r.message : 'Unexpected answer.' })
  }

  return (
    <section aria-label="Read as Agent" data-testid="read-as-agent-section" className="flex flex-col gap-4 rounded-xl border border-dash-edge bg-dash-card p-5">
      <SectionHead title="Read as Agent">
        <button
          type="button" onClick={scanNow} disabled={busy}
          aria-label={busy ? 'Scanning…' : 'Read as Agent Scan'}
          className="flex flex-col items-center rounded-md border border-dash-teal px-4 py-1.5 leading-tight hover:bg-dash-card-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-xs font-semibold text-dash-lavender">Read as Agent</span>
          <span className="text-sm font-bold text-dash-teal">{busy ? 'Scanning…' : 'Scan'}</span>
        </button>
        <button
          type="button" disabled={!visible || view!.done || alerts.length === 0}
          onClick={() => onView({ ...view!, done: true })} className={`${btn} border-dash-edge text-dash-ink`}
        >
          Mark all as done
        </button>
        <button
          type="button" disabled={!visible}
          onClick={() => onView({ ...view!, cleared: true })} className={`${btn} border-dash-edge text-dash-ink`}
        >
          Clear all
        </button>
      </SectionHead>
      {!visible ? (
        <p className="text-sm text-dash-label" data-testid="read-as-agent-empty">
          {view?.cleared ? 'Cleared. Press Read as Agent Scan to list the alerts again.' : 'Press Read as Agent Scan to see how a shopping agent reads your listings.'}
        </p>
      ) : (
        <>
          {running > 0 && <p className="text-sm text-dash-body" data-testid="read-test-pending">Agent is reading your listings… {tests.length - running} of {tests.length} done.</p>}
          {unavailable > 0 && <p className="text-sm text-dash-attention" data-testid="read-test-unavailable">Agent read-test unavailable on {unavailable} of {tests.length} listings.</p>}
          {alerts.length === 0 ? (
            running === 0 && unavailable < tests.length && <p className="text-sm text-dash-teal" data-testid="read-test-all-match">No alerts: the agent's answers match your terms.</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Read as Agent alerts">
              {alerts.map((a) => (
                <li key={a.key} data-testid="read-alert" className={`rounded-lg border-l-4 bg-dash-card-raised p-3 ${view!.done ? 'border-dash-teal opacity-70' : 'border-dash-violation'}`}>
                  <p className="flex flex-wrap justify-between gap-x-3 text-xs font-bold">
                    <span className="text-dash-label">{a.listing}</span>
                    {view!.done ? <span className="text-dash-teal">Done</span> : <span className="text-dash-violation">Mismatch</span>}
                  </p>
                  <p className="mt-1 font-semibold text-dash-ink">{a.question}</p>
                  <p className="mt-1 text-sm"><span className="text-dash-label">Agent: </span>{a.answer}{a.quote && <span className="text-dash-label"> (“{a.quote}”)</span>}</p>
                  <p className="text-sm"><span className="text-dash-label">Your terms: </span>{a.formal}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function SuggestionCard({ s, listing, needsValue, onEdit }: {
  s: Suggestion; listing: string; needsValue: boolean; onEdit: (values: Record<string, string>, fix: string) => void
}) {
  const editable = s.status === 'pending' || s.status === 'rejected'
  const [fix, setFix] = useState(s.merchant_fix_text ?? s.suggested_fix)
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(s.value_fields.map((f) => [f, s.merchant_values?.[f] ?? ''])))
  const [openCard, setOpenCard] = useState(false)
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})
  const sev = SEVERITY[s.severity] ?? SEVERITY.lower
  const unfilled = s.value_fields.filter((f) => !values[f]?.trim())
  const tried = needsValue && editable
  const expanded = openCard || tried
  const done = s.status === 'approved'
  useEffect(() => { onEdit(values, fix) }, [values, fix]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <li className={`rounded-lg border-l-4 ${done ? 'border-dash-teal opacity-70' : sev.border} bg-dash-card-raised px-3 py-2`} data-testid="optimizer-suggestion">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-dash-ink">{s.title}</p>
        <button type="button" aria-expanded={expanded} onClick={() => setOpenCard((o) => !o)} className="shrink-0 text-xs font-semibold text-dash-teal hover:underline">
          {expanded ? 'Hide details' : 'Details'}
        </button>
      </div>
      <p className="mt-0.5 text-xs">
        <span className="text-dash-label">{listing}</span>
        {' · '}
        {done ? <span className="font-bold text-dash-teal">Done</span> : <span className={`font-bold ${sev.text}`}>{sev.label}</span>}
      </p>
      {expanded && <>
      <ul className="mt-2 list-disc pl-5 text-sm">
        {s.evidence.map((e) => <li key={e} className="break-words">{e}</li>)}
      </ul>
      <p className="mt-2 text-sm"><span className="text-dash-label">Impact: </span>{s.impact}</p>
      {editable ? (
        <label className="mt-3 block text-sm">
          <span className="text-dash-label">Suggested fix</span>
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
              <span className="text-dash-label">To be filled by merchant: {f}</span>
              <input
                ref={(el) => { inputs.current[f] = el }}
                value={values[f] ?? ''} disabled={!editable} placeholder="Empty — type your value"
                aria-invalid={tried && unfilled.includes(f)}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                className={`mt-1 w-full rounded-md border bg-dash-card px-2 py-1 text-dash-ink placeholder:text-dash-label ${
                  tried && unfilled.includes(f) ? 'border-2 border-dash-violation' : 'border-dash-edge'
                }`}
              />
              {tried && unfilled.includes(f) && <span className="mt-1 block text-xs text-dash-violation">Required.</span>}
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
      </>}
    </li>
  )
}

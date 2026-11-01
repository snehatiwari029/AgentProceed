import { SAMPLE_LABEL, type Pack } from '../../supabase/functions/disputes/pack'
import type { DisputeEvent } from '../shared/schemas'
import { DISPUTE_STATUS, shownEvents } from './status'

// Merchant-reported decisions and outcomes, kept beside the pack (not inside its hash): they are recorded after the pack
// is generated, and they are the merchant's own entries, not part of the evidence.
export type MerchantReported = { entry: string; date: string | null; reason: string | null; recorded_at: string | null; by: string | null }

export function merchantReported(events: DisputeEvent[]): MerchantReported[] {
  return shownEvents(events)
    .filter((e) => !['opened', 'pack_generated'].includes(e.event_type))
    .map((e) => ({
      entry: DISPUTE_STATUS[e.event_type],
      date: typeof e.basis.date === 'string' ? e.basis.date : null,
      reason: typeof e.basis.reason === 'string' ? e.basis.reason : null,
      recorded_at: typeof e.basis.recorded_at === 'string' ? e.basis.recorded_at : e.created_at ?? null,
      by: e.decided_by,
    }))
}

// The downloadable JSON: the pack object itself (with its hash) and the merchant-reported entries.
export function packExport(pack: Pack, events: DisputeEvent[]) {
  return { pack, merchant_reported: merchantReported(events) }
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const RESULT: Record<string, string> = {
  match: 'Match', mismatch: 'Mismatch', unspecified: 'Not specified by the customer — no check', not_in_record: 'Not in AgentReceipt record', in_record: 'In record (merchant review)', missing: 'Record missing',
  cannot_determine: 'Cannot determine from summary as presented — merchant review required for that field',
}

// The printable pack: rendered only from the same object as the JSON, so the two cannot diverge.
export function packToHtml(pack: Pack, events: DisputeEvent[]): string {
  const ex = packExport(pack, events)
  const p = ex.pack
  const items = (rows: Pack['sections'][number]['items']) =>
    rows.map((i) => `<tr><th>${esc(i.label)}</th><td>${i.status === 'missing'
      ? `<span class="miss">Missing</span> ${esc(i.obtain_from)}${i.note ? ` (${esc(i.note)})` : ''}`
      : `<span class="${i.status === 'unspecified' ? 'unsp' : i.origin === 'sample' ? 'sample' : 'real'}">${esc(i.value)}</span>`}</td></tr>`).join('')
  const verdict = (rows: NonNullable<Pack['sections'][number]['verdict']>) =>
    `<table><tr><th>Field</th><th>Grant</th><th>Merchant terms</th><th>Actual</th><th>Match</th><th>Cause</th><th>Next action / Who acts</th></tr>${rows
      .map((r) => `<tr><td>${esc(r.field)}</td><td>${esc(r.grant ?? '–')}</td><td>${esc(r.merchant_terms ?? '–')}</td><td>${esc(r.actual ?? '–')}</td><td>${esc(RESULT[r.result] ?? r.result)}</td><td>${esc(r.cause ?? '–')}</td><td>${esc(r.next_action_who ?? '–')}</td></tr>`)
      .join('')}</table>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Evidence pack ${esc(p.order_ref ?? p.receipt_ref)} — ${esc(p.processor_label)}</title>
<style>body{font:13px/1.45 system-ui,sans-serif;color:#111;background:#fff;margin:24px;max-width:960px}h1{font-size:20px}h2{font-size:15px;margin-top:22px;border-bottom:1px solid #999}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}th{width:32%;background:#f4f4f4}
.mono{font-family:ui-monospace,monospace;word-break:break-all}.warn{border:2px solid #b00;padding:8px}
.real{color:#1d4ed8}.sample{color:#c2410c}.unsp{color:#555}.miss{display:inline-block;border:1px dashed #555;color:#555;padding:0 4px;font-size:11px;font-weight:700;text-transform:uppercase}
.legend{border:1px solid #999;padding:6px 8px;margin:8px 0}.tone-record{border-left:5px solid #1d4ed8;padding-left:8px}.tone-sample{border-left:5px solid #c2410c;padding-left:8px}</style></head><body>
<div class="legend"><p><b class="real">Blue</b> = real data from the transaction record. <b class="sample">Orange</b> = sample data — what we would receive from merchant dispute records when the store is connected.</p><p><span class="miss">Missing</span> = not in the record; each missing item says where to obtain it.</p></div>
${p.sample ? `<p class="warn sample"><b>${esc(SAMPLE_LABEL)}</b></p>` : ''}
<h1>Evidence pack — ${esc(p.processor_label)} format</h1>
<p>Order ${esc(p.order_ref ?? '–')} · Receipt ${esc(p.receipt_ref)} · Merchant ${esc(p.merchant)}</p>
<p><b>${esc(p.disclaimer)}</b></p>
${p.trusted ? '' : `<p class="warn">${esc(p.tamper_line)}</p>`}
<p class="mono">Pack version: ${esc(p.pack_hash)}</p>
<h2>Claim</h2><table>
<tr><th>Dispute claim as filed</th><td>${esc(p.claim.as_filed)}</td></tr>
<tr><th>Plain language</th><td>${esc(p.texts.claim_plain)}</td></tr>
<tr><th>Reason code / condition as filed</th><td>${esc(p.claim.condition_as_filed ?? 'Not filed')}${p.claim.condition_name ? ` — ${esc(p.claim.condition_name)}` : ''}</td></tr>
<tr><th>Condition in plain language</th><td>${esc(p.claim.condition_plain)}</td></tr>
${p.claim.code_flag ? `<tr><th>Flag</th><td>${esc(p.claim.code_flag)}</td></tr>` : ''}
</table>
<p>${esc(p.texts.explanation)}</p><p><i>${esc(p.text_label)}</i></p>
<h2>Claim vs record</h2><table><tr><th>Element</th><td><b>What the claim concerns · Record · Result</b></td></tr>${p.claim_vs_record
    .map((e) => `<tr><th>${esc(e.element)}</th><td>${esc(e.claim)} · ${esc(e.record)} · <b>${esc(RESULT[e.result])}</b></td></tr>`).join('')}</table>
${p.sections.map((s) => `<h2 class="tone-${s.tone ?? 'record'}">${esc(s.title)}</h2>${s.items.length ? `<table>${items(s.items)}</table>` : ''}${s.verdict ? verdict(s.verdict) : ''}${s.footer ? `<p>${esc(s.footer)}</p>` : ''}${s.key === 'merchant_review' ? `<p>${esc(p.merchant_review_statement)}</p>` : ''}`).join('\n')}
<h2>Missing documents checklist</h2>${p.needs.length ? `<table><tr><th>Item</th><td><b>Why · Where to obtain it</b></td></tr>${p.needs
    .map((n) => `<tr><th>${esc(n.item)}${n.merchant_input ? ' (merchant input required)' : ''}</th><td>${esc(n.why)} · ${esc(n.obtain_from)}</td></tr>`).join('')}</table>` : '<p>No item missing for this format.</p>'}
<h2>Rules and deadlines</h2><ul>${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
<p>${esc(p.guide)}</p>
<h2>Merchant-reported entries (not part of the pack hash)</h2>${ex.merchant_reported.length ? `<ul>${ex.merchant_reported
    .map((m) => `<li>${esc(m.entry)}${m.date ? `, ${esc(m.date)}` : ''}${m.reason ? ` — “${esc(m.reason)}”` : ''} (recorded by ${esc(m.by ?? 'merchant')})</li>`).join('')}</ul>` : '<p>None recorded.</p>'}
<p><b>${esc(p.disclaimer)}</b></p>
</body></html>`
}

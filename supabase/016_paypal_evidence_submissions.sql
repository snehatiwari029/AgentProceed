-- =====================================================================
-- 016: PayPal Sandbox evidence submissions (Dispute page "Submit evidence to PayPal (Sandbox)").
-- Run ONCE in Supabase > SQL Editor, after 015. Additive only: no existing row, column, receipt or hash changes.
--
--  1. paypal_evidence_submissions: one append-only row per evidence submission PayPal ACCEPTED (provide-evidence
--     returned success). Written only by the `paypal-disputes` edge function with the service role. A refused or
--     not-available submit writes nothing. Test money only: environment is fixed to 'sandbox'.
--  2. demo_reset() also clears it.
-- Browser access is read-only (demo read policy), like payment_events.
-- =====================================================================
begin;

create table if not exists paypal_evidence_submissions (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references receipts(id),
  merchant_id uuid not null references merchants(id),
  order_ref text,
  environment text not null default 'sandbox' check (environment in ('sandbox')),
  paypal_dispute_id text not null,
  paypal_order_id text,
  capture_id text not null,
  evidence_type text not null,
  receipt_hash text not null,
  dispute_reason text,
  stage_before text,
  status_before text,
  stage_after text,
  status_after text,
  dispute_state_after text,
  notes text,                 -- the notes exactly as sent to PayPal
  source text not null default 'paypal-disputes' check (source in ('paypal-disputes', 'backfill')),
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists paypal_evidence_submissions_receipt on paypal_evidence_submissions (receipt_id);

drop trigger if exists paypal_evidence_submissions_no_change on paypal_evidence_submissions;
create trigger paypal_evidence_submissions_no_change before update or delete on paypal_evidence_submissions
  for each row execute function block_record_mutation();
drop trigger if exists paypal_evidence_submissions_no_truncate on paypal_evidence_submissions;
create trigger paypal_evidence_submissions_no_truncate before truncate on paypal_evidence_submissions
  for each statement execute function block_record_mutation();

alter table paypal_evidence_submissions enable row level security;
drop policy if exists "demo read paypal_evidence_submissions" on paypal_evidence_submissions;
create policy "demo read paypal_evidence_submissions" on paypal_evidence_submissions for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on paypal_evidence_submissions from anon, authenticated;

create or replace function demo_reset()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.demo_reset', 'on', true);
  delete from session_events where true;
  delete from paypal_evidence_submissions where true;
  delete from payment_events where true;
  delete from dispute_events where true;
  delete from disputes where true;
  delete from merchant_reviews where true;
  delete from shipments where true;
  delete from receipts where true;
  delete from actions where true;
  delete from proposals where true;
  delete from grants where true;
  delete from sessions where true;
  perform setval('chain_seq_gen', 1, false);
  perform set_config('app.demo_reset', 'off', true);
end;
$$;
revoke all on function demo_reset() from public, anon, authenticated;
grant execute on function demo_reset() to service_role;

commit;

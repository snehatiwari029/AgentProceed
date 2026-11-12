-- =====================================================================
-- 018: PayPal Sandbox webhook dispute intake. Run ONCE in Supabase > SQL Editor, after 017.
-- Additive only: no existing row, column, receipt, hash, dispute or verdict changes.
--
--  1. paypal_webhook_events: one append-only row per webhook PayPal sent to the `paypal-webhook` function, verified
--     or not: event id, event type, dispute id, verification result and what was done. No secrets, no signature,
--     no headers: the verification result is the record.
--  2. paypal_dispute_records: one row per PayPal dispute, created on CUSTOMER.DISPUTE.CREATED (only from a verified
--     webhook) and updated on CUSTOMER.DISPUTE.UPDATED / RESOLVED. Matched to an Agent Proceed order by the PayPal
--     transaction (capture) id when one is recorded; otherwise kept and marked unmatched. Status fields change as
--     PayPal reports them; the history is the event log above.
--     The existing `disputes` table (manual record form, card networks, hash chain) is not touched.
--  3. demo_reset() also clears both.
-- Written only by the `paypal-webhook` edge function (service role). Browser access is read-only (demo read policy).
-- =====================================================================
begin;

create table if not exists paypal_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text,                       -- PayPal's webhook event id (WH-…); a redelivery is logged again as 'duplicate'
  event_type text,
  resource_type text,
  paypal_dispute_id text,
  verification text not null check (verification in ('SUCCESS', 'FAILURE', 'ERROR', 'MISSING_HEADERS', 'NOT_CONFIGURED')),
  outcome text not null,               -- created / updated / duplicate / ignored / rejected / error
  detail text,
  environment text not null default 'sandbox' check (environment in ('sandbox')),
  received_at timestamptz not null default now()
);
create index if not exists paypal_webhook_events_event on paypal_webhook_events (event_id);
create index if not exists paypal_webhook_events_dispute on paypal_webhook_events (paypal_dispute_id);

drop trigger if exists paypal_webhook_events_no_change on paypal_webhook_events;
create trigger paypal_webhook_events_no_change before update or delete on paypal_webhook_events
  for each row execute function block_record_mutation();
drop trigger if exists paypal_webhook_events_no_truncate on paypal_webhook_events;
create trigger paypal_webhook_events_no_truncate before truncate on paypal_webhook_events
  for each statement execute function block_record_mutation();

create table if not exists paypal_dispute_records (
  id uuid primary key default gen_random_uuid(),
  paypal_dispute_id text not null unique,
  environment text not null default 'sandbox' check (environment in ('sandbox')),
  matched boolean not null,
  receipt_id uuid references receipts(id),
  merchant_id uuid references merchants(id),
  order_ref text,
  paypal_order_id text,
  transaction_id text,                 -- the disputed seller transaction (capture) id
  reason text,
  status text,
  stage text,                          -- dispute_life_cycle_stage
  outcome text,                        -- dispute_outcome.outcome_code, once resolved
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  currency text check (currency is null or char_length(currency) = 3),
  seller_response_due_date timestamptz,
  paypal_create_time timestamptz,
  paypal_update_time timestamptz,
  source text not null default 'paypal_webhook' check (source in ('paypal_webhook')),
  last_event_type text,
  last_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (matched = (receipt_id is not null))
);
create index if not exists paypal_dispute_records_receipt on paypal_dispute_records (receipt_id);

alter table paypal_webhook_events enable row level security;
drop policy if exists "demo read paypal_webhook_events" on paypal_webhook_events;
create policy "demo read paypal_webhook_events" on paypal_webhook_events for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on paypal_webhook_events from anon, authenticated;

alter table paypal_dispute_records enable row level security;
drop policy if exists "demo read paypal_dispute_records" on paypal_dispute_records;
create policy "demo read paypal_dispute_records" on paypal_dispute_records for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on paypal_dispute_records from anon, authenticated;

create or replace function demo_reset()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.demo_reset', 'on', true);
  delete from session_events where true;
  delete from paypal_webhook_events where true;
  delete from paypal_dispute_records where true;
  delete from paypal_evidence_submissions where true;
  delete from receipt_signatures where true;
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

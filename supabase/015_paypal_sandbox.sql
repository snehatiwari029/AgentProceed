-- =====================================================================
-- 015: PayPal Sandbox payments (PRD Amendment 10). Run ONCE in Supabase > SQL Editor, after 014 and BEFORE
-- deploying the updated `shopper-agent` edge function. Additive only: no existing row, column, receipt, grant,
-- action, decision or hash is changed.
--
--  1. payment_events: one chained, append-only row per PayPal Sandbox result for an order (order created,
--     captured, capture failed, cancelled), with the PayPal order id and capture id. Test money only:
--     environment is fixed to 'sandbox'.
--  2. chain_entries view and demo_reset() include the new chained table.
-- Browser access stays read-only (demo read policy); every write goes through the `shopper-agent` edge function.
-- =====================================================================
begin;

create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id),
  grant_id uuid not null references grants(id),
  provider text not null check (provider in ('paypal')),
  environment text not null check (environment in ('sandbox')),
  event text not null check (event in ('order_created', 'captured', 'capture_failed', 'cancelled')),
  paypal_order_id text,
  capture_id text,
  status text,
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  currency text check (currency is null or char_length(currency) = 3),
  error text,
  created_at timestamptz not null default now(),

  chain_seq bigint not null unique default nextval('chain_seq_gen'),
  prev_hash sha256_hash not null,
  entry_hash sha256_hash not null unique
);
create index if not exists payment_events_session on payment_events (session_id);
create index if not exists payment_events_grant on payment_events (grant_id);

create or replace view chain_entries with (security_invoker = true) as
  select chain_seq, 'grant'::text as entry_type, id as entry_id, prev_hash, entry_hash, created_at from grants
  union all
  select chain_seq, 'proposal', id, prev_hash, entry_hash, created_at from proposals
  union all
  select chain_seq, 'action', id, prev_hash, entry_hash, created_at from actions
  union all
  select chain_seq, 'receipt', id, prev_hash, entry_hash, created_at from receipts
  union all
  select chain_seq, 'dispute_event', id, prev_hash, entry_hash, created_at from dispute_events
  union all
  select chain_seq, 'shipment', id, prev_hash, entry_hash, created_at from shipments
  union all
  select chain_seq, 'merchant_review', id, prev_hash, entry_hash, created_at from merchant_reviews
  union all
  select chain_seq, 'payment_event', id, prev_hash, entry_hash, created_at from payment_events;
revoke insert, update, delete, truncate on chain_entries from anon, authenticated;

drop trigger if exists payment_events_no_change on payment_events;
create trigger payment_events_no_change before update or delete on payment_events
  for each row execute function block_record_mutation();
drop trigger if exists payment_events_no_truncate on payment_events;
create trigger payment_events_no_truncate before truncate on payment_events
  for each statement execute function block_record_mutation();

alter table payment_events enable row level security;
drop policy if exists "demo read payment_events" on payment_events;
create policy "demo read payment_events" on payment_events for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on payment_events from anon, authenticated;

create or replace function demo_reset()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.demo_reset', 'on', true);
  delete from session_events where true;
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

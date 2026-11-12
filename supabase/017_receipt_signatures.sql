-- =====================================================================
-- 017: Ed25519 merchant signatures over Agent Receipt seals. Run ONCE in Supabase > SQL Editor, after 016.
-- Additive only: no existing row, column, receipt, hash or verdict changes. The receipt format is unchanged; the
-- signature lives in its own table, one row per receipt.
--
--   seal_hash  = the receipt's entry_hash, exactly as the auditor sealed it ("sha256:<64 hex>")
--   signature  = Ed25519 over the UTF-8 bytes of seal_hash, hex (128 chars)
--   public_key = the merchant's Ed25519 public key, hex (64 chars); the private seed is the Supabase secret
--                MERCHANT_ED25519_SEED and never leaves the `receipt-seal` edge function
-- Written only by the `receipt-seal` edge function (service role). Browser access is read-only (demo read policy).
-- =====================================================================
begin;

create table if not exists receipt_signatures (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null unique references receipts(id),
  merchant_id uuid not null references merchants(id),
  seal_hash text not null check (seal_hash ~ '^sha256:[0-9a-f]{64}$'),
  alg text not null default 'Ed25519' check (alg in ('Ed25519')),
  key_id text not null,
  public_key text not null check (public_key ~ '^[0-9a-f]{64}$'),
  signature text not null check (signature ~ '^[0-9a-f]{128}$'),
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

drop trigger if exists receipt_signatures_no_change on receipt_signatures;
create trigger receipt_signatures_no_change before update or delete on receipt_signatures
  for each row execute function block_record_mutation();
drop trigger if exists receipt_signatures_no_truncate on receipt_signatures;
create trigger receipt_signatures_no_truncate before truncate on receipt_signatures
  for each statement execute function block_record_mutation();

alter table receipt_signatures enable row level security;
drop policy if exists "demo read receipt_signatures" on receipt_signatures;
create policy "demo read receipt_signatures" on receipt_signatures for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on receipt_signatures from anon, authenticated;

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

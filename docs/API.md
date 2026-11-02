# Agent Proceed public agent API (hackathon slice)

The API writes the same Agent Receipt records as the shopper agent. Environment variable names and the API's own response text keep the internal `AgentReceipt` name.

A third-party agent registers, opens a session at the demo merchant, registers the customer's grant, logs what it did,
and reads back the auditor's verdict and hash-chained receipt. The verdict comes from the same auditor the phone
shopper uses (`supabase/functions/auditor`); this API holds no verdict logic of its own. Code: `supabase/functions/api/`.

> **Demo-issued keys only for hackathon. Production would use registered public keys and signature verification — not built in this slice.**

**Base URL:** `https://uhuekreoflmvxnlutsai.supabase.co/functions/v1` (every path below starts with `/api`).

```bash
export AGENTRECEIPT_API_URL=https://uhuekreoflmvxnlutsai.supabase.co/functions/v1/api
```

All bodies are JSON. Money is US dollars as a number (`449.95`). Dates are `YYYY-MM-DD`. An unspecified field is a real
JSON `null` (no check); the string `"null"` is rejected with 400.

| Method | Path | Auth |
|---|---|---|
| POST | `/api/agents/register` | none |
| POST | `/api/sessions` | `X-Agent-Key` |
| POST | `/api/grants` | `X-Agent-Key` |
| POST | `/api/actions` | `X-Agent-Key` |
| GET | `/api/verdicts/{order_id}` | none (demo read, like the dashboard) |
| GET | `/api/receipts/{receipt_id}` | none (demo read, like the dashboard) |

## POST /api/agents/register

```bash
curl -s -X POST "$AGENTRECEIPT_API_URL/agents/register" \
  -H 'content-type: application/json' -d '{"agent_name":"My agent"}'
```
```json
{ "agent_id": "ext-my-agent-1a2b3c4d", "agent_name": "My agent", "api_key": "ark_demo_…",
  "note": "Demo-issued key for hackathon, not a production credential." }
```
The key is shown once. Only its SHA-256 is stored (`api_agents.key_hash`).

```bash
export AGENTRECEIPT_API_KEY=ark_demo_...   # the api_key from the reply
```

## POST /api/sessions

Headers: `X-Agent-Key`. Body: `merchant` (must be `Northwind Outfitters` in the demo).
```bash
curl -s -X POST "$AGENTRECEIPT_API_URL/sessions" -H 'content-type: application/json' \
  -H "X-Agent-Key: $AGENTRECEIPT_API_KEY" -d '{"merchant":"Northwind Outfitters"}'
```
```json
{ "session_id": "0f6c…-…", "merchant": "Northwind Outfitters", "agent_id": "ext-my-agent-1a2b3c4d" }
```
Verified-agent status is simulated: a valid demo key counts as a verified agent.

```bash
export SESSION_ID=...   # the session_id from the reply
```

## POST /api/grants

Grant fields only. One grant per session.

| Field | Type |
|---|---|
| `session_id` | uuid |
| `merchant` | `"Northwind Outfitters"` |
| `budget_total_max` | dollars, the TOTAL including shipping, or null |
| `product_scope` | e.g. `"snowboard"`, or null |
| `size_range` | `"150-165 cm"`, `{"min":150,"max":165}`, or null |
| `colour` | string or JSON null (null = unspecified, no check) |
| `delivery_by` | `YYYY-MM-DD` or null |
| `return_policy_required` | true / false / null |
| `payment_method_ref` | `"Demo Checkout"` or null |
| `expiry` | exact timestamp, required, in the future |

```bash
curl -s -X POST "$AGENTRECEIPT_API_URL/grants" -H 'content-type: application/json' \
  -H "X-Agent-Key: $AGENTRECEIPT_API_KEY" -d '{
  "session_id": "'"$SESSION_ID"'", "merchant": "Northwind Outfitters", "budget_total_max": 500,
  "product_scope": "snowboard", "size_range": "150-165 cm", "colour": null, "delivery_by": "2026-10-28",
  "return_policy_required": true, "payment_method_ref": "Demo Checkout", "expiry": "2026-10-29T23:00:00Z" }'
```
```json
{ "grant_id": "…", "grant_hash": "sha256:…", "grant_entry_hash": "sha256:…",
  "canonical_grant_fields": { "agent_id": "…", "amount_max_cents": 50000, "colour_preference": null, "…": "…" },
  "hash_note": "grant_hash = SHA-256 of canonical JSON (sorted keys) of canonical_grant_fields. grant_entry_hash is its hash-chain entry." }
```
`grant_hash` is computed by the backend (`hash.ts`), never by a model. Anyone can recompute it from `canonical_grant_fields`.

## POST /api/actions

What the agent did. Action fields only. One order per session. Writes the structured proposal record (the agent's
summary fields) and the checkout action, then runs the existing auditor, which writes the hash-chained receipt.

| Field | Type |
|---|---|
| `session_id` | uuid |
| `product_name` | e.g. `"Burton Spellbinder Snowboard 2026/2027"` (matched to the merchant's catalog, with `size`) |
| `product_scope`, `size`, `colour` | string / whole cm / string or null |
| `item_price`, `shipping_price`, `total_price` | dollars; `total_price` must equal item + shipping (400 otherwise) |
| `delivery_date` | `YYYY-MM-DD` |
| `formal_terms` | what the agent read as the formal terms (recorded; the auditor uses the merchant's own catalog terms) |
| `agent_summary_returns`, `agent_summary_delivery` | what the agent told the customer (max 80 chars each) |
| `agent_believed_terms` | `{"returns": "..."}` or a string |
| `payment_method` | optional, default `"Demo Checkout"` (simulated, no real payment) |

```bash
curl -s -X POST "$AGENTRECEIPT_API_URL/actions" -H 'content-type: application/json' \
  -H "X-Agent-Key: $AGENTRECEIPT_API_KEY" -d '{
  "session_id": "'"$SESSION_ID"'", "product_name": "Burton Spellbinder Snowboard 2026/2027", "product_scope": "snowboard",
  "size": 156, "colour": null, "item_price": 449.95, "shipping_price": 60, "total_price": 509.95,
  "delivery_date": "2026-10-28", "formal_terms": "Final Sale", "agent_summary_returns": "Easy returns",
  "agent_summary_delivery": "Wed Oct 28", "agent_believed_terms": {"returns": "Easy returns"}, "payment_method": "Demo Checkout" }'
```
```json
{ "action_id": "…", "proposal_id": "…", "order_id": "15002", "receipt_id": "AR-2026-0045",
  "decision": "Review Required", "catalog_product_id": "40c70768-…", "verdict_path": "/api/verdicts/15002" }
```

## GET /api/verdicts/{order_id}

```bash
curl -s "$AGENTRECEIPT_API_URL/verdicts/15002"
```
```json
{ "order_id": "15002", "receipt_id": "AR-2026-0045", "decision": "Review Required", "decision_code": "review_required",
  "problems_count": 2,
  "problems": [
    { "field": "Budget", "grant": "$500.00 max", "merchant_terms": "Item $449.95 + shipping $60.00", "actual": "$509.95 total",
      "match": "mismatch", "cause": "Total $509.95 (item + shipping) is over the $500.00 budget" },
    { "field": "Returns", "grant": "Returnable required", "merchant_terms": "Final Sale", "actual": "Agent summary \"Easy returns\"",
      "match": "mismatch", "cause": "Agent summary \"Easy returns\" misrepresented the formal terms (\"Final Sale\")" } ],
  "checks": [ "…every check, same columns…" ], "missing_components": [], "suspicion_reasons": [],
  "receipt_hash": "sha256:…",
  "hash_chain": [ { "type": "grant", "chain_seq": 21, "prev_hash": "sha256:…", "entry_hash": "sha256:…", "recomputed_hash": "sha256:…", "content_ok": true, "link_ok": true },
                  { "type": "proposal", "…": "…" }, { "type": "action", "…": "…" }, { "type": "receipt", "…": "…" } ],
  "hash_verification": { "verified": true, "method": "entry_hash = SHA-256(prev_hash + \"\\n\" + canonical JSON of the stored row …)" },
  "dashboard_path": "/dashboard/orders" }
```
`problems` = the checks whose `match` is `mismatch` (columns Field | Grant | Merchant terms | Actual | Match | Cause).
Verification is recomputed on every call from the stored rows with `hash.ts`.

## GET /api/receipts/{receipt_id}

```bash
curl -s "$AGENTRECEIPT_API_URL/receipts/AR-2026-0045"
```
Same body as the verdict, plus `receipt_record` (the stored receipt row: terms snapshot, action summary, mismatch
results, `prev_hash`, `entry_hash`, `sealed_at`), so the receipt hash can be recomputed independently.

## Decisions (from the auditor, unchanged)

| Decision | When |
|---|---|
| Pass | 0 problems, hashes verify, all components present |
| Review Required | 1 or more field mismatches, hashes verify, all components present |
| Hold for Suspicion | a hash check fails, a required record is missing, the grant expired before the action, or the agent is unverified |

## Errors

| Case | Status | Body |
|---|---|---|
| Missing `X-Agent-Key` on a POST | 401 | `{"error":"Missing X-Agent-Key header. …"}` |
| Invalid `X-Agent-Key` | 401 | `{"error":"Invalid X-Agent-Key."}` |
| Missing / unknown session, or a session another agent opened | 400 / 404 | `{"error":"session_id is required."}` / `{"error":"Session not found for this agent."}` |
| Merchant is not Northwind Outfitters | 400 | |
| Bad field type, the string `"null"`, `total_price` ≠ item + shipping, expiry missing or past | 400 | `{"error":"…"}`; nothing is written |
| Second grant or second order on a session | 409 | |
| Action with no grant | 409 | `{"error":"No grant registered …","decision":"Hold for Suspicion","missing_components":[…]}`; the auditor answers, nothing is written |
| Missing grant/action component (e.g. no `agent_summary_*` → no proposal record, product not in catalog → no formal terms, no `delivery_date`) | 201 | The order is recorded and the auditor returns **Hold for Suspicion** with `missing_components`. A missing component is never a field pass/fail. |
| Auditor did not answer | 502 | `action_id` is returned; the dashboard lists the order as Hold for Suspicion (no receipt) |
| Unknown order / receipt | 404 | |
| Body over 4,000 bytes | 413 | |

## Limits (reused, not a new production system)

- Request size: 4,000 bytes per POST (same pattern as the auditor's and shopper's size caps).
- Text fields: 1,000 characters (the shopper's `MAX_TEXT`); agent summary fields: 80 characters (the shopper's offer summary cap).
- One grant and one order per session (as in the shopper flow).
- No per-IP or per-key request-rate throttle in this slice.

## Privacy boundary

The API accepts no chat and no free-text reasoning. The auditor still reads only grant fields, the merchant's formal
terms, the action record and the structured agent summary fields. `private_chat_hash` on an API grant is the SHA-256 of
an empty string, because no chat is ever sent.

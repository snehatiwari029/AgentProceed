# Examples

## External agent demo (`external-agent-demo.js`)

A standalone Node script that acts as a third-party agent against the public Agent Proceed API (`docs/API.md`). Environment variable names keep the internal `AGENTRECEIPT_` prefix.
No UI, no shopper chat, no seeded data. Node 18+ (built-in `fetch`), no dependencies to install.

### Run it

```bash
export AGENTRECEIPT_API_URL=https://uhuekreoflmvxnlutsai.supabase.co/functions/v1/api
```
```bash
node examples/external-agent-demo.js
```

Optional:
- `AGENTRECEIPT_API_KEY`: reuse a demo key from `POST /api/agents/register`. If unset, the script registers a new demo agent and prints its key once. No key is stored in the repo.
- `AGENTRECEIPT_APP_URL`: the deployed app, so the printed dashboard link is complete.

In order, it registers (or reuses) a demo agent, opens a session at Northwind Outfitters, registers a grant
($500 total budget, snowboard, 150-165 cm, colour null, deliver by 2026-10-28, returnable required, Demo Checkout),
logs the action (Burton Spellbinder 156 cm, $449.95 + $60 expedited = $509.95, arrives 2026-10-28, formal terms Final Sale,
agent said "Easy returns"), then prints the verdict from `GET /api/verdicts/{order_id}`: order_id, receipt_id,
decision, problems, receipt hash and hash-chain check, and the `/dashboard/orders` link.

Expected (from the auditor, not hardcoded): **Review Required**, 2 problems, Budget and Returns. If the API returns
something else, the script prints that.

### What it proves

An external caller, not our UI and not the phone shopper, produced an order whose verdict was decided by the same
auditor, and that order (same order_id, decision, problems and receipt hash) appears in `/dashboard/orders`. Every run
creates a new order (15002, 15003, …); seeded orders are not touched.

### What it does not prove

- Agent identity: these are demo-issued keys, not production signature verification or registered public keys.
- Not a Shopify (or any platform) integration.
- Not real payments: Demo Checkout is simulated.

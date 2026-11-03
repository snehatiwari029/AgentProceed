# Agent Proceed

**Agent Proceed: everything merchants need to sell confidently when the shopper is an AI agent.**

| Tool | What it does |
| --- | --- |
| **Agent Receipt** (flagship) | Order verification: checks each agent order against what the customer authorized, before fulfillment. |
| **Listing Optimizer + Read as Agent** | Listing tools: listing fixes for agents, and how a shopping agent reads each listing. |
| **Evidence Packet** | Disputes: builds the evidence pack for a shipped order that is later disputed. |
| **Agent Activity tracker** | Dashboard map of every agent session at its pipeline stage (`/dashboard/activity`), with a verdict badge per receipt. Read-only; refreshes every 20 seconds. |

Agent Receipt is the merchant-side check that binds a shopper's intent, a structured grant (VI-aligned demo representation), and the agent's action into a SHA-256 hash-chained receipt, then checks the action against the grant and the merchant's terms. Built for the Meta Global AI Developer Hackathon (submission 4 Nov 2026, 9pm ET). Checkout is simulated. No real payments.

Source of truth: PRD v0.2 plus `PRD-Amendment-1.md` and `PRD-Amendment-2.md` and `PRD-Amendment-3.md`.

## One app, three routes

One React app, one deployment. The routes are:

| Route | What it is | Theme |
|---|---|---|
| `/` | Demo entry page: three separate buttons (Customer phone, Northwind store, Merchant dashboard). | light |
| `/chat` | Customer phone: a centred phone frame where the shopper talks to Muse. Calls only the `shopper-agent` function. | light, neutral |
| `/shop` | Northwind Outfitters demo store, as a shopper or an agent sees it. 9 products read live from Supabase. | light retail |
| `/dashboard` | Agent Proceed merchant dashboard. Demo sign-in, then Dashboard, Agent orders, Disputes, Listing Optimizer. | dark |

## Folders (`src/`)

| Folder | What lives there |
|---|---|
| `shop/` | The store only. Header is brand, tagline, Ski / Snowboard anchors, cart. No link to the dashboard. |
| `dashboard/` | The merchant dashboard only. Its "View Store" link is an internal route to `/shop`. |
| `shared/` | Supabase client, row types, grant / receipt / dispute schemas, formatting helpers, the products hook. |
| `app/` | The router and the demo entry page. |
| `test/` | Render tests and the separation tests. |

Rules, enforced by tests (`src/test/separation.test.ts`):
- `shop` and `dashboard` never import each other. Anything both need goes through `shared`.
- `shop` source never mentions dashboard, grant, receipt, tamper or dispute.
- The shop uses no dashboard colours.
- No Lovable code and no external repo links in app source.

## Status

- Built: shop (9 products, photos from Supabase Storage), dashboard with demo sign-in and pages that read Supabase live (Agent orders, Disputes, Listing Optimizer), database schema.
- The dashboard pages show empty states until receipts exist. They fill in on their own once rows are written, with no code change.
- Built: shopper agent. Brain = Supabase edge function `shopper-agent` (Muse Spark, real tool-calling loop). Face = `/chat`.
- Built: Dispute Agent / Evidence Packet on the Disputes page (see below).
- Tamper check: there is no Tamper page. Each dispute's evidence package runs the tamper check on that order's own chain records (`verifyOrderChain` in `src/shared/chain.ts`) before the package is shown. A verified chain shows one line, "Receipt chain verified — tamper check passed", with the receipt hash; a failed chain says so plainly, names the failing link, and marks the record untrusted.

## Supabase

Project `AgentReceipt` (Postgres, Storage, edge functions). SQL, in order:
1. `supabase/001_schema_v0.2.sql`
2. `supabase/002_products_store_columns.sql`
3. `supabase/003_seed_products.sql` (the 9 products from the catalog CSV; header lists what was assumed)
4. `supabase/004_product_images_bucket.sql`
5. `supabase/005_demo_read_policies.sql` (read-only access for the dashboard; writes stay blocked)
6. `supabase/006_sessions_read_policy.sql` (read-only access to sessions)
7. `supabase/007_session_events.sql` (session log for the shopper agent; append-only)
8. `supabase/011_agent_api_keys.sql` (demo API keys for the public agent API, hashed; no browser access)
   - `supabase/012_listing_optimizer.sql` then `supabase/013_optimizer_remove_order_linkage.sql` (Listing Optimizer: `optimizer_scans`, `optimizer_suggestions`; browser read-only). Then deploy `supabase functions deploy optimizer --no-verify-jwt` with secrets `MODEL_API_KEY` and `STORE_PAGE_URL` (the shop page whose HTML as served is checked for Schema.org markup).
   - `supabase/014_dispute_agent.sql` (Dispute Agent: dispute fields as filed, `shipments`, `merchant_reviews`, merchant tracking event types; additive). Then deploy `supabase functions deploy disputes --no-verify-jwt` with secret `MODEL_API_KEY`.
9. `supabase/seed_dashboard_demo.sql` (optional demo rows: orders 12322, 13422, 14522 and the tamper receipt AR-2026-0041; generated by `npm run seed:generate`)

Product photos are stored in the `product-images` bucket. Each product has `image_id` (storage path) and `image_hash` (SHA-256 of the file). They are real retailer photos, not Muse Image generations (see Amendment 2, section 5).

## Shopper agent (`/chat` + `shopper-agent`)

- **Brain:** `supabase/functions/shopper-agent/` (deployed with `verify_jwt` off, because the phone screen calls it with the publishable key, which is not a JWT). Muse Spark runs only here.
- **Face:** `src/chat/`. It sends typed words and shows what comes back. It holds no model call, no extraction logic, no product choice, and no key.
- **Model endpoint used:** `POST https://api.meta.ai/v1/chat/completions`, model `muse-spark-1.3`, `Authorization: Bearer $MODEL_API_KEY`, `tool_choice: "auto"` (the only value the API accepts), one tool call per turn. Verified from https://dev.meta.ai/docs/tool-calling.
- **Secret:** set `MODEL_API_KEY` in Supabase > Edge Functions > Secrets. If it is missing the function answers `MODEL_API_KEY not set in Supabase secrets`. Optional `DEMO_DATE` (YYYY-MM-DD) pins "today"; otherwise the America/Los_Angeles date is used.
- **What the agent sees:** the chat, and per product: name, brand, size, colour, price, shipping options with delivery dates, and the product page text (`marketing_blurb`). It never receives the store's formal terms, any verdict, or any merchant-side data. Tests enforce this.
- **Flow (Amendment 5):** the customer sends a request; Muse replies with one sentence restating only what was said, two option cards (price, returns summary, arrival day; no total) and, only if needed, "Pick one, and tell me which payment to charge." The customer's reply that picks a product and names PayPal is the confirmation: only then are the session, grant, proposal and action written. Session log order: Verified agent detected (simulated), Session started, Intent captured, Intent hash recorded, Grant captured, Order received. "Receipt issued" is written by the receipt function (next build).
- **Stored:** fields only. The chat text is never stored, only its SHA-256 (`private_chat_hash`).
- To redeploy: `supabase functions deploy shopper-agent --no-verify-jwt` (the folder is self-contained; `hash.ts` is a tested copy of `_shared/hash.ts`).
- **Speed:** `set_order_rules` hands back the products that fit, so a first reply is usually two Spark calls. The phone asks for a stream (`Accept: application/x-ndjson`) and shows each "Muse is checking" line as it happens. The order reply does not wait for the auditor (it runs in the background via `EdgeRuntime.waitUntil`).
- **Order number:** after an order the phone asks `shopper-agent` (`{"action":"order_status","session_id":…}`) until the number exists. `shopper-agent` relays it from the order system's read-only `order-status` function (`supabase/functions/order-status`, session id in, order number out), so the brain itself never reads receipts. Deploy: `supabase functions deploy order-status --no-verify-jwt`.

## Dispute Agent (Evidence Packet, `/dashboard/disputes` + `disputes`)

- **What it does:** when the merchant records a dispute (manual "Record a dispute" form: order id, processor, claim as filed, claim type, reason code / condition as filed, dispute date, amount, processor reference), it checks the order id against the agent orders. Not an AgentReceipt order: "Not an AgentReceipt order — no evidence package built." and nothing is written. Otherwise it builds the evidence package from that order's verified record: Layer 1 (grant, action, formal terms snapshot, verdict table, receipt + tamper gate line, shipment), Layer 2 (merchant review records, or "No merchant review record."), Layer 3 (the claim as filed). Every item the processor's evidence needs that is not in the record is listed with where to obtain it, with a merchant-input flag.
- **What it does not do:** no fight / concede recommendation, classifier, win probability or score; the Agent Receipt verdict is evidence only. No deadline is computed ("Deadline: confirm with acquirer — settlement date not in record"). CE3.0 is shown as "cannot be determined from AgentReceipt record". No PayPal pack (Nov 5-12 sprint), no submission to a processor, no email / signed links.
- **Pack builder:** `supabase/functions/disputes/pack.ts`, pure code, one per-processor template (Visa, Mastercard) for field order, wording and checklist. The reason code is shown as filed; if it does not fit the claim type: "Code does not match claim — confirm with acquirer". Changing the format rebuilds the pack in that processor's format.
- **Spark (Feature 3):** writes only the plain-language claim reading and a short explanation. `validateSparkTexts` rejects any number, date, hash or code not in the input, and any recommendation / outcome / liability wording; then the template text is used, labelled "rules-fallback — deterministic check only, Spark formatting unavailable".
- **Downloads:** JSON and a printable view (print / save as PDF in the browser), both from one pack object. The pack's version stamp is the SHA-256 of its canonical JSON; the dashboard shows whether it matches the recorded pack generation entry. No server PDF (no PDF library in the repo).
- **Writes:** only through the `disputes` edge function (record_dispute, record_review, record_event, format_pack, record_pack), with the service role, each scoped to one merchant's own order. Merchant review records (Agent orders, Review Required / Hold for Suspicion only), decisions ("Mark as Fought (submitted to acquirer)", "Mark as Conceded", "Mark as Investigating"), outcomes (Won / Lost / Conceded / Pending) and dispute-time notes are appended to the chain, never edited. One dispute per order: a second one is refused and the first is kept.
- **Demo data:** 13422 / AR-2026-0043 is the only dispute: Pass, shipped Oct 27, delivered Oct 29, disputed Oct 30 under Visa 10.4 ("Agent overstep — agent exceeded budget / bought outside grant"), fought (submitted) Nov 1, merchant-reported Won Nov 2. Carrier, tracking, delivery proof, amount and processor reference are not in the record and are listed as missing.

## Run it

1. Copy `.env.example` to `.env.local` and fill in the project URL and the **publishable** key. Never put a service_role key or the Meta API key in a `VITE_` variable.
2. `npm install`, then `npm run dev`. Open `/`, `/shop` or `/dashboard`.
3. `npm test` runs the render and separation tests. `npm run build` typechecks and builds.

## Deploy

Any static host works, as long as every path serves `index.html` (single-page-app fallback) so `/shop` and `/dashboard` load directly:
- Vercel: `vercel.json` already has the rewrite.
- Netlify / Cloudflare Pages: `public/_redirects` is copied into the build.
- Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as build environment variables on the host.

- Deployment trigger

## Editing the public website (`/`)

- **Words:** `src/site/content.ts`. Every heading, paragraph, button, FAQ answer and form label is a plain string in that one file. Lines marked `PLACEHOLDER` are stand-in text waiting for real wording.
- **Look:** `src/site/site.css`. The variables at the top control every colour, font, page width and corner radius.
- **Layout:** `src/site/LandingPage.tsx` (home: hero, problem, what we do, how it works, products, FAQ, pilot form, footer) and `src/site/ProductsPage.tsx` (`/products`, exactly three products). Shared header/footer: `src/site/Chrome.tsx`.
- **Pilot form:** saves one row to the Supabase table `pilot_requests` (migration `supabase/010_pilot_requests.sql`). Visitors can insert only; read entries in the Supabase Table Editor.
- The store (`/shop`), phone chat (`/chat`) and dashboard (`/dashboard`) are separate and unchanged.

## Public agent API (`supabase/functions/api`)

Third-party agents can register, open a session, register a grant, log an action and read the verdict and receipt over HTTP: see `docs/API.md`. It writes the same chained records as the shopper and gets the verdict from the existing `auditor` function (no verdict logic of its own). Demo-issued keys only, stored hashed. A terminal-only proof is in `examples/external-agent-demo.js` (`examples/README.md`). Deployed with `verify_jwt` off (it checks `X-Agent-Key` itself): `supabase functions deploy api --no-verify-jwt`.

## Principle

**LLM where language is ambiguous, deterministic where money and trust are at stake.**

Muse Spark reads and normalizes language. Code does the budget arithmetic, the exact matching, the SHA-256 hashing and the Pass / Review Required / Hold for Suspicion decision. Spark never does arithmetic, never generates or "fixes" a hash, never reads the chat in the auditor, and never decides a verdict on its own.

## Decisions (three, everywhere)

At order received, before fulfillment, the auditor returns exactly one of these as structured JSON. The merchant's order system holds shipment/capture; Agent Receipt only recommends.

| Decision | When | Merchant | Meaning |
|---|---|---|---|
| **Pass** | 0 problems, hashes verify, all components present | Proceed, ship | Match |
| **Review Required** | 1 or more field mismatches, hashes verify, all components present | Do not ship yet. Flagged "Merchant review needed" under Orders requiring attention | "I trust the record, I don't trust the match." |
| **Hold for Suspicion** | A hash check fails, a required record is missing, the grant expired before the action, or the agent is unverified | Do not proceed. Investigate the record or agent first. Flagged under Orders requiring attention | "I don't trust the record itself yet." |

Orders requiring attention = Review Required + Hold for Suspicion. **The hero order ($509.95, two problems) is Review Required and has no dispute**: review before fulfillment prevents the dispute. A dispute is a separate thing, shown only on a different, already-shipped order (the Orca order 13422). Represent / concede are post-dispute outcomes on that separate order, not decisions.

Agent Receipt shows mismatch facts only; it does not decide liability and no network rule moves liability on any screen.

## Auditor privacy boundary

The auditor never receives the customer chat and never receives proposal free text. The shopper writes a structured proposal record next to the chat (fields only): the proposed product, item price, total shown (or null), `agent_summary_returns`, `agent_summary_delivery` and the `agent_believed_terms` it set. The auditor reads only those fields, the grant fields, the formal `terms_text` and the action record. The audit JSON echoes exactly those fields (`agent_summary`) and has no chat field and no proposal-text field. A test enforces this.

## Meta model calls per hero flow

Each call is a separate, isolated Muse Spark call with its own prompt, JSON-only output and a labelled fallback.

| # | Call | Where | Input | Spark output (LLM) | Deterministic (code) | Status |
|---|---|---|---|---|---|---|
| 1 | Shopper tool-calling loop | `shopper-agent` | Customer chat (private, stays in the shopper) + store product summaries | Tool calls over several turns: set rules, search, get product, propose, place order. Reasoning shown on screen | Tool execution, totals, delivery dates, "arrives in time" check | Built |
| 2 | Grant extraction | `shopper-agent` (`set_order_rules`) | Free-form request | Structured grant fields: budget, exact delivery date, returnable, size range, colour, product scope. Unmentioned = real null (the string "null" is also treated as null) | Validation, cents, date checks | Built |
| 3 | Agent summary comparison | `auditor` | Structured fields only: `agent_summary_returns`, `agent_believed_terms`, formal `terms_text` | `returns_summary_matches_terms` true/false + reason ("no-hassle returns" vs "Final sale") | The Returns check and its cause use that answer; keyword fallback labelled `rules-fallback` | Built |
| 4 | Language normalization | `auditor` (delivery phrase); shopper grant extraction (dates) | `agent_summary_delivery` phrase + today's date | An exact date, only when code cannot read the phrase itself | Date compare, budget math, exact matching | Built (delivery phrase); other fields planned |
| 5 | Evidence Packet narrative | planned | Auditor JSON only | 2-3 plain sentences + next action, no new amounts | Table shown alone, labelled fallback, if Spark fails | Planned |
| 6 | Listing Optimizer (dashboard: Listing Optimizer) | `optimizer` | One listing's own text: title, brand, `marketing_blurb`, details, formal `terms_text`. No orders, receipts or chat | Atomic fields (kept only if written in the listing) + does the marketing returns claim match the terms | Five-pillar presence checks, Schema.org in the HTML as served, totals, Section 8 ranking, re-scan resolution. Merchant approves; never auto-edits; `rules-fallback` if Spark fails | Built |
| 7 | Dispute reason classification | planned | Free-text reason on a separate disputed order | Budget / Returns / Delivery / Product / Other | Engine runs the mapped checks; Spark does not decide the outcome | Planned |

Not done by Spark, ever: budget arithmetic ($449.95 + $60 = $509.95), SHA-256 hashes, the decision, reading the chat in the auditor.

## Hash spec

One file defines hashing for every chained record: `supabase/functions/_shared/hash.ts`. The edge functions, the dispute tamper check, the seed script and the tests all import it.

`entry_hash = sha256( prev_hash + "\n" + canonical JSON of the row )`, where the row leaves out `prev_hash`, `entry_hash`, `chain_seq` and `created_at`, object keys are sorted at every depth, and date-times are written in one fixed format. The first entry points at an all-zero origin hash. A grant's seal is its `entry_hash`.

## Detection engine files

- Rules: `supabase/functions/_shared/audit.ts` (no model, no hashing). Input builder: `audit-input.ts`. Auditor function: `supabase/functions/auditor/` (Spark calls in `spark.ts`).
- Checks in order: Product, Budget (item + shipping total), Delivery (including the arrival the agent told the customer), Colour, Size, Merchant, Payment, Returns, Grant validity.
- An unspecified grant field is "not specified" and is never a problem. A missing record is Hold for Suspicion.

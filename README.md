# Agent Proceed

**The trust layer for merchants in agentic commerce.**

AI agents now shop and pay on behalf of real shoppers. Nothing checks whether the agent bought what the shopper actually asked for. Agent Proceed is a suite of four trust-building tools for merchants: it verifies every agent order against the shopper's own rules before it ships, seals a provable receipt, fixes the listings that cause the errors, and turns the receipt into dispute evidence PayPal accepts.

- **Live demo:** https://agent-proceed-mu.vercel.app (shop at `/shop`, chat at `/chat`, dashboard at `/dashboard`, hackathon page at `/hackathon`)
- **Receipt service:** https://agent-receipt-mu.vercel.app (the original deployment address; it now redirects to the live demo)
- **Demo video:** https://youtu.be/QkUEvOSWIQc
- **Devpost:** https://devpost.com/software/agent-proceed (PayPal AI Hackathon, Devpost 1271266)
- **Built for:** PayPal AI Hackathon

## The problem

Agentic commerce is here, and it is compounding. AI platforms will account for $20.57B in US retail ecommerce in 2026, nearly quadruple 2025 (EMARKETER). Shopify reported orders from AI-powered searches up nearly 13x year over year in Q1 2026. Salesforce measured AI and agents influencing $67B in global sales during Cyber Week 2025, 20% of all global orders. McKinsey puts global agentic commerce at $3-5T by 2030.

But the agents get it wrong, and nobody trusts them yet.

- **Agents buy the wrong thing.** Visa's Agentic Commerce Benchmark (Nov 5, 2026) put 22 AI models through 15 shopping challenges. Only 57.2% of runs passed, and 54% of failed runs still ended in a purchase. The agent bought the wrong thing **23% of the time**.
- **Shoppers don't trust agents to pay.** 65% of Americans trust AI to compare prices, but only 14% trust it to place orders autonomously, a 51-point gap (Axis Intelligence Trust Gap Index). Visa's Trust Index found 72% of consumers had used an AI assistant, but only 23% trusted AI to make payments.
- **Agents are easy to steer.** Agent data-injection attacks succeeded 49.1% of the time against a GPT-5.2 agent, while classic instruction injection succeeded only 0.2% (Choi, Kim et al., July 2026). Misleading seller pages put unsuitable products in an agent's top three 8 times in 10, and a single seller-written line is worth up to 22% in price to an AI agent (Ballerine).
- **When it goes wrong, the merchant pays, and the merchant is blind.** Global chargeback losses hit $33.79B in 2025 across 261 million disputed transactions. US merchants lose $4.61 in total costs for every $1 lost to chargebacks. A single chargeback costs about $128 in handling (Mastercard 2025). Merchants win roughly 41% of representment cases, and net recovery after costs drops to 12-18%. Visa's VAMP program flags merchants as Excessive at a 1.5% ratio. And the merchant cannot see what the shopper actually asked the agent for. They ship the order blind, then eat the return or the chargeback.
- **The chargeback system itself breaks.** It rests on a binary: either the cardholder authorized the transaction, or they didn't. With an autonomous agent, the transaction *was* authorized, only the outcome went wrong. PayPal's own April 2026 guidance states Seller Protection does not cover item-not-as-described claims or buyer's remorse, whether a person or an AI agent initiated the dispute.

## Why the existing protocols don't solve it

The industry is building the payment rails. None of them checks whether the order matches what the shopper asked for, and none of them helps the merchant when it doesn't.

- **Visa Trusted Agent Protocol (TAP)** (launched Oct 14, 2025, with Cloudflare): the agent signs its requests so a merchant can verify it is a real agent, not a bot. Live in Europe since July 2026.
- **Mastercard Agent Pay** (unveiled Apr 29, 2025): tokenized agent payments with agent identity and verifiable intent bound to the token. Full US rollout Nov 2025.
- **Google AP2 (Agent Payments Protocol)** (launched Sep 2025, 60+ partners, now governed by the FIDO Alliance): signed mandates proving a real person authorized a specific purchase for a specific amount.
- **OpenAI + Stripe ACP (Agentic Commerce Protocol)** (launched Sep 2025, open source): the checkout handshake, with single-use delegated payment tokens capped by merchant, amount, and expiry.
- **Google UCP (Universal Commerce Protocol)** (announced Jan 2026, co-developed with Shopify, Etsy, Target, Walmart and others): the full journey from discovery to checkout.
- **PayPal Agent Ready** (announced Oct 2025): powers checkout in ChatGPT and Google AI Mode, with the PayPal wallet as a funding option.

Every one of these solves how the agent pays. None of them verifies the order against the shopper's intent from the merchant's side, none gives the merchant a receipt, a verdict, or dispute evidence. That is the gap Agent Proceed fills.

## The solution: four tools for merchants

Agent Proceed is a merchant-side trust layer. Four tools, one suite:

1. **Agent Receipt**: verifies every agent order against the shopper's own rules before it ships, issues a verdict (Pass, Review Required, or Hold for Suspicion), and seals a hash-chained, Ed25519-signed receipt anchored to the PayPal order.
2. **Agent Activity**: a live map of every agent order, so the merchant can see agent traffic as it happens.
3. **Agent Optimize**: audits the merchant's listings against a five-factor agent-readability framework and returns the fixes, so the error does not recur.
4. **Agent Dispute**: builds the evidence packet from the receipt and submits it to PayPal through the live Disputes API, with webhook intake for dispute events.

## Try it in two minutes

1. Open the demo store at `/shop` (Northwind Outfitters, 9 products read live from Supabase).
2. Talk to the shopper agent at `/chat`: ask for a product the way a customer would, and watch the agent restate the request, offer options, and place the order.
3. Or call the public agent API directly: register an agent, open a session, record a grant, and place an order.
4. Sign in to the merchant dashboard with the pre-filled demo sign-in (Northwind Outfitters).
5. Open Agent orders: every agentic order carries a decision (Pass, Review Required, or Hold for Suspicion) and a hash-sealed receipt showing exactly what was granted and whether the action matched it.
6. Open Agent activity: the store map shows each agent session at its pipeline stage, with bot icons and verdict badges.
7. Open Optimization for Agents: see the five-pillar listing review, the multilingual returns comparison, and the agent read-test.
8. Open Disputes: see the evidence packet for a disputed agent order, built for its processor, and submit it to PayPal Sandbox through the live Disputes API.

## What it does

### 1. Know the agent did what the shopper wanted: Agent Receipt (flagship)

Today's protocols only verify that the user authorized payment. Agent Receipt records the full chain and checks it:

- Every agentic transaction is stored as a SHA-256 hash-chained receipt, with intent, authorization, and action kept separate.
- Only the confirmed grant excerpt, exactly as the customer stated it, is hash-sealed and shown to the merchant. The full customer chat stays private.
- A field the grant never mentions is recorded as unspecified, never as false. Decisions are made only on consumer-specified parameters. Decision-grade attributes (budget, merchant, returns) are separated from noise.
- Merchants get a clear record of what was granted and whether the action matched it.
- Major mismatches are flagged Review Required or Hold for Suspicion before they become returns or chargebacks.
- Merchant listing details and policies are recorded at scan time, preventing disputes over what was shown at purchase.
- **Ed25519 signature:** after sealing, the seal hash is signed with the merchant's Ed25519 key. The private key lives only in the `MERCHANT_ED25519_SEED` Supabase secret, never in the repo or the frontend. The public key is published at `GET https://uhuekreoflmvxnlutsai.supabase.co/functions/v1/receipt-seal?action=public_key` (key `ed25519:cb18386e9a743676`).
- **PayPal anchoring:** the seal hash is written into the PayPal order's `custom_id` as `ap1:<seal_hash>` at order creation, before payment. This binds the receipt to the payment record on PayPal's side, not just in our database.
- **Public verify:** `POST {"action":"verify","paypal_order_id":"..."}` to `.../functions/v1/receipt-seal` returns match, mismatch, or unsigned on six checks: the PayPal `custom_id` carries an `ap1` seal; the order has a receipt; the receipt hash recomputes from its stored fields; the `custom_id` seal equals the receipt seal; the signature uses the published merchant key; the Ed25519 signature over the seal verifies.
- **Verified live:** order 15018 (receipt AR-2026-0061, verdict Pass, Capita Outerspace Living, $370.83), PayPal order 84U41139Y1150392V, `custom_id` `ap1:sha256:e85b3f13...5de9a`, identical to the receipt seal. Signature `6a6dc14d...511240f`, key `ed25519:cb18386e9a743676`. All six verify checks returned match.

The verdict logic lives in `audit()` in `audit.ts`. `runAuditor()` recomputes hashes, builds audit input from stored records, and seals the receipt. The chain is verified with the existing `verifyOrderChain()`.

### The demo order

Order 15010 is the canonical demo case. A shopper asked for a Burton Spellbinder Snowboard 2026/2027, under $500, with easy returns. The agent ordered it: $449.95 item, $509.95 total against a $500 budget, and the listing promised "Easy returns" when the real policy is Final Sale. Verdict: **Review Required**, flagged on Budget and Returns. The merchant holds it before shipping instead of eating a return or a chargeback.

### 2. Be found and understood by agents: Listing Optimizer plus Read as Agent

- **Listing Optimizer** reviews every listing detail against five pillars of agent listing optimization: (1) Feed Hygiene and Real-Time Accuracy, (2) Precision and Explicit Attributes, (3) Machine-Readable Schema (Schema.org), (4) Answer Engine Optimization (AEO), (5) Multi-Point Trust and Verification. It suggests merchant-approved fixes and never auto-edits a listing.
- **Read as Agent (Agent Read-Test)** reads the displayed listing the way an agent would: Muse Spark answers four fixed questions from the displayed listing only, blind to the formal terms, and code compares the answers to those terms. Results are Match, Mismatch, or Agent answer not stated. It is the fifth product call inside Listing Optimizer.
- **Multilingual Returns Comparison** compares Spanish or Hindi returns summaries to the English formal terms by meaning. Unspecified stays unspecified. Cannot determine appears only for no-returns-information or model fallback, and is not counted as a problem by itself.

### 3. Win disputes without the scramble: Evidence Packet plus live PayPal submit

Agent-involved orders add a middle party, and no tool built for them assembles the evidence. Evidence Packet:

- Reviews a dispute and automatically identifies agentic orders by checking the order against the agent orders database.
- Builds an evidence packet customized to the processor (Visa, Mastercard, and others).
- Highlights any merchant-specific information the receipt cannot supply, so the merchant fills only what is missing.
- When the merchant connects a Shopify store and grants disputes permission, dispute information auto-populates from the dispute notice and the pack auto-builds. The manual record-a-dispute form is the fallback for stores not yet connected.
- Deliberately contains no fight-or-concede recommendation, no classifier, and no win-probability score: with no outcome data yet, that would be a guess dressed as advice.
- Sample data is marked honestly: a legend at the top plus blue for real record data and orange for sample data, with section-level marking where sample fields cluster. Sample values are never presented as filed.

**Live PayPal Disputes API submit (new in the PayPal hackathon):**

- Edge function `paypal-disputes` (Supabase). Uses only the `PAYPAL_CLIENT_ID` and `PAYPAL_SECRET` Supabase secrets, only `api-m.sandbox.paypal.com`, writes nothing to the DB.
- The Dispute page carries a "PayPal Sandbox disputes" card listing PayPal-paid orders, each with a "Submit evidence to PayPal (Sandbox)" button and a result panel (submitted, not available yet, not submitted, PayPal error).
- **Live submit, verified:** order 15016, a $370.83 Sandbox payment disputed by the buyer as SNAD (item not as described). Case PP-R-BHF-10199678, stage CHARGEBACK, `provide_evidence` offered. Evidence type `ITEM_DESCRIPTION`, receipt AR-2026-0059, receipt hash `sha256:f946d516...0447`, PayPal order 12123471LF747714E, transaction 4BM03217CF5644340, pre-fulfillment verdict Pass (0 problems found), sealed 2026-11-12. Submitted through PayPal's `provide-evidence` API and **accepted on the first try**. The dispute is now UNDER_REVIEW with PayPal.
- **Honest non-submit:** order 15010, an item-not-received (INR) dispute, case PP-R-YLY-10199668, $509.95, WAITING_FOR_SELLER_RESPONSE, due 2026-12-02. `provide_evidence` was offered, but PayPal rejected all 8 attempts with EVIDENCE_TYPE_IS_NOT_ALLOWED. For INR, PayPal only accepts shipment tracking (proof of fulfillment) or proof of refund. The order never shipped (it was flagged Review Required), so there is no tracking, and the receipt was correctly refused as proof of fulfillment because that would misstate the record. This dispute remains unsubmitted, as it should.
- **Webhook intake:** edge function `paypal-webhook`. `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, and `CUSTOMER.DISPUTE.RESOLVED` events are verified with PayPal's `verify-webhook-signature` API (Sandbox) before anything is written, then auto-create or update the dispute record, matched to the recorded PayPal payment by transaction ID or kept as unmatched. Unverified requests are rejected with 401. Every request is logged (event type, dispute ID, verification result) with no secrets. The webhook is registered by the merchant in the PayPal Developer Dashboard (Sandbox, Webhooks), never self-registered.
- **Webhook intake, verified live:** order 15007 (Salomon Assassin, $449.95), disputed by the buyer as not as described, case PP-R-DPD-10199694. PayPal delivered `CUSTOMER.DISPUTE.CREATED` and `CUSTOMER.DISPUTE.UPDATED`; both passed signature verification. The dispute record was created automatically and matched to order 15007 by transaction 18000836WY620653P: reason MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED, $449.95, WAITING_FOR_SELLER_RESPONSE, response due 2026-12-02, identical to PayPal's Disputes API.
- **PayPal API facts established in the build:** disputes cannot be created via API (the buyer files through the Resolution Center); `provide_evidence` appears only when seller evidence is requested, and PayPal offers it inconsistently by reason and stage (the 15016 case advanced from INQUIRY to CHARGEBACK on its own before evidence was offered); both PP-R and PP-D are valid dispute identifiers; the canonical ID comes from List Disputes; HATEOAS links in get-details show the available actions.

### 4. See agent activity: Agent Activity map

The merchant dashboard includes a live store map of agent activity:

- Each bot icon is a real agent session, placed by its pipeline stage: session opened (browse aisles), grant recorded (product displays), proposal presented (cart area), order placed or verdict issued (checkout line).
- The storefront artwork is a Muse Image asset generated once at build time, with zone labels as HTML overlays.
- A side panel lists every session with its agent, stage, order, verdict badge, and last update. Clicking a row opens that order's inline check in Agent orders.
- The map refreshes every 20 seconds and an icon moves only when a stored record changes.
- Scoping is honest: activity queries are filtered to the demo merchant (Northwind Outfitters) in the query itself. There are no row-level security policies restricting these tables per merchant, and the submission does not claim otherwise.
- The map shows pipeline stage, not live browsing. The public API records only agent registration, session opening, grant, and order action. There are no browsing, page-view, or cart events anywhere in the API or data model.
- The volume is compounding: Forter counted 5.3x more agent-placed orders across its network in early October than in early August (average order $223), with automated fraud doubling over the same period. AI agents completed 0.68% of US online orders in Q3 2026, up from 0.27% the quarter before. Merchants currently have no live view of which orders are agent orders. Activity is that view.

## Evaluation

A labeled verdict eval, run against the real verdict logic. `npm run eval:verdict` (`scripts/run-verdict-eval.ts`). 15 cases built from the live Northwind catalog: 5 Pass, 6 Review Required, 4 Hold for Suspicion. Cases in `evals/verdict_cases.json`, full report in `evals/verdict_eval_results.md`.

For each case the runner builds the order's grant, proposal, and checkout records, chained in memory with the app's own chaining code, then calls the real `runAuditor()` → `audit()` unchanged, and checks each order's chain (including the sealed receipt) with the existing `verifyOrderChain()`. Return terms are read by the auditor's built-in keyword rules rather than the Muse Spark model, so every run is deterministic and repeatable.

| Metric | Agent Proceed verdict | Baseline (no verification) |
|---|---|---|
| Miss rate | **0.0% (0/10)** | 100.0% (10/10) |
| Chargebacks prevented | **100.0% (10/10)** | 0.0% |
| False-hold rate | **0.0% (0/5)** | 0.0% |
| Accuracy (exact verdict) | **80.0% (12/15)** | 33.3% (5/15) |
| Receipt integrity | **93.3% (14/15)** | No receipt |

The headline is the miss rate: the verdict caught all 10 bad orders and flagged none of the 5 good ones. Chargebacks prevented is the merchant outcome metric: every bad order stopped before shipping is a chargeback that never happens.

Honest caveats, stated plainly:

- **Exact-verdict accuracy is 80%, not 100%.** Three of the four Hold for Suspicion cases (far over budget, wrong category, unknown merchant) came back as Review Required. All three were still stopped before shipping, so they count as caught, not missed. The difference is severity, not outcome. The logic returns Hold only when the record itself cannot be trusted (hash failure, missing record, expired grant, unverified agent). Any field mismatch, however large, is Review Required. Whether a far-over-budget, wrong-category, or unknown-merchant order should escalate to Hold is a product decision; the logic was deliberately not changed for the eval.
- **Receipt integrity is 93.3% because of the tampered-record case.** H4 is an order whose action record was edited after sealing. Its chain correctly failed to verify, and the logic correctly returned Hold for Suspicion. That is the system working, not a failure.
- **The eval tests the verdict rules, not the production model.** It uses the deterministic rules reader (`createSparkReader(null)`), not the Muse Spark model used in production, so the eval measures the decision logic in isolation.
- **Multi-item orders are not covered.** A checkout record holds exactly one product, so the order model cannot express "multiple items when one was requested."

## Built with Meta AI

Two Meta models, used where each earns its place. No other Meta model is claimed.

| Product call | What Muse Spark does | What code decides |
|---|---|---|
| Returns Comparison (multilingual) | Reads the agent's returns summary and the formal terms, and compares them by meaning across English, Spanish, and Hindi | Match, Mismatch, or Cannot determine; unspecified stays unspecified |
| Delivery-Date Reading | Reads delivery language from the listing and the order | Whether the promised date matches the record |
| Listing Optimizer deconstruction | Deconstructs the displayed listing into the five pillars | Which details are missing or imprecise; fixes are suggested, never auto-applied |
| Dispute Narrative | Drafts the dispute narrative from the order record | The pack assembly per processor rules, and the tamper check |
| Agent Read-Test | Answers four fixed questions from the displayed listing only, blind to formal terms, quoting the listing or answering "Not stated in listing" | Match, Mismatch, or Agent answer not stated, by comparing answers to formal terms |

- **Muse Spark** runs all five product calls through the Meta Model API (`POST https://api.meta.ai/v1/chat/completions`, model `muse-spark-1.3`). Spark reads language; code decides, compares, and hashes. No product call trusts model output unchecked.
- **Muse Image** (`muse-image-1.0`) generated the storefront artwork for the activity map exactly once at build time. It is a static asset, not a runtime call, and it is not used for product photos: product photos are real retailer photos stored in Supabase Storage.
- **Deliberately not used:** Muse Video (no public developer API), Muse Voice Transcribe, SAM 3.1, and Llama. The shopper agent loop and grant extraction are a demo simulation only, never the product. The product is the verification layer: Returns Comparison, Delivery-Date Reading, Listing Optimizer, Dispute Narrative, and Agent Read-Test.
- **Not claimed:** the Universal Commerce Protocol, the Personal Agent Protocol, and AP2 mandates. Those handle checkout interoperability, agent authentication, and payment authorization. None of them checks what the agent actually ordered against the grant and the formal terms. That check is Agent Proceed's product.

## How it works

**One app, four routes, one deployment.** React 18, React Router 7, Vite, TypeScript, Tailwind CSS 4, deployed on Vercel.

| Route | What it is | Theme |
|---|---|---|
| `/` | Agent Proceed landing page (with `/products` for the four tools and `/hackathon` for the judge launchpad) | Light |
| `/chat` | Customer phone: the shopper talks to the shopper agent | Light, neutral |
| `/shop` | Northwind Outfitters demo store, as a shopper or an agent sees it. 9 products read live from Supabase | Light retail |
| `/dashboard` | Merchant dashboard: demo sign-in, then Dashboard, Agent orders, Agent activity, Disputes, Optimization for Agents | Dark |

**Backend.** Supabase (Postgres, Storage, edge functions). Edge functions: `shopper-agent` (Muse Spark tool-calling loop behind `/chat`), `api` (the public agent API), `optimizer`, `disputes`, `paypal-disputes` (live PayPal Disputes API), `receipt-seal` (Ed25519 signing, `custom_id` anchoring, public verify), `paypal-webhook` (verified webhook dispute intake). Migrations live in `supabase/` in order, `001` to `018` (schema, products, storage bucket, read policies, sessions, agent API keys, optimizer, dispute agent, PayPal Sandbox payments, evidence submissions, receipt signatures, webhook disputes), plus the demo seed.

**Public agent API.** `POST /api/agents/register`, `POST /api/sessions`, `POST /api/grants`, `POST /api/actions`, `GET /api/verdicts/{order_id}`, `GET /api/receipts/{receipt_id}`. Demo API keys are hashed. Dashboard access is read-only; writes stay blocked.

**Hash chain and tamper check.** Receipts are SHA-256 hash-chained. Each dispute's evidence package runs the tamper check on that order's own chain records (`verifyOrderChain`) before the package is shown. A verified chain shows "Receipt chain verified, tamper check passed" with the receipt hash. A failed chain says so plainly, names the failing link, and marks the record untrusted. There is no separate Tamper page; the check is a gate inside the evidence pack.

**Decisions.** Every audited order ends in exactly one of three decisions: Pass, Review Required, or Hold for Suspicion. Orders requiring attention are the Review Required plus Hold for Suspicion set.

**Separation rules, enforced by tests.** The shop and the dashboard never import each other; anything both need goes through `shared`. Shop source never mentions dashboard, grant, receipt, tamper, or dispute, and uses no dashboard colors. No Lovable code and no external repo links in app source.

**Tests.** Automated suite with Vitest (`npm test`), **406 tests passing**, covering the auditor, the optimizer, the dispute packs, the activity positions, and the separation rules. Build is typechecked (`tsc --noEmit && vite build`).

## Tech stack

- **Frontend:** React 18.3.1, react-router-dom 7, Vite 6, TypeScript 5.6.3, Tailwind CSS 4
- **Backend:** Supabase (Postgres + Edge Functions), `@supabase/supabase-js` 2.45
- **Payments:** PayPal Sandbox (Orders API, Disputes API, webhooks)
- **LLM:** Muse Spark (chat agent, attribute comparison, Read as Agent scan)
- **Testing:** Vitest, **406 tests passing**
- **Protocols and standards referenced:** Visa TAP, Mastercard Agent Pay, Google AP2, OpenAI + Stripe ACP, Google UCP, Schema.org, hash-chained audit ledgers

## What is real, and what is demo

- Checkout is simulated. No real payments move. PayPal runs in Sandbox throughout.
- The shopper agent loop and grant extraction are a demo simulation. The verification layer (receipts, optimizer, read-test, dispute packs, activity map) reads real stored records.
- The Dispute API submit, the webhook dispute intake, the receipt Ed25519 signature, the `custom_id` anchoring, the public verify, and the eval are real, run against live PayPal Sandbox and the production verdict logic.
- Map traffic is simulated agent traffic for the demo merchant only, labeled as such on the page.
- Sample dispute fields are marked orange and labeled as sample; real record fields are blue.
- Store health and profit figures on the dashboard are demo values and are labeled Demo. The attention count and the orders list are live from Agent orders.
- Product photos are real retailer photos, not AI generations.

## Run it locally

```bash
npm install
npm run dev      # Vite dev server
npm run build    # tsc --noEmit && vite build
npm run test     # vitest run (406 tests)
npm run eval:verdict  # labeled verdict eval (scripts/run-verdict-eval.ts)
```

Supabase setup follows the migrations in `supabase/` in order. Edge functions need `MODEL_API_KEY` in Supabase Edge Functions Secrets (the Meta Model API key). The optimizer also needs `STORE_PAGE_URL` (the shop page whose served HTML is checked for Schema.org markup). PayPal Sandbox credentials go in as Supabase secrets (`PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`); the merchant signing key goes in as `MERCHANT_ED25519_SEED` (a 32-byte seed, 64 hex); the webhook ID PayPal assigns goes in as `PAYPAL_WEBHOOK_ID`. If `MODEL_API_KEY` is missing, the shopper agent answers that it is not set.

## How it compares

Agent Proceed is merchant-side. The closest competitors are buyer-side or reactive, and none of them has a pre-fulfillment verdict, listing optimization, or an activity map.

|  | Agent Proceed | Countersign | paypal-agent-guard | AgentGuard |
|---|---|---|---|---|
| Side | Merchant | Buyer | Buyer | Buyer |
| Pre-fulfillment verdict | Yes (Pass / Review / Hold) | No | Yes (pre-purchase gate) | No |
| Hash-chained receipt | Yes (SHA-256 + Ed25519, `custom_id`) | Yes (SHA-256 + Ed25519, `custom_id`) | No (SQLite audit log) | Planned |
| Disputes API submit | Yes (live, verified) | Yes (Deep Agent) | No | No |
| Webhook dispute intake | Yes | Yes | No | No |
| AP2 mandate export | No | Yes | No | No |
| Listing optimization | Yes | No | No | No |
| Activity map | Yes | No | No | No |
| Labeled eval | Yes (15 cases, 0% miss rate) | Yes (11 golden evals) | Yes (~60 cases) | Planned |

## Why this matters

Merchants do not hold back from agentic commerce because they doubt agents. They hold back because every agent order is a small gamble: did it buy the right variant, at the right price, under the right returns terms, and can the merchant prove it when the dispute arrives? Agent Proceed turns that gamble into a record. Discoverable listings bring agent traffic in. Verified receipts keep that traffic profitable. Evidence packets keep it defensible. The result is adoption merchants can say yes to: discoverable by agents, protected from intent mismatches, and prepared for disputes.

## What's next

1. Free pilot with selected merchants to test Agent Optimize.
2. User sessions with Shopify merchants who have received agent orders, to fine-tune Agent Receipt before building a Shopify app.
3. Goal: all four tools as a Shopify app, plus a public API for Agent Receipt.
4. Expose the four tools as an MCP server, so any Claude commerce agent can verify orders, read agent activity, audit listings, and build dispute evidence through one connection. (Anthropic's Sep 2026 commerce blueprint uses MCP as the integration layer, and its shopping agent deliberately stops short of the money. That is exactly where this trust layer sits.)
5. Applying to Techstars Finance 2027.

## Limitations and honest notes

- The demo store (Northwind Outfitters) and the shopper agent are simulations. The verifying agent, the receipt, the verdict, the Dispute API submit, and the eval are real.
- PayPal runs in Sandbox throughout. No live payments.
- The eval uses the deterministic rules reader, not the production Muse Spark model, and covers single-product orders only.
- The INR dispute on order 15010 was deliberately not submitted: PayPal only accepts shipment tracking or proof of refund for INR, the order never shipped, and submitting the receipt as proof of fulfillment would misstate the record.
- Orders created before receipt signing (15010, 15016) have no Ed25519 signature, and their PayPal orders carry no `ap1` seal. Verify reports them as unsigned ("No signature: this order predates receipt signing"), and their receipt hashes still recompute. Mismatch is kept for records that should match and don't.

## Links

- Live demo: https://agent-proceed-mu.vercel.app
- Receipt service: https://agent-receipt-mu.vercel.app
- GitHub: https://github.com/snehatiwari029/AgentProceed
- Demo video: https://youtu.be/QkUEvOSWIQc
- Devpost: https://devpost.com/software/agent-proceed

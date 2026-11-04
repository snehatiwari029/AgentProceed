# Agent Proceed

> Everything merchants need to sell confidently when the shopper is an AI agent.

AI agents are becoming the new shoppers. Payment networks and banks have built secure protocols so consumers can let agents pay on their behalf. Those protocols verify that the user authorized payment. They do not verify that the agent bought what the shopper actually intended. That gap between intent and action drives returns, refunds, and chargebacks, and it leaves merchants with listings agents cannot read well, suspicious agent orders to screen by hand, and disputes with no playbook. Agent Proceed closes the merchant side of that gap.

**Live demo:** https://agent-receipt-mu.vercel.app
**Demo video:** [link added at submission]
**Built for:** Meta Global AI Developer Hackathon (submission November 4, 2026)

## Try it in two minutes

1. Open the demo store at `/shop` (Northwind Outfitters, 9 products read live from Supabase).
2. Talk to the shopper agent at `/chat`: ask for a product the way a customer would, and watch the agent restate the request, offer options, and place the order. Each "Muse is checking" step appears as it happens, and the confirmation shows the order number so a tester can find the order in the dashboard. Type anything that is not about shopping and the chat offers two ready-made orders instead: one that passes and one that is held for review.
3. Or call the public agent API directly: register an agent, open a session, record a grant, and place an order.
4. Sign in to the merchant dashboard with the pre-filled demo sign-in (Northwind Outfitters). A guided tour walks through each tool.
5. On the Dashboard home, the Agent Activity map shows each agent session at its pipeline stage, with bot icons and verdict badges.
6. Open Agent Receipt: every agentic order carries a decision (Pass, Review required, or Hold for suspicion) and a hash-sealed receipt showing exactly what was granted and whether the action matched it.
7. Open Agent Optimize: the five-factor listing alerts on the left, and on the right press Read as Agent Scan to see what a blind shopping agent gets wrong about each listing.
8. Open Agent Dispute: see the evidence packet for a disputed agent order, built for its processor.

## What it does

### 1. Know the agent did what the shopper wanted: Agent Receipt (flagship)

Today's protocols only verify that the user authorized payment. Agent Receipt records the full chain and checks it:

- Every agentic transaction is stored as a SHA-256 hash-chained receipt, with intent, authorization, and action kept separate.
- Only the confirmed grant excerpt, exactly as the customer stated it, is hash-sealed and shown to the merchant. The full customer chat stays private.
- A field the grant never mentions is recorded as unspecified, never as false.
- Merchants get a clear record of what was granted and whether the action matched it.
- Major mismatches are flagged Review required or Hold for suspicion before they become returns or chargebacks.
- Merchant listing details and policies are recorded at scan time, preventing disputes over what was shown at purchase.

### 2. Be found and understood by agents: Listing Optimizer plus Read as Agent

- **Listing Optimizer** reviews every listing detail against five pillars of agent listing optimization: (1) Feed Hygiene and Real-Time Accuracy, (2) Precision and Explicit Attributes, (3) Machine-Readable Schema (Schema.org), (4) Answer Engine Optimization (AEO), (5) Multi-Point Trust and Verification. It suggests merchant-approved fixes and never auto-edits a listing.
- **Read as Agent (Agent Read-Test)** reads the displayed listing the way an agent would: Muse Spark answers four fixed questions from the displayed listing only, blind to the formal terms, and code compares the answers to those terms. Results are Match, Mismatch, or Agent answer not stated. It is the fifth product call inside Listing Optimizer.
- **Two sections on the Agent Optimize page.** Left: the five-factor alerts, grouped by factor, with one Mark all as done button (an alert that still needs a merchant value stays open, outlined in red). Right: the Read as Agent alerts, shown after Read as Agent Scan, with Mark all as done and Clear all (cleared alerts stay cleared until the next scan).
- **Scans in seconds.** A Spark reading depends only on the listing's own text, so each scan stores it and the next scan reuses it for every unchanged listing; an edited listing is always read fresh. The blind read-test never feeds a flag, so it finishes in the background and fills in on the page. A scan with nothing changed makes no Spark call and replies in about 2 seconds.
- **Multilingual Returns Comparison** compares Spanish or Hindi returns summaries to the English formal terms by meaning. Unspecified stays unspecified. Cannot determine appears only for no-returns-information or model fallback, and is not counted as a problem by itself.

### 3. Win disputes without the scramble: Evidence Packet

Agent-involved orders add a middle party, and no tool built for them assembles the evidence. Evidence Packet:

- Reviews a dispute and automatically identifies agentic orders by checking the order against the agent orders database.
- Builds an evidence packet customized to the processor (Visa, Mastercard, and others).
- Highlights any merchant-specific information the receipt cannot supply, so the merchant fills only what is missing.
- When the merchant connects a Shopify store and grants disputes permission, dispute information auto-populates from the dispute notice and the pack auto-builds. The manual record-a-dispute form is the fallback for stores not yet connected.
- Deliberately contains no fight-or-concede recommendation, no classifier, and no win-probability score: with no outcome data yet, that would be a guess dressed as advice.
- Sample data is marked honestly: a legend at the top plus blue for real record data and orange for sample data, with section-level marking where sample fields cluster. Sample values are never presented as filed.

### 4. See agent activity: Agent Activity map

The Dashboard home includes a live store map of agent activity (full page at `/dashboard/activity`):

- Each bot icon is a real agent session, placed by its pipeline stage: session opened (browse aisles), grant recorded (product displays), proposal presented (cart area), order placed or verdict issued (checkout line).
- The storefront artwork is a Muse Image asset generated once at build time, with zone labels as HTML overlays.
- A side panel lists every session with its agent, stage, order, verdict badge, and last update. Clicking a row opens that order's inline check in Agent Receipt.
- The map refreshes every 20 seconds and an icon moves only when a stored record changes.
- Scoping is honest: activity queries are filtered to the demo merchant (Northwind Outfitters) in the query itself. There are no row-level security policies restricting these tables per merchant, and the submission does not claim otherwise.
- The map shows pipeline stage, not live browsing. The public API records only agent registration, session opening, grant, and order action. There are no browsing, page-view, or cart events anywhere in the API or data model.

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
- **Not claimed:** AP2, the Universal Commerce Protocol, and the Personal Agent Protocol. Those protocols authorize payment within constraints, handle checkout interoperability, and authenticate the agent. None of them checks what the agent actually ordered against the grant and the formal terms. That check is Agent Proceed's product.

## How it works

**One app, one deployment.** React 18, React Router 7, Vite, TypeScript, Tailwind CSS 4, deployed on Vercel.

| Route | What it is | Theme |
|---|---|---|
| `/` | Public website: the problem, the four tools, how it works, FAQ and pilot sign-up. `/products` and `/hackathon` give the product details and the judge's walkthrough | Light |
| `/chat` | Customer phone: the shopper talks to the shopper agent | Light, neutral |
| `/shop` | Northwind Outfitters demo store, as a shopper or an agent sees it. 9 products read live from Supabase | Light retail |
| `/dashboard` | Merchant dashboard: demo sign-in, then Dashboard (with the Agent Activity map), Agent Receipt, Agent Dispute, Agent Optimize, and a guided tour | Dark |

**Backend.** Supabase (Postgres, Storage, edge functions). Edge functions: `shopper-agent` (Muse Spark tool-calling loop behind `/chat`), `auditor` (checks each order and writes its hash-chained receipt), `order-status` (read-only: session in, order number out), `api` (the public agent API), `optimizer`, `disputes`. Migrations live in `supabase/` in order (schema, products, storage bucket, read policies, sessions, agent API keys, optimizer, dispute agent, demo seed).

**Public agent API.** `POST /agents/register`, `POST /sessions`, `POST /grants`, `POST /actions`. Demo API keys are hashed. Dashboard access is read-only; writes stay blocked.

**Hash chain and tamper check.** Receipts are SHA-256 hash-chained. Each dispute's evidence package runs the tamper check on that order's own chain records (`verifyOrderChain`) before the package is shown. A verified chain shows "Receipt chain verified, tamper check passed" with the receipt hash. A failed chain says so plainly, names the failing link, and marks the record untrusted. There is no separate Tamper page; the check is a gate inside the evidence pack.

**Shopper chat speed.** The agent hands back matching products when it records the customer's rules, so a first reply is usually two Spark calls; the phone streams each step as it happens; the order reply does not wait for the auditor, which runs in the background; and a chat with nothing about shopping gets a fixed reply with no Spark call at all.

**Decisions.** Every audited order ends in exactly one of three decisions: Pass, Review required, or Hold for suspicion. Orders requiring attention are the Review required plus Hold for suspicion set.

**Separation rules, enforced by tests.** The shop and the dashboard never import each other; anything both need goes through `shared`. Shop source never mentions dashboard, grant, receipt, tamper, or dispute, and uses no dashboard colors. No Lovable code and no external repo links in app source.

**Tests.** Automated suite with Vitest (`npm test`), covering the auditor, the optimizer, the dispute packs, the activity positions, and the separation rules. Build is typechecked (`tsc --noEmit && vite build`).

## What is real, and what is demo

- Checkout is simulated. No real payments move.
- The shopper agent loop and grant extraction are a demo simulation. The verification layer (receipts, optimizer, read-test, dispute packs, activity map) reads real stored records.
- Map traffic is simulated agent traffic for the demo merchant only, labeled as such on the page.
- The off-topic check in `/chat` is a fixed word list, not a model: a message with no shopping, ski or snowboard words gets the demo-orders reply.
- Sample dispute fields are marked orange and labeled as sample; real record fields are blue.
- Store health and profit figures on the dashboard are demo values and are labeled Demo. The attention count and the orders list are live from Agent Receipt.
- Product photos are real retailer photos, not AI generations.

## Run it locally

```bash
npm install
npm run dev      # Vite dev server
npm run build    # tsc --noEmit && vite build
npm run test     # vitest run
```

Supabase setup follows the migrations in `supabase/` in order. Edge functions need `MODEL_API_KEY` in Supabase Edge Functions Secrets (the Meta Model API key). The optimizer also needs `STORE_PAGE_URL` (the shop page whose served HTML is checked for Schema.org markup). If `MODEL_API_KEY` is missing, the shopper agent answers that it is not set.

## Why this matters

Merchants do not hold back from agentic commerce because they doubt agents. They hold back because every agent order is a small gamble: did it buy the right variant, at the right price, under the right returns terms, and can the merchant prove it when the dispute arrives? Agent Proceed turns that gamble into a record. Discoverable listings bring agent traffic in. Verified receipts keep that traffic profitable. Evidence packets keep it defensible. The result is adoption merchants can say yes to: discoverable by agents, protected from intent mismatches, and prepared for disputes.

## Judging criteria

- **Impact (30%):** a real adoption blocker for every merchant facing agentic commerce, solved with a working product, not a concept.
- **Use of Meta AI Tooling (25%):** Muse Spark in five distinct product calls where the model reads and code decides, plus Muse Image as a build-time asset. Creative use beyond a basic integration: blind read-testing, multilingual comparison by meaning, and a pipeline-stage activity map.
- **Demo (25%):** a working live demo with a two-minute path from shopper chat to flagged mismatch, plus a demo video.
- **Technical Depth and Execution (20%):** hash-chained receipts with a tamper gate, a strict separation architecture enforced by tests, honest scoping (query-level merchant filtering, no invented RLS), and a demo-versus-product line held throughout.

# Amendment 10: PayPal Sandbox checkout (Nov 9, 2026)

Approved by Sneha. Builds the PayPal step planned in Amendment 4, for the PayPal AI Hackathon.

- **Scope:** PayPal only, in PayPal Sandbox (test money). Every other payment method stays simulated and is labeled so.
- **Flow:** the customer names PayPal, `place_order` records the order as `payment_rail: paypal_sandbox`, `payment_simulated: false`, `payment_status: awaiting_approval`. The phone shows Pay with PayPal. The server creates a PayPal Orders v2 order (intent CAPTURE) for the total on the checkout action, returns the approval link, and the shopper approves on PayPal. PayPal sends the shopper back to `/chat?paypal=return`, and the server captures that order.
- **Server only:** `paypal.ts` makes plain REST calls (OAuth client credentials, create, capture) to `https://api-m.sandbox.paypal.com`, fixed. No PayPal JS SDK, no MCP server. `PAYPAL_CLIENT_ID` and `PAYPAL_SECRET` exist only as Supabase edge-function secrets. `SITE_URL` (optional) sets the return address; it is never taken from the request.
- **One endpoint:** the phone still calls only `shopper-agent`, with actions `paypal_start`, `paypal_capture` and `paypal_cancel`. The phone never sends an amount; any amount it sends is ignored.
- **Guards:** the capture must be for the PayPal order this session created. The same session always sends the same `PayPal-Request-Id`, so repeat taps return the same PayPal order, and a capture is never made twice. Only an https paypal.com approval link is passed to the phone.
- **Record:** migration 015 adds `payment_events`, chained and append-only, one row per PayPal result (`order_created`, `captured`, `capture_failed`, `cancelled`) with the PayPal order id and capture id. `chain_entries` and `demo_reset()` include it. Browser access is read-only.
- **Honesty:** a capture never changes the order record or its decision; a mismatched order stays Review Required when paid. A pending, failed or cancelled payment is never shown as paid. A captured amount that differs from the recorded total is noted on the payment record. Wording: "PayPal Sandbox (test money)", never "real payment".
- **Dashboard:** Agent Receipt's inline check shows the order's PayPal Sandbox record (order id, transaction id, amount, each entry's hash).
- **Not built:** PayPal dispute packs (`PROCESSORS` in `disputes/pack.ts` is still Visa and Mastercard), refunds, webhooks, live PayPal.
- **Setup:** run `015_paypal_sandbox.sql`, set the two secrets, redeploy `shopper-agent`. Without both secrets, PayPal orders behave exactly as before.

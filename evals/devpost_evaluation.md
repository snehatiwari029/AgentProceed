## Evaluation

We ran 15 labeled agent orders, built from the Northwind Outfitters catalog, through the unchanged verifying agent and compared each verdict (Pass, Review Required or Hold for Suspicion) with its label. The baseline is no verification: every order ships.

| Metric | Agent Proceed | Baseline | What it means for a merchant |
|---|---|---|---|
| Miss rate | 0.0% | 100.0% | Bad orders that got Pass and would ship |
| Chargebacks prevented | 100.0% | 0.0% | Bad orders caught before shipping |
| False-hold rate | 0.0% | 0.0% | Good orders held by mistake |
| Accuracy | 80.0% | 33.3% | Verdicts that exactly match the label |
| Receipt integrity | 93.3% | no receipt | Receipts whose hash chain verifies |

Three of the four Hold for Suspicion cases came back Review Required: still stopped before shipping, but at a lower severity. The one receipt that failed verification belongs to a case we tampered with on purpose, and the agent correctly held it.

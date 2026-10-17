# ADR-0003: Transactions with explicit account effects, not a double-entry journal (DEC-01)

- Status: Accepted
- Date: 2026-10-16
- Story: MYL-004
- Spec: §5, §5.4, §15.3, Appendix A (INV-01–INV-24), DEC-01, DEC-14

## Context

Every financial collection, report and invariant depends on how a money movement is modelled. The model must be frozen before production financial data is stored (§15.3). It has to keep cash movement separate from income, expense, transfer and allocation (CON-08). It must also satisfy the invariant catalogue, for example: a transfer has exactly two effects (INV-02), opening balances are not income (INV-06), and loan proceeds are not income (INV-07).

## Options

| Option | For | Against |
|---|---|---|
| **A. Conventional transactions with explicit account effects** | Simple to build and explain for a manual-first first release. One document per user action. Maps directly onto screens and the offline outbox. | The invariants must be enforced in domain code and tests, not by the data structure itself. |
| B. Double-entry journal and entries | Debits equal credits by construction. Immutability comes naturally. | Much more modelling up front, such as equity, income and expense ledgers for every workspace. Harder offline merges. Heavier for the first release team. |
| C. Single-amount transactions (no effects) | Simplest of all. | Cannot express transfers, loans or investments without breaking INV-02, INV-07 and INV-10. Rejected. |

## Decision

**Option A.** Each `transactions` document is one financial event with:

- `type`, which says what the event is: `income`, `expense`, `transfer`, `opening_balance`, `balance_adjustment`, `refund`, `loan_proceeds`, `loan_repayment`, `savings_allocation`, `investment_buy` or `investment_sell`. Reporting classification comes from the type, never from the sign alone.
- `effects`, an embedded array of `{ accountId, amountMinor, currency }`. `amountMinor` is signed: positive increases the account and negative decreases it. The array is bounded: one effect for most types and exactly two for a transfer (INV-02). A transfer that converts currency carries both currencies and records its rate (§5.3).
- An API `amount` that is always **positive** (§15.4). The direction comes from `type`, and the server derives the signed effects. Signed and unsigned conventions are never mixed in the API.
- `status`: `posted`, `pending` or `voided`. Only `posted` effects count toward balances (§5.3). Pending is never double-counted (INV-21).
- `version`, a number that increments on every change. It drives optimistic concurrency (ADR-0006).

**Balances.** Calculated balance = opening balance + the sum of posted effects. Each account keeps a cached `balanceMinor`, updated in the same MongoDB transaction as the transaction document (ADR-0002). A job can always recompute it from the effects, and the two must match (INV-24).

**Edits and deletes (§5.4).** A posted transaction is never removed. An edit writes a new version and an audit entry. "Delete" means **void**: status becomes `voided`, its effects stop counting, and the document and its audit trail stay. Permanent removal happens only through account or workspace deletion under DEC-06.

## Consequences

- Each invariant in Appendix A needs a domain check and a test. That is how this model buys its simplicity, and it belongs in the definition of done for every story that touches money.
- Effects are already journal-shaped lines `(account, signed amount, currency)`. Moving to double-entry later (DEC-14) means adding balancing ledger lines, not reshaping history.
- Reports read effects plus `type`, so a transfer appears in neither income nor expense (INV-03).
- Voiding instead of deleting keeps synced history explainable. The cost is storage and filtering on `status` in every query.

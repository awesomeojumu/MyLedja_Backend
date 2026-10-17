# ADR-0008: Four transaction statuses (supersedes ADR-0003 status list)

- Status: Accepted
- Date: 2026-10-17
- Spec: §5.2, F-004
- Supersedes: ADR-0003 status field only (`posted` / `pending` / `voided`)

## Decision

Ledger `status` is `pending | posted | reversed | voided`. Only `posted` counts toward balances. `reversed` and `voided` stay on the same document; effects are unwound. Refund is a new `refund` type, not `status=reversed`.

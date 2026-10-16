# Architecture decision records

| ADR | Decision | Spec ID |
|---|---|---|
| [0001](0001-money-storage-integer-minor-units.md) | Money as int64 minor units with a currency | DEC-02 |
| [0002](0002-mongodb-official-driver.md) | Official MongoDB driver; `runInTransaction` pattern | DEC-12 |
| [0003](0003-financial-model-account-effects.md) | Transactions with explicit account effects; void instead of delete | DEC-01 |
| [0004](0004-authentication-and-recovery.md) | Email and password, rotating refresh tokens, neutral recovery | DEC-03 |
| [0005](0005-workspace-roles.md) | Owner / Admin / Editor / Viewer, server-enforced | DEC-04 |
| [0006](0006-offline-mutation-contract.md) | Offline matrix, outbox, idempotency, version conflicts | DEC-05 |

Each ADR records its context, options, decision, consequences and date. To change a decision, write a new ADR that supersedes the old one; don't edit an accepted ADR's decision.

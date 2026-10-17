# Criteria report

Re-score after each workstream. Pass = done test green.

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | Mono sandbox + KYB + 6-bank history | Fail (human) | Tracker in `docs/external-dependencies.md`. No application IDs yet. |
| A2 | Stitch scrape / Okra out | Pass | `docs/stitch-nigeria-method.md` |
| A3 | Counsel CBN / NIBSS / NDPA / GAID | Fail (human) | Brief exists; send date not logged. |
| A4 | Each application dated | Pass | `docs/external-dependencies.md` |
| B1 | Institution + connectionType | Pass | `ledger.spec` unknown institution → 400 |
| B2 | INV-06 opening not income | Pass | `ledger.spec` opening + expense |
| B3 | Encrypt + mask | Pass | `ledger.spec` no plaintext number |
| B4 | Archive, never hard-delete | Pass | `ledger.spec` + DELETE archives |
| C1 | TC-02 transfer | Pass | `ledger.spec` totals unchanged |
| C2 | TC-01 expense | Pass | `ledger.spec` |
| C3 | TC-11 operationId | Pass | `ledger.spec` one doc |
| C4 | Four statuses | Pass | ADR-0008 + `ledger.spec` |
| D1 | Category-type mismatch | Pass | 422 + `draftIssues` |
| D2 | Rule preview exact ids | Pass | `ledger.spec` |
| D3 | Merchant aliases | Pass | `aliases.spec` |
| E1 | TC-10 airplane + kill + one sync | Pass (Node file) | `src/sync/outbox.test.ts` file outbox survives reopen |
| E2 | Pending-sync badge until ack | Pass | `pendingBadge` + SyncQueue binds to outbox |
| E3 | One DB file per user | Pass (path rule) | `myledja-<userId>.db` / `.outbox.json`; cross-user rejected |
| F1 | Wizard 5 steps, skippable | Pass | skip-all creates nothing; do-all writes one expense |
| F2 | Checklist resumes | Pass | `setup-progress.test.ts` + GET workspace progress |
| F3 | Install-to-first-expense journey | Pass | `setup-journey.test.ts` |

**Score: 18/21 pass.** A1 and A3 stay Fail until a human submits Mono/KYB and emails counsel. E3 is the per-user file contract, not Expo SQLite on device.

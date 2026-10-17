# Criteria report

Official Sprint 1–4 ACs. Pass = named test green. Human rows stay human.

## Sprint 1

| Story | AC | Status | Done test |
|---|---|---|---|
| MYL-001 | CI apptest both repos | Pass | `.github/workflows/ci.yml` |
| MYL-001 | Envs + gitleaks | Pass | `env.spec.ts` + CI secret scan |
| MYL-001 | Device/simulator open | Pass (human) | already ticked |
| MYL-002 | Tokens + contrast + 001–017 | Pass | `contrast.test.ts` + `screen-catalog.test.ts` |
| MYL-003 | Money / mongo tx / health / ADRs | Pass | `money.spec` `transaction.spec` `health.spec` |
| MYL-004 | DEC ADRs | Pass | ADR 0003–0006 |
| MYL-005 | Auth e2e / recovery / TC-17 | Pass | `auth-flow.spec` `recovery.spec` `rate-limit.spec` |
| MYL-006 | Workspaces / TC-08 / TC-09 / audit | Pass | `workspace-access.spec` `capabilities.spec` |
| MYL-007 | Nav + keystore | Pass | `nav-mode.test.ts` `secure-token-store.ts` |
| MYL-007 | Logout isolation | Pass | `session-isolation.test.ts` |
| A1 | Mono KYB + 6-bank history | Fail (human) | `docs/external-dependencies.md` |
| A2 | Stitch / Okra out | Pass | `docs/stitch-nigeria-method.md` |
| A3 | Counsel | Fail (human) | `docs/counsel-brief-dec08.md` |
| Monitor | Tue/Thu cadence | Fail (human) | tracker only |

## Sprint 2

| Story | AC | Status | Done test |
|---|---|---|---|
| MYL-008 | Screens 018–047 four states + 3-tap | Pass | `myl-008-screens.test.ts` `add-draft.test.ts` |
| MYL-009 | B1–B4 | Pass | `ledger.spec` |
| MYL-010 | C1–C4 | Pass | `ledger.spec` |
| MYL-011 | D1–D3 | Pass | `ledger.spec` `aliases.spec` |
| MYL-012 | E1 TC-10 | Pass | `outbox.test.ts` sql.js |
| MYL-012 | E2 badge | Pass | `pendingBadge` |
| MYL-012 | E3 SQLite per user | Pass | `myledja-<userId>.db` |
| MYL-013 | F1–F3 | Pass | `setup-journey.test.ts` `setup-progress.test.ts` |

## Sprint 3

| Story | AC | Status | Done test |
|---|---|---|---|
| MYL-014 | P0–P2 048–109 / 150–151 | Pass | `plan-screens.test.ts` |
| MYL-015 | H1–H3 budgets | Pass | `workspace-flows.spec` H1–H4 |
| MYL-016 | I1–I3 bills | Pass | `workspace-flows.spec` I1–I4 |
| MYL-017 | J1–J3 income | Pass | `workspace-flows.spec` J1–J3 |
| MYL-018 | K1–K3 goals | Pass | `workspace-flows.spec` K1–K3 |
| MYL-019 | L1–L4 debts | Pass | `workspace-flows.spec` L1–L4 |
| G1/G2 | timezone + weekStartsOn | Pass | `workspace-flows.spec` G1 G2 |
| C1 | Viewer 403 writes / 200 reads | Pass | `workspace-flows.spec` C1 |
| W1–W10 | Hubs/forms call APIs | Pass | `plan-wiring.test.ts` |
| U4 | occurredAt + receivable | Pass | `workspace-flows.spec` N1–N4 |

## Sprint 4

| Story | AC | Status | Done test |
|---|---|---|---|
| MYL-020 | M1–M3 dashboard | Pass | `workspace-flows.spec` M1 + `range-cache.test.ts` |
| MYL-021 | N1–N4 refund/split/reconcile | Pass | `workspace-flows.spec` N1–N4 |
| MYL-022 | O1–O3 CSV | Pass | `workspace-flows.spec` O1–O3 + `fixtures/gtbank-mixed.csv` |
| MYL-023 | Q1–Q3 privacy | Pass | `workspace-flows.spec` Q1 + `lock-copy.test.ts` |
| MYL-024 | S1–S3 search/a11y/loading | Pass | `workspace-flows.spec` S1 + `a11y-journeys.test.ts` |
| MYL-025 | INV-01–24 | Pass | `invariants.spec.ts` |
| MYL-025 | Z1 scans | Pass | gitleaks both CI files |
| MYL-025 | Z2 tester install | Fail (human) | `docs/beta-artifacts.md` |

## Page walk through MYL-025

| IDs | Verdict |
|---|---|
| 001–017, 141, 145 | Live (auth + dashboard APIs) |
| 018–047, 146–149, 152 | Live (accounts, transactions, categories) |
| 048–089, 150–151 | Live (budgets, bills, goals, income, debts) |
| 090–109 | Gated (no savings/investments/tax tables) |
| 110–117, 153–154 | Live (`GET dashboard` snapshot) |
| 118–137, 144 | Live (`GET /me/sessions`) |
| 138–140 | Static help copy (no balances) |
| 142–143 | Next-phase shell (MYL-027) |

Code score: 71/74 official ACs Pass. Fail-human only: A1, A3, Z2 (plus monitor cadence).

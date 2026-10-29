# Handoff for the next agent (29 Oct 2026, updated after Phase 5)

Both repos: branch `claude/app-study-o8lpl5`. Build documents (DESIGN.md, TECH-SPEC.md, BUILD-PLAN.md) are not in either repo; ask the owner for them. Check out the backend at `../MyLedja_Backend` so `npm run api:sync` and `cases:check` work.

## Done

**Phase 1 to 2 fixes (frontend):** lint and typecheck green; `matchBillToEvent` duplicate and sign bug fixed; Welcome tablet crash (`height`); conditional hooks in the income routing row; "save by" budget template used the amount as a month; sheets reset on open instead of on every refresh; `toInputText` (src/money) replaces float money text.

**Phase 2 join to the real API:**

- Backend: a sync operation may carry `transactionIds` (device-made ids, posting order; a correction is reversal then new). `LedgerService.withClientIds` applies them. Transaction lines carry `system` (system-account key).
- Frontend: `src/data/sync/serverRecords.ts` translates server records into local records and Phase 2 records into API bodies. `repository.put(..., remote)` attaches the exact API operation; `remote: null` and the `LOCAL_ONLY` set keep bookkeeping writes on the device. Category groups resolve to names in `load()`.

**Phase 3 trust:**

- Backend `src/modules/security`: TOTP two-factor, backup codes, a second sign-in step, passkeys, sessions, `recheck` (error `recheck_needed`), change password, activity log and security notices.
- Backend `src/modules/exports`: CSV export, backup file, restore preview, restore into a new workspace, account deletion job, nightly encrypted backup. `src/modules/files/cloudinary.ts` is a signed Cloudinary client.
- Frontend: sign-in two-factor step and passkey (web only); `SecuritySheets.tsx` (`useRecheck`); Security, Devices, Workspace activity and Import/export tabs; `src/features/lock/AppLock.tsx`; sign-out clears the local store; `eas.json`. Bundle id `com.planexi.myledja` is a guess: confirm with the owner.

**Phase 4:** backend `src/modules/ai` (Claude then Gemini, consent, redaction), statement parsers (PDF, Excel), `src/modules/rules`, `src/modules/banking` (Mono). Frontend: PDF/XLSX import with AI consent, AI features and Bank connections tabs, rules applied in the app. New optional env vars: `GOOGLE_GEMINI_PAID_PLAN`, `MONO_WEBHOOK_SECRET`.

**Phase 5 (Release 3), backend:**

- `src/modules/ledger/investments.ts`: units as millionths, lots rebuilt from events (lot id = buy event id), FIFO `pickLots`, `position`. Event types `investment_buy` (E20), `investment_sell` (E21); a `dividend` input posts as `income` (E22). A holding is an asset ledger account (`holdingOf` its investment account); it never counts as cash.
- `src/modules/investments`: portfolio, holdings, prices. `src/modules/currencies`: exchange rates (`Decimal128`, latest rate on or before the date, "Partial" without one). Net worth converts currencies and counts holdings at market value.
- `src/modules/reports`: the engine (`engine.ts`: a table is the chart's data), Health (`health.ts`), formulas (`formula.ts`), cash flow bands by event type, report dashboards and saved reports (stored, synced), `GET /health/:month`, `PUT /health-settings`.
- Ledger cases 15, 16, 17 and 25 added to `test/fixtures/ledger-cases.json` (both repos, same hash). Migrations `0014` and `0015`. Sync ops for holdings, prices, exchange rates, dashboards and saved reports.

**Phase 5, frontend:**

- `src/ledger`: investments, rates, the report engine, Health and formulas, kept the same as the backend's copies.
- Data: holdings, prices, rates, dashboards and saved reports in the snapshot and sync (`serverRecords.ts`, `mapOperation.ts`).
- F5.1 Investments and Holding pages, an account's Holdings tab, currencies on accounts. F5.2 Reports (dashboards, Add report gallery, Edit layout with one highlight), Report (filters, sortable table with totals, CSV, drill-down to Transactions) and Report builder. F5.3 Cash flow (Sankey, top to bottom on phones, simple view, tiles, group table). F5.4 Health (score, five tiles with explainers, advice, stress test, history, settings, share). F5.5 Dashboard Health and Investments cards; Settings › Currencies saves synced rates.
- Reports, Cash flow and Health run on the device's data, so they work offline (`src/features/reports/runner.ts`).

## State of checks (run after Phase 5)

- Frontend `npm run check`: lint, typecheck, 2,663 tests, web build, cases and API checks all pass.
- Backend: lint, typecheck, 180 unit tests and the OpenAPI and cases checks pass here. Integration and e2e tests need MongoDB binaries that this container can't download; they run in CI. The backend Phase 5 work was merged into `dev` as PR #8.

## Open decisions for the owner

1. Restore makes a new workspace (TECH-SPEC 11) while DESIGN says it replaces; the app has no workspace switcher yet.
2. Passkeys and Mono on phones need native modules; hidden on phones.
3. Bank parsers were written without real statements (and Premium Trust and Bank78 have none: Q-B34).
4. Phase 5: backend Q-B33 and frontend Q-20. The main ones: who creates the starting report dashboards, whether to hide "Download daily rates", syncing workspace settings (Health settings), and approving packages for share-as-image, a slider and haptics.

## Not done

- Device work from Phases 3 to 5: screen reader pass, performance on the reference phone, store builds, passkeys and Mono on phones, landscape for Report and Cash flow on phones, haptics.
- Phase 5 gaps: the Net worth report has no separate "Exchange-rate change" line (TECH-SPEC 6.13 decision 3); report cards can't be dragged or resized by their corner on web; no "Share as image"; tax summary report is "Later" in DESIGN.
- Existing: frontend `cases-check.mjs` looks for a lowercase sibling path (the backend's finds `../MyLedja_Frontend`); Phase 2 endpoints lack the six integration tests.

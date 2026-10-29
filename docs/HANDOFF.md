# Handoff for the next agent (29 Oct 2026, after Phase 5 and the page fix merges)

Both repos: work on `dev` (branch from it; never push to `main` or `staging`). Build documents (DESIGN.md, TECH-SPEC.md, BUILD-PLAN.md) are not in either repo; ask the owner for them. Check out the backend at `../MyLedja_Backend` so `npm run api:sync` and `cases:check` work.

## Where things stand

- Phases 1 to 5 are built in both repos, and the per-page fix branches (`cursor/fix-page-01` to `27`) are all merged into `dev`: 17 in the backend, 27 in the app.
- CI is green on `dev` in both repos (backend `ee4e5e0`, app `8a6fe85`), including the backend's MongoDB integration and e2e tests and the app's Playwright e2e and axe checks.

## Done, by phase

**Phases 1 to 2:** ledger, accounts, transactions, budget, plan, income, goals, debts, payees, sync. Sync operations may carry `transactionIds` (device-made ids, posting order). In the app, `src/data/sync/serverRecords.ts` translates server records and `repository.put(..., remote)` attaches the exact API operation; a write with no operation of its own and in the `LOCAL_ONLY` set stays on the device.

**Phase 3 trust:** two-factor, backup codes, passkeys (web only in the app), sessions, recheck (`recheck_needed`), activity log, security notices; exports, backup and restore (restore makes a new workspace), account deletion; app lock.

**Phase 4:** AI (Claude then Gemini, consent, redaction), PDF and Excel statement parsers, rules (synced, applied in the app too), Mono bank connections. Optional env vars: `GOOGLE_GEMINI_PAID_PLAN`, `MONO_WEBHOOK_SECRET`.

**Phase 5 (Release 3):**

- Ledger: `investment_buy` (E20) and `investment_sell` (E21); dividends post as `income` (E22). A holding is an asset ledger account inside an investment account; lots are rebuilt from events (lot id = buy event id), first in first out unless lots are chosen. Exchange rates use the latest rate on or before a date; without one a figure is "Partial". Net worth converts currencies and counts holdings at market value. Ledger cases 15, 16, 17 and 25 are in `test/fixtures/ledger-cases.json` (same hash in both repos).
- Backend modules: `investments`, `currencies`, `reports` (engine, cash flow, Health, report dashboards, saved reports).
- App pages: Investments and Holding (17, 18), Reports, Report and Report builder (19 to 21), Cash flow (22), Health (23), the Dashboard Health and Investments cards, and Settings › Currencies.

## How the page fix merges were joined (29 Oct)

The fix branches were written separately, so some overlapped. Where they did, both sides were kept unless they did the same thing, in which case the more complete one was kept. The decisions that matter later:

- **Report dashboards use the synced records** (`report_dashboards`, `saved_reports`, the owner's choice), not workspace settings. `src/features/reports/useDashboards.ts` is the one way in. The Reports page (19) runs cards on the device; the Report page (20) runs through `POST /reports/run`; the builder (21) previews on the device and saves to synced saved reports. `ShownResult` in `src/features/reports/helpers.ts` is what the chart, table, CSV and finding text accept from either.
- **Account and Debt pages can be embedded** (`AccountScreen({ embedded, accountId })`, `DebtScreen({ embeddedId })`): wider screens show the account beside the list at `/accounts?view=<id>` (DESIGN.md page 8).
- **Local push:** `src/features/notifications/localPush.ts` (bills reminders with lock-screen actions) and `LocalPushBridge` (taps) are the only push code; the app frame only sets the badge.
- **Sync clock:** `LocalStore.apply` takes the engine's time for `lastPulledAt`; it used the wall clock, so the 180-days-offline reset and its test depended on the time of day.
- **Fixes after merging:** Prettier and `openapi.json` in the backend; a missing `monthIncome` import, two lint errors, six strings against the copy rules, and three axe and e2e failures in the app (the line chart's scrub is pointer-only; "View as table" carries the numbers).

## State of checks

- App: lint, typecheck, 3,545 unit tests, web build, 18 Playwright tests (2 skipped), cases and API checks, audit.
- Backend: lint, typecheck, 182 unit tests, build, OpenAPI and cases checks in this container; the MongoDB integration and e2e suites run in CI. In a container without MongoDB binaries, an in-memory stand-in can run most of them (588 of 594 pass; the 6 that don't need real BSON types, rollback, job locking or validators).
- Playwright here needs `launchOptions.executablePath: '/opt/pw-browsers/chromium'`, because the project pins a newer Playwright than the installed browser.

## Open decisions for the owner

1. Restore makes a new workspace (TECH-SPEC 11) while DESIGN says it replaces; the app has no workspace switcher yet.
2. Passkeys and Mono on phones need native modules; hidden on phones.
3. Bank parsers were written without real statements; Premium Trust and Bank78 have none (backend Q-B34).
4. Phase 5: backend Q-B33 and app Q-20.

## Not done

- Device work: screen reader pass, performance on the reference phone, store builds and signing, landscape for Report and Cash flow on phones.
- Phase 5 gaps: no separate "Exchange-rate change" line in the Net worth report (TECH-SPEC 6.13 decision 3); report cards can't be dragged or corner-resized on web; the tax summary report is "Later" in DESIGN.
- Phase 2 endpoints lack the six integration tests.

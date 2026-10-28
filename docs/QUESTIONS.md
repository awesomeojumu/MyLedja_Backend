# Questions

Format and rules: build plan section 14. The owner asked for the best professional decision where the plan leaves room, so each entry below records a decision already built, with its option for change. Nothing here blocks work.

## Q-B1: Where do the backend pull requests go?

- Task: B0.12, build plan 0.5
- Raised by: backend agent
- Documents: build plan 0.5 (branches `phase-<n>/...` from `dev`, PRs into `dev`), 1.3 (separate `MyLedja_Backend` repo)
- Options: A, this repo's `backend` branch stands in for `MyLedja_Backend` and PRs target it. B, create `dev` and the separate repos.
- Recommendation: A, as the owner chose. Branches are named `cursor/<name>-e7ff` by the agent platform rather than `phase-<n>/...`; each PR title carries its phase and task ids. The frontend's `api:sync` reads `../MyLedja_Backend/openapi.json`, so check this branch out there as a worktree (`git worktree add ../MyLedja_Backend backend`).
- Answer: PRs target `backend` (owner, 28 Oct 2026).
- Status: answered

## Q-B2: The auth contract (answers the frontend's Q-3)

- Task: B0.7, B0.11, F0.7, F0.9
- Raised by: backend agent
- Documents: build plan 1.1, TECH-SPEC 5.3 and 8
- Options: A, keep the frontend's provisional paths and shapes in `src/api/auth.ts`. B, a new design.
- Recommendation: A, with additions, because they already follow TECH-SPEC. Published in `openapi.json`. What the app needs to change:
  - Every session answer has `accessTokenExpiresIn` (900). `refreshToken` is `null` when `staySignedIn` was true; the browser then holds it as an HttpOnly cookie on `/v1/auth/refresh`.
  - `sign-up`, `resend-code` and `recover` answer `202` with `{ codeExpiresInSeconds: 600, resendAfterSeconds: 45 }`, not an empty body.
  - `verify-email` takes optional `staySignedIn` and `deviceName`; `sign-in` takes optional `deviceName` and `googleLinkToken`.
  - `resend-code` takes an optional `purpose`: `sign_up` (default) or `recover`.
  - `sign-out` and `new-password` answer `204`.
  - New: `POST /v1/auth/google`, `POST /v1/auth/sign-out-others`, `GET /v1/workspaces/{workspaceId}`, `GET /v1/public-config`.
  - `SetupBody.openingBalance` and `monthlyTakeHome` are strings of **kobo** (TECH-SPEC 6.5), not naira. Accounts may carry a device-made `id`.
  - Headers: `X-Operation-Id` (a UUID) is required on every write except refresh; refresh requires `X-MyLedja-Client`. Both match the app's client today.
  - Errors are `{ code, message, field?, retryAfterSeconds? }`; `429` also sets `Retry-After`.
- Answer:
- Status: open

## Q-B3: Refresh opts out of operationId replay

- Task: B0.7, build plan 3.3 test 6
- Raised by: backend agent
- Documents: TECH-SPEC 5.3 (every change carries an operationId) and 10 (reusing an old refresh token ends every session)
- Options: A, refresh takes no operationId; sending the same refresh token twice is reuse and signs out every session. B, replay refresh answers, which would hand a second copy of live tokens to whoever replays.
- Recommendation: A. The "runs once" test for refresh checks reuse detection instead.
- Answer:
- Status: open

## Q-B4: What Welcome's accounts and categories do before the ledger exists

- Task: B0.9, F0.9 (P04-05, P04-06)
- Raised by: backend agent
- Documents: DESIGN.md page 4; build plan B1.1 (ledger accounts and categories) and B1.6 (accounts with E8) are Phase 1
- Options: A, Phase 0 keeps the accounts and categories sent in setup on the workspace, and Phase 1 posts them (a migration turns each into a ledger account and an E8 opening balance). B, refuse them until Phase 1.
- Recommendation: A, so the app sends setup once and nobody retypes it. No money is posted in Phase 0, so no figure can be wrong.
- Answer:
- Status: open

## Q-B5: How the app learns the Google client id (answers the frontend's Q-4)

- Task: B0.8, F0.9
- Raised by: backend agent
- Documents: TECH-SPEC 2.2 (three `EXPO_PUBLIC_` variables), 2.3 rules 3 and 4
- Options: A, a new optional `EXPO_PUBLIC_GOOGLE_CLIENT_ID`. B, `GET /v1/public-config` returns `google.clientId` from the existing `GOOGLE_CLIENT_ID`.
- Recommendation: B. No new variable, and the button hides itself when `google.enabled` is false. A client id isn't a secret. If prototype T0.2 needs separate iOS and Android ids, they become optional backend variables (2.3 rule 4).
- Answer:
- Status: open

## Q-B6: How long a session lasts

- Task: B0.7
- Raised by: backend agent
- Documents: DESIGN.md P01-04 (web "Stay signed in": up to 30 days, or 7 days without use); TECH-SPEC 10 (15-minute access token, rotating refresh)
- Options: phone and in-memory web sessions have no stated limit.
- Recommendation: web cookie sessions as DESIGN.md says (30 days, 7 idle). Phone sessions end after 90 days without use and have no fixed end, so people aren't signed out of a daily app. Web sessions without the tick keep the refresh token only in memory, so reloading the page ends them. The server can't tell a phone from a browser tab using a token, so every token session (phone or untick web) ends after 90 days without use.
- Answer:
- Status: open

## Q-B7: Sign-in for an email that hasn't been confirmed

- Task: B0.7
- Raised by: backend agent
- Documents: DESIGN.md pages 1 and 2 (silent)
- Options: A, the right password for an unconfirmed email answers `403 email_not_verified` ("Check your email for a code to finish creating your account") and sends a fresh code. B, treat it as wrong details.
- Recommendation: A. It only tells someone who knows the password, and it saves people stuck after closing the app mid sign-up. The app can show the code step.
- Answer:
- Status: open

## Q-B8: Advisories below "high" that are accepted for now

- Task: B0.12 (npm audit)
- Raised by: backend agent
- Documents: build plan 2.1 (versions at least two weeks old), 2.6 step 10
- Options: upgrade now against the two-week rule, or wait.
- Recommendation: `fastify` is pinned to 5.12.7 (with an override) to clear GHSA-389g-gv7q-r4x8. `nodemailer` 10.1.0 has moderate address-parsing advisories (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h), fixed only in 10.2.1, which is under two weeks old. Every address MyLedja sends to has passed a strict email check first, so the parser never sees a crafted group. Upgrade once 10.2.1 is two weeks old (4 Nov 2026).
- Answer:
- Status: open

## Q-B9: npm version for the lockfile

- Task: B0.1
- Raised by: backend agent
- Documents: build plan 2.1
- Options: npm 10 (bundled with Node 22) fails to build this dependency tree from scratch with an internal error, though `npm ci` works.
- Recommendation: the lockfile is written with npm 11 (`npx npm@11 install`). CI uses `npm ci`, which is unaffected.
- Answer:
- Status: open

## Q-B10: The web app and the API must share a site for the sign-in cookie

- Task: B0.7
- Raised by: backend agent
- Documents: TECH-SPEC 10 (refresh cookie HttpOnly, SameSite=Strict, path /v1/auth/refresh)
- Options: a browser only sends a SameSite=Strict cookie when the page and the API are on the same site. `myledja.vercel.app` and `myledja-api.onrender.com` are different sites, so "Stay signed in" won't survive a reload there. A, put both under one domain (for example `app.myledja.com` and `api.myledja.com`). B, loosen the cookie to SameSite=None (weaker CSRF protection; refresh already checks Origin and the `X-MyLedja-Client` header).
- Recommendation: A. Until a domain exists, staging web sessions behave like untick sessions. **Needs the user: which domain.**
- Answer:
- Status: open

## Q-B11: Collections added beyond TECH-SPEC 5

- Task: B0.3, B0.5, B0.10
- Raised by: backend agent
- Documents: TECH-SPEC 5, 6 (operationId replay)
- Options: none stated for where replayed answers, rate limits and migration records live.
- Recommendation: `idempotency` (replayed answers, encrypted, 24-hour TTL, keyed by caller and operationId), `rate_limits` (one document per limit key with a TTL), and `migrations` (applied migration names). `jobs`, `counters` and `rate_limits` use natural string keys as `_id` so claims are a single atomic write.
- Answer:

## Q-B12: Bank and wallet logos (answers the frontend's Q-8)

- Task: B1.6 (DESIGN.md page 4, P08-03)
- Raised by: frontend agent (Q-8)
- Documents: DESIGN.md pages 4 and 8; TECH-SPEC 5.8 (Cloudinary)
- Options: A, a list bundled in the app. B, served by the API with logos in Cloudinary.
- Recommendation: B. `GET /v1/institutions` (public, cached for a day) returns each bank or wallet's slug, name, kind, aliases and a public Cloudinary `logoUrl` (null until uploaded; show initials). Accounts store the slug in `institution`. Uses the existing `CLOUDINARY_*` variables; no new ones. The contract ships now; the endpoint is built with the accounts module (B1.6). Logo files come from the user later.
- Answer: B (user decision)
- Status: decided

## Q-B13: Ledger decisions where TECH-SPEC 6 leaves room

- Task: B1.1 to B1.5
- Raised by: backend agent
- Documents: TECH-SPEC 5.4, 5.7, 6.1 to 6.3, 6.11
- Options and recommendations (all in effect):
  - **System income and expense accounts as categories.** Interest and charges, Fees, Taxes, Interest earned, Investment income and Investment gain are system accounts; each gets a category linked to it, so people can pick them and they show in spending reports (case 6).
  - **Reversal date.** A reversal is dated like the original, so a correction takes the old amount out of the original's month (6.4).
  - **Change feed.** A reversed original is sent as an `upsert` with `status: "reversed"`, not a tombstone, because its history stays visible. Tombstones are for records that are really removed (categories, tags, payees).
  - **Deleting or correcting a purchase with live refunds** is refused ("Delete them first"), so refunds never point at a removed purchase.
  - **Pending events** aren't used in Phase 1; everything posts at once. They arrive with bank sync (Phase 4).
  - **One operationId per correction.** The new event takes the operationId sent; its reversal takes `<operationId>:reversal`. Sending the same correction again returns both.
  - **`ledger-cases.json`** lives in `test/fixtures/` with its sha256. The app copies both files byte for byte.
- Answer:
- Status: open

## Q-B14: Phase 1 API contract choices

- Task: B1.6 to B1.13
- Raised by: backend agent
- Documents: TECH-SPEC 5.3, 8, 9; DESIGN.md pages 5 to 11 and 24
- Options and recommendations (all in effect; the contract is in `openapi.json`):
  - **Device-made ids.** Every create takes an optional `id` (UUID v7), so the app can refer to records offline before they sync.
  - **Edits carry `baseVersion`.** An old one answers 409 `already_changed` with `current`.
  - **Uncategorized.** Every workspace gets an "Uncategorized" spending category and an "Other income" category (group "Other"), so imported or quick-added money always lands somewhere and can be sorted later.
  - **CSV upload** sends the text in the request body (up to 2 MB). The server keeps a private copy in Cloudinary when it's set up; without Cloudinary, imports still work and the file isn't kept. Excel, PDF and other formats come in Phase 4.
  - **Undo** for deleting a category, merging payees and importing uses an id returned by the action (`undoId`, `mergeId`, the import id). Deleting a transaction is undone by posting it again.
  - **Transfer matching** reverses the two one-sided transactions and posts one transfer, dated like the money out.
  - **Sync** operation types mirror the routes, and each payload is that route's body. Tombstones are kept for 180 days; a device further behind gets `reset: true`.
  - **Ticking in Reconcile** saves the cleared mark at once; Cancel keeps the ticks but locks nothing.
- Answer:
- Status: open

## Q-B15: Categories, tags and payees (B1.7)

- Task: B1.7
- Raised by: backend agent
- Context and decision:
  - **Defaults:** every new workspace gets an Income group (Other income, Interest earned, Investment income, Investment gain) and an Other group (Uncategorized, Interest and charges, Fees, Taxes). The built-in ones are linked to their system ledger accounts, and Uncategorized and Other income can't be deleted.
  - **No backfill:** migration `0003` adds only validators and indexes. No workspace predates this release, so no defaults need seeding into existing ones.
  - **Deleting a category** moves each live transaction as a correction (reversal plus a new event), keeping history. The moves run before the category is removed, so a failure part-way can simply be retried. Undo moves the same transactions back.
  - **Tags and payee merges** change only descriptive fields, so they update transactions in place (with a change-feed entry) and don't need corrections. Undoing a merge returns each transaction to its original payee.
  - **Welcome setup** makes its categories in the named groups, matched by starter key and then by name. A group named "Income" holds income categories.
  - **Currency:** default categories use the workspace currency at sign-up (NGN). Changing currency in Welcome before any money is recorded is handled with accounts (B1.6).
- Answer:
- Status: open

## Q-B16: Accounts and institutions (B1.6)

- Task: B1.6
- Raised by: backend agent
- Context and decision:
  - **Groups and kinds:** cards, loans and "other liability" are liabilities; everything else is an asset. Investments, property, pensions, fixed deposits and loans start off budget ("Tracking"); the person can switch them.
  - **Archiving with a balance:** if `moveBalanceTo` is given, the balance moves first as a transfer (paying off a card or loan when it's owed). Otherwise the account is archived as "closed with balance" and still counts in net worth.
  - **Update value (E10):** posts the difference to equity:Revaluation. If the value hasn't changed, nothing is posted.
  - **Net worth:** only accounts in the workspace currency count until exchange rates arrive; other currencies are listed under `partial`.
  - **Welcome:** setup creates each account (matched by id, then by name) and its opening balance, with the operation id `setup:<accountId>:opening`, so sending setup again posts nothing new. The currency can change only while no money is recorded (`409 currency_locked`).
  - **Institutions:** a starter list of 43 Nigerian banks, microfinance banks, wallets and savings apps, served from code. A logo URL is built from `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_FOLDER` once an entry is marked as having a logo; until then `logoUrl` is null.
- Answer:
- Status: open

## Q-B18: Reconcile (B1.13)

- Task: B1.13
- Raised by: backend agent
- Context and decision:
  - **One in progress** per account; starting again returns it. Unique partial index on `{ workspaceId, accountId }` where `status: in_progress`.
  - **Tick** updates `clearedAccountIds` at once and keeps `tickedIds` on the reconciliation.
  - **Finish at 0** locks ticked events with `reconciliationId`. **Finish with a difference** requires `adjust: true` and posts E9 for exactly `statement − cleared`; that adjustment is cleared and locked too.
  - **Cancel** leaves ticks cleared but locks nothing.
  - **Unlock** (transactions) clears the lock and appends to `unlocked[]` on the reconciliation.
- Answer:
- Status: open

## Q-B17: Transactions API (B1.8)

- Task: B1.8
- Raised by: backend agent
- Context and decision:
  - **Headline amount:** money out is negative, money in positive, a transfer its size. Filters `minAmount` / `maxAmount` use the absolute size of that headline.
  - **Live list:** `status=live` (default) hides reversals and replaced versions (`status=reversed`).
  - **Uncategorized filter:** transactions whose category is the workspace's Uncategorized or Other income starter.
  - **Transfer matching:** same absolute amount, different accounts, within 3 days; link reverses both and posts one transfer dated like the money out. Dismissals are stored in `transfer_dismissals` and never suggested again.
  - **Bulk categorize** saves each row as a correction. Bulk tag/payee changes patch in place; delete reverses.
  - **Unlock** clears `reconciliationId` and writes an audit entry. Recording the unlock on the reconciliation document lands with B1.13.
  - **Fix:** the contract interceptor now sets `req.operationId` from `X-Operation-Id` so HTTP writes reach the ledger with the real id (accounts had been posting openings as `undefined:opening`).
- Answer:
- Status: open

## Q-B19: Budgets (B1.9)

- Task: B1.9
- Raised by: backend agent
- Context and decision:
  - **Storage:** `budget_months` holds `{ workspaceId, month, categoryId, assignedMinor }` as bigint (same as `account_balances`), unique on `(workspaceId, month, categoryId)`. Id is `{categoryId}:{month}`.
  - **Formulas:** reads go through `ledger/read.budgetMonths` + `monthFigures` over `period_totals`. History starts at the earlier of the first assignment, the first period total, or the requested window, so envelope carry and overspend into `left_to_plan` stay correct.
  - **Assign `carryOver`:** optional flag updates the category document (tracking style). Envelope responses always report `carryOver: true`.
  - **Move / cover:** change assigned amounts; refused when the source can't cover.
  - **Templates:** Phase 2 (B2.7).
- Answer:
- Status: open

## Q-B20: Dashboard (B1.10)

- Task: B1.10
- Raised by: backend agent
- Context and decision:
  - **Tiles** (income, spent, net cash, budget left) come from `period_totals` via `monthFigures` and the budget month; transfers, loans, savings and investing never move Income or Spent.
  - **Income tile** is budgetable income only.
  - **getStarted** stubs: account / transaction / budget from real data; bill, income_stream and two_factor stay false until later phases; `hidden: false`.
  - Implemented on `BudgetService.dashboard` and a separate `DashboardController`.
- Answer:
- Status: open

## Q-B21: CSV import (B1.12)

- Task: B1.12
- Raised by: backend agent
- Context and decision:
  - **Phase 1 = CSV text in the body** (≤ 2 MB). Excel, PDF and AI reading stay Phase 4. The raw CSV is kept on the `imports` document so map/post can re-parse without Cloudinary.
  - **Cloudinary optional:** when `CLOUDINARY_*` is set, upload records `stored: true` after a no-op/stub store attempt; otherwise `stored: false`. Real private Cloudinary upload can replace the stub later without changing the contract.
  - **Suggest mapping:** reuse `account.importMapping` when present; otherwise guess from the header row (date / amount or money in+out / description).
  - **Duplicates:** same account, same signed amount, date within 3 days, similar description (lowercase, strip non-alnum, equality or includes). Marked `include: false` with `duplicateOf` = existing transaction id.
  - **Post:** only `include: true` and `error: null` rows, all-or-nothing via `ledger.postIn` in one Mongo transaction. Positive amount → income (Other income if no category); negative → expense (Uncategorized if no category). Each event gets `importId`. Mapping is saved on the account at map time.
  - **Undo:** `ledger.reverseIn` every posted row of this import only; status `undone`. Prior transactions are untouched.
  - **Broken rows** carry an `error` string and are never posted, even if the client ticks them.
- Answer:
- Status: open

## Q-B22: Sync push/pull (B1.11)

- Task: B1.11
- Raised by: backend agent
- Context and decision:
  - **No new migration:** `changes` (+ unique `{ workspaceId, seq }`) and `counters` already land in ledger migration `m0002`. Confirmed; SyncService only reads/writes through `ChangesRepository` / `CountersRepository`.
  - **Push** processes `operations[]` in order. Each op has its own `operationId`. Mapped onto existing module services (`transactions.*`, `accounts.*`, `categories.*` / payees / tags, `budget.assign`). One rejected op does not stop later ops.
  - **Statuses:** `applied` on success; `duplicate` when the same `operationId` (or device-made id) already produced a result; `conflict` on `already_changed` (409) with `current` from the error; other `AppError`s → `rejected`.
  - **schemaVersion:** accept `CURRENT_SCHEMA_VERSION` (1) and previous (0); anything else is `rejected`.
  - **Pull:** page `changes` after `since` (exclusive). `doc` is the matching GET-shaped view when `op=upsert` (null on load failure or tombstone). `reset: true` when `since > 0` and there is a gap before the oldest retained seq (tombstones kept 180 days / purged early rows) — client should re-download from `since=0`.
- Answer:
- Status: open

## Q-B23: Phase 2 API paths and tags (contract early)

- Task: Phase 2 contract PR
- Raised by: backend agent
- Documents: TECH-SPEC §8 (Plan, Goals, Debts); DESIGN pages 12–16
- Options: A, nest everything under `/schedules` and `/debts` only. B, split Plan (`/plan`, `/schedules`), Income (`/income`), Goals, Debts as implemented.
- Recommendation: B — matches DESIGN routes (`/plan`, `/income`, `/goals`, `/debts`) and keeps income-stream fields off generic schedule bodies. OpenAPI tags: Plan, Goals, Debts, Income. Money-back lives under Debts (`/debts/money-back-suggestions`). Sync `OPERATION_TYPES` lists Phase 2 writes; push rejects them until module PRs wire handlers (Q-B22 pattern).
- Answer:
- Status: open

## Q-B24: Phase 2 ledger events (E13–E17, E24)

- Task: Phase 2 ledger PR
- Raised by: backend agent
- Documents: TECH-SPEC 6.2, 6.14 cases 7–11, 18, 26–27
- Context and decision:
  - New `EventInput` types: `loan_proceeds`, `loan_repayment`, `lend`, `collect`, `write_off`, `salary_gross` (E24).
  - Person receivables use `ledger_accounts.personDebt: receivable` (payable later for borrow-from-person).
  - `ledger-cases.json` extended with cases 7–11, 18, 26, 27; sha256 updated.
  - Case 24 (pension rounding on ₦800,000.01) stays a money helper test — deferred to income module PR.
  - E18/E19 (goals) still no ledger event for same-account earmarks; goal spending adds `goalId` on expenses in a later PR.
- Answer:
- Status: open

## Q-B25: Schedules recurrence and occurrences (B2.1)

- Task: B2.1
- Raised by: backend agent
- Context and decision:
  - Occurrences materialized on read for a calendar month (`ensureMonth`), stored in `occurrences` with unique `{ scheduleId, date }`.
  - Month-end clamping in `recurrence.ts` (TECH-SPEC 6.4); unit tests for Feb 31 → 28 and last-day option.
  - Mark paid/received posts via `TransactionsService` or links `matchTransactionId`; second mark → `409 already_paid`.
  - Sync: `schedule.create` / `schedule.update` wired; change feed collections `schedules`, `occurrences`.
  - Find recurring: heuristic on expense payees (≥3 txns); v1 returns payee id as name until payee lookup added.
- Answer:
- Status: open

## Q-B26: People debts API (B2.5)

- Task: B2.5
- Raised by: backend agent
- Documents: TECH-SPEC 6.9, 6.14 cases 9–11; build plan B2.5
- Context and decision:
  - Each debt gets a dedicated person ledger account (`personDebt` receivable or payable); payee auto-created or matched by name.
  - **Lend** E15, **borrow from person** E13 via `loan_proceeds` on payable account (ledger builders accept `personDebt: payable`).
  - **Payments:** they owe me → E16 `collect`; I owe them → E14 `loan_repayment` with interest split (cases 8/10 pattern).
  - Default interest split: none → all principal; fixed/percent use TECH-SPEC 6.9 cap to outstanding.
  - **Write-off** E17 only for `they_owe_me`; **settle** when outstanding is zero.
  - Instalment metadata computed on read (`nextInstalmentDate` / `nextInstalmentAmount`); `setDebtInstalmentSchedule` stores plan only.
  - Money-back suggestions (`listMoneyBackSuggestions`, `confirmMoneyBack`) deferred to B2.6 PR (routes stay contract-only until then).
  - Sync: `debt.lend`, `debt.borrow`, `debt.payment`, `debt.write_off` wired; change feed collection `debts`.
- Answer:
- Status: open

## Q-B27: Money back suggestions (B2.6)

- Task: B2.6
- Raised by: backend agent
- Documents: TECH-SPEC 6.15; cases 26–27
- Context and decision:
  - Suggestions computed on read from open debts + payee match and/or instalment amount match.
  - `suggestionId` is a base64url JSON blob (debt, optional transaction, draft) — no server-side suggestion store in v1.
  - **money_back:** reverse mistaken income on linked transaction when needed, then `recordPayment` (E16).
  - **income:** post E1 from draft, or no-op when the transaction is already income (case 27).
- Answer:
- Status: open

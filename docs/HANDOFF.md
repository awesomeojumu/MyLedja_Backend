# Handoff for the next agent (28 Oct 2026, updated after Phase 4)

Both repos: branch `claude/app-study-o8lpl5`. Build documents (DESIGN.md, TECH-SPEC.md, BUILD-PLAN.md) are not in either repo; ask the owner for them. Check out the backend at `../MyLedja_Backend` so `npm run api:sync` and `cases:check` work.

## Done

**Phase 1 to 2 fixes (frontend):** lint and typecheck green; `matchBillToEvent` duplicate and sign bug fixed; Welcome tablet crash (`height`); conditional hooks in the income routing row; "save by" budget template used the amount as a month; sheets reset on open instead of on every refresh; `toInputText` (src/money) replaces float money text; Holdings tab removed until Phase 5.

**Phase 2 join to the real API:**

- Backend: a sync operation may carry `transactionIds` (device-made ids, posting order; a correction is reversal then new). `LedgerService.withClientIds` applies them. Transaction lines carry `system` (system-account key).
- Frontend: `src/data/sync/serverRecords.ts` translates server records into local records and Phase 2 records into API bodies. `repository.put(..., remote)` attaches the exact API operation; `remote: null` and the `LOCAL_ONLY` set keep bookkeeping writes on the device. Category groups resolve to names in `load()`.

**Phase 3 trust:**

- Backend `src/modules/security`: TOTP two-factor (QR via `qrcode`), backup codes, a second sign-in step (`TwoFactorRequired`, `POST /v1/auth/two-factor`, trusted device for 30 days), passkeys (`@simplewebauthn/server`), sessions list and sign-out of one, `recheck` (sensitive actions need a sign-in or recheck within 15 min, error `recheck_needed`), change password, activity log, and security notices ("Was this you?") on a new sign-in from a second device, two-factor off, passkey added and password changed.
- Backend `src/modules/exports`: CSV export, backup file (EJSON with checksum), restore preview, restore into a new workspace with new ids written to its change feed, account deletion job, nightly encrypted backup. `src/modules/files/cloudinary.ts` is a signed Cloudinary client.
- Frontend: sign-in two-factor step and passkey (web only); `src/features/settings/SecuritySheets.tsx` (`useRecheck` retries an action after "Confirm it's you"); Security, Devices, Workspace activity and Import/export tabs use the API; `src/features/lock/AppLock.tsx` (app lock, app-switcher cover, hide in recents, privacy default); sign-out clears the local store (`LocalStore.clearAll`); `eas.json` and app.json plugins. Bundle id `com.planexi.myledja` is a guess: confirm with the owner.

**Phase 4:**

- Backend `src/modules/ai`: Claude (`@anthropic-ai/sdk`, `claude-opus-5-5`, structured output, low effort) then Gemini fallback; per-workspace consent; redaction (`redact.ts`). Imports `statements/`: PDF (unpdf) and Excel (read-excel-file) parsers, bank detection, AI fallback. `src/modules/rules` (stored, synced via `rule.upsert`/`rule.delete`, applied to imported rows). `src/modules/banking` (Mono link, sync into import review, disconnect, webhook, daily job).
- Frontend: import sheet takes PDF/XLSX with an AI consent prompt; AI features and Bank connections tabs; Connect bank sheet (Mono widget on web only); rules sync.

**New optional env vars (TECH-SPEC 2.3 rule 4):** `GOOGLE_GEMINI_PAID_PLAN=true` (Gemini allowed in production), `MONO_WEBHOOK_SECRET` (webhooks refused until set).

**Phase 4 finish (acceptance gaps closed):**

- P08-08: Connect bank asks how far back to import (30, 90, 180 or 365 days; `historyDays` on the link).
- P26-13: Bank connections shows last sync and consent (expiry when Mono gives one), with Sync now, Reconnect (`/reauth`, then Mono with the reauth token, then `/reconnected`) and Disconnect.
- P15-07, P25-05: bank syncs create server imports with `source: 'bank'`. The Account page lists them ("N new bank transactions to review"), opens them in the normal import review (money-back prompts, duplicates, rules), then marks them `reviewed` (`GET /imports?status=mapped`, `POST /imports/:id/reviewed`). Account "Sync now" also syncs a connected bank.
- P25-05: the person's rules apply in the app too (`ruleChangeFor` in `src/features/rules/ruleEngine.ts`): import review suggests the rule's category, Add transaction prefills it, and saving applies rename-payee and add-note actions.
- P26-12: AI features shows the two Phase 4 switches; Health advice waits for Phase 5.
- The redaction test caught a real bug: the card-number pattern ate an account number and the amount after it. Fixed.

## State of checks (all run after the Phase 4 finish)

- Frontend `npm run check`: lint, typecheck, 2,117 tests, web build, cases and API checks all pass.
- Backend: lint, typecheck, 124 unit tests, build, OpenAPI check, cases check and audit pass. Integration and e2e tests (MongoDB binaries) can't run in this container; run them in CI.
- Phase 4 tests: `src/modules/ai/__tests__` (redaction on a realistic statement; consent, fallback, fields sent), `imports/__tests__/statements.parse.test.ts` (GTBank, Access, Zenith, UBA and Kuda layouts, synthetic), `rules/__tests__`, `banking/__tests__` (webhook refused unless the secret matches), `security/__tests__/totp.test.ts` (RFC 6238 vector); app `serverRecords`, `ruleChange` and base64 tests.

## Open decisions for the owner

1. Restore: DESIGN says it replaces the workspace; TECH-SPEC 11 and B3.6 say a new workspace. Built as a new workspace. The app has no workspace switcher yet, so a restored workspace isn't reachable from the app.
2. Passkeys and Mono on phones need native modules (prototypes T0.1, T0.7); hidden on phones.
3. Bank parsers were written without real statements; check each bank with a sample.
4. Server-side Claude fallbacks (`fallbacks` beta) not used; Gemini covers refusals.

## Not done

- Phase 3 and 4 device work: VoiceOver/TalkBack pass, performance on the reference phone, EAS store builds and signing, passkeys and Mono on phones (native modules), and the Release 2 gate's real statements from GTB, Access, Zenith, UBA and Kuda.
- Phase 5 (next): investments E20 to E23 (holdings, lots, prices), reports, cash flow, Health, exchange rates; DESIGN pages 17 to 23 (DESIGN.md lines 1263 to 1537); Dashboard Health and Investments cards; Settings › Currencies. Plan: backend modules plus local read formulas in `src/ledger`, sync ops for holdings/prices/rates through `serverRecords.ts`.
- Existing gaps from the first study: frontend `cases-check.mjs` looks for a lowercase sibling path; Phase 2 endpoints lack the six integration tests.

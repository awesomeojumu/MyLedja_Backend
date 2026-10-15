# MyLedja — working brief (spec v1.3)

Short knowledge file from the 15 October 2026 product and engineering specification. This is not the full spec.

## Product

Personal finance app for Nigeria. Manual-first tracker first; long-term multi-bank intelligence. Default currency NGN; every amount carries a currency. Offline-first. Security-led. Workspaces (personal, family, business).

Three questions: where is my money, where is it going, where is it supposed to go.

## Locked (CON-01–CON-12)

- CON-01 Manual-first tracker; bank aggregation later
- CON-02 React Native, Expo, TypeScript
- CON-03 NestJS modular monolith
- CON-04 MongoDB
- CON-05 Multiple workspaces per user; personal first
- CON-06 Currency-aware from day one
- CON-07 Offline-first with a durable outbox
- CON-08 Cash movement distinct from income, expense, transfer, allocation
- CON-09 CSV import first, with preview
- CON-10 Server-side ownership, auth, audit, tests
- CON-11 Free at launch; server entitlements ready
- CON-12 Bank aggregation deferred until the manual foundation is reliable

## Still open (DEC-01–DEC-14)

DEC-01 financial model · DEC-02 money storage · DEC-03 auth/recovery · DEC-04 workspace roles · DEC-05 offline mutation scope · DEC-06 retention/deletion · DEC-07 hosting · DEC-08 bank provider · DEC-09 entitlements · DEC-10 tax scope · DEC-11 workspaces module / health / OpenAPI home · DEC-12 Mongoose vs driver · DEC-13 reminder channels · DEC-14 MongoDB vs double-entry later

## MVP vs gated

**MVP:** onboarding, personal workspace, manual accounts and transactions, transfers, categories, budgets, bills, goals, basic reports, offline, CSV, privacy/security.

**Gated:** family/business workspaces, bank aggregation, receipt OCR, tax, advanced investing, web client.

## Stack

- Frontend: Expo, TypeScript, expo-sqlite later
- Backend: NestJS, TypeScript, OpenAPI REST
- Data: MongoDB replica set later; Redis/BullMQ later
- Launch boxes now: CI `apptest`, separate env files, Expo Go

## Frontend folders (17)

`auth-onboarding`, `dashboard`, `accounts`, `transactions`, `categories-merchants`, `budgets`, `bills`, `plans-goals`, `income`, `debts`, `savings`, `investments`, `taxes`, `financial-health`, `notifications`, `settings-privacy`, `help-support`

Plus `app/`, `components/`, `navigation/`, `hooks/`, `services/`, `store/`, `theme/`, `utils/`, `database/`, `sync/`, `types/`, `test/`.

## Backend modules (19)

`auth`, `users`, `security`, `accounts`, `transactions`, `categories-merchants`, `budgets`, `income`, `bills`, `plans-goals`, `debts`, `savings-investments`, `taxes`, `analytics`, `notifications`, `imports-exports`, `bank-integrations`, `settings-privacy`, `support-operations`

Gap (DEC-11): add `workspaces/`. Health checks belong in `support-operations`.

## Invariants (IDs only)

INV-01–INV-24: workspace-scoped posted transactions; transfer two effects; transfers not income/expense; category type match; split sums; opening balance not income; loan proceeds not income; principal vs interest; savings not a second asset; investment purchase not expense; sale proceeds not all income; refunds; net worth; explicit currency; idempotency; authorization; durable offline writes; stable reports; receivables; no raw multi-currency sums; pending not double-counted; derived budgets; scheduled items not transactions; accounts reconcile.

## Launch boxes (this pass)

1. CI lints, type-checks, tests, and builds on every push (`npm run apptest`)
2. Separate development, staging, production configs; secret scan finds nothing
3. App opens in Expo Go on Android and iOS

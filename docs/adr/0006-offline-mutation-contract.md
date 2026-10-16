# ADR-0006: Offline mutation matrix, outbox contract and conflict policy (DEC-05)

- Status: Accepted
- Date: 2026-10-16
- Story: MYL-004
- Spec: §6.1–§6.6, §15.1, §16, CON-07, DEC-05

## Context

MyLedja is offline-first (CON-07). Every change allowed offline adds conflict cases, so the MVP must freeze which mutations work offline, how they are queued, and how the server settles competing changes. §6.1 proposes a scope, §6.3 an outbox record, §6.4 a conflict policy and §6.5 sync states. §15.1 requires one ID strategy, with offline-created IDs that are stable and validated by the server.

## Options

| Option | For | Against |
|---|---|---|
| A. Read-only offline | No conflicts at all. | Fails the core need: recording an expense at the market with no signal. |
| **B. Narrow write set offline (transactions, plus accounts and categories) and everything else online** | Covers everyday capture. The conflict surface stays small and testable. | Budgets, bills and goals cannot be edited without a connection in the MVP. |
| C. Everything offline, last write wins | Feels seamless. | Silently overwrites money data, which §6.4 forbids. |
| D. Everything offline with CRDT merging | No lost writes. | Far too complex for financial records with strict invariants. |

## Decision

**Option B.**

### Offline matrix (MVP)

| Action | Offline? |
|---|---|
| View cached accounts, transactions, budgets, goals, with last-sync time | Yes |
| Search and filter cached records | Yes |
| Create, edit, void a transaction, including a transfer and its splits | **Yes**, through the outbox |
| Create an account, and edit its name, colour or icon | **Yes**, through the outbox |
| Create a category | **Yes**, through the outbox |
| Archive an account, or change an opening balance | No, online only |
| Budgets, bills, goals: create or edit | No, online only in the MVP; to be reviewed after launch |
| Commit an import (the preview may run locally) | No, online only |
| Members, roles, security, workspace settings, sessions | No, online only, with strict version checks |
| Bank connections, subscriptions, permanent deletion, exports | No, online only and confirmed by the server |

### IDs

All entities use **client-generated UUIDv7 strings** as `_id`, including records created online, so there is one ID strategy. The server validates the format, the workspace, and that the ID is unused.

### Outbox record (§6.3)

`operationId` (UUIDv7), `entityType`, `entityId`, `operationType` (`create`, `update` or `void`), `baseVersion` (absent on create), `payload` (the validated mutation only), `clientCreatedAt` (a diagnostic hint, never trusted for ordering), `status`, `attemptCount` and `lastError`.

The client stores the outbox record in expo-sqlite **before** telling the user the change is saved. Each workspace and user has its own partition (§6.2).

### Server contract

- **Idempotency:** `operationId` has a unique index. Replaying the same ID with the same payload returns the original result. The same ID with a different payload is rejected with `422 OPERATION_ID_REUSED`.
- **Optimistic concurrency:** an update or void must include `baseVersion`. If it differs from the stored `version`, the server returns `409 <ENTITY>_VERSION_CONFLICT` with the current server copy. It never overwrites silently (§6.4).
- **Creates** with fresh IDs always merge.
- **A transfer** is one operation, written in a single MongoDB transaction (ADR-0002, ADR-0003).
- **A void racing an edit:** whichever arrives second gets a version conflict. A voided record is never brought back by a stale edit. Restoring it is an explicit `update` from the conflict screen.
- **Authorization** is checked again on replay. A mutation queued before the user's access was removed is `rejected`.

### Client state machine (§6.5)

`saved_on_device` → `syncing` → one of:

- `synced`
- `needs_attention`: a 409 or 422 conflict or validation error. The user resolves it on the conflict screen and their draft is kept.
- `failed_temporarily`: a network error, 5xx or 429. Retry with exponential backoff and jitter, from 2 s up to 5 min, then back to `syncing`.
- `rejected`: a permanent business or authorization failure. It is explained to the user and the payload is kept for export.

Operations on the same entity are sent in order. A record created offline must sync before any record that references it, for example an account before its first transaction.

## Consequences

- The conflict screen and the outbox are MVP work for the frontend `sync/` and `database/` folders, not polish.
- Every offline-capable endpoint needs idempotency and version tests, plus the offline test matrix: airplane mode, app kill, reconnect, retry, conflict, logout and account switch (§10).
- Using UUIDv7 rather than ObjectId keeps one ID type end to end. Indexes stay time-ordered.
- Widening the offline set later (budgets, bills, goals) means updating this ADR and extending the version checks to those entities.

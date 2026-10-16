# MyLedja_Backend

NestJS API for MyLedja, on MongoDB through the official driver.

```bash
cp .env.development.example .env.development   # then set MONGODB_URI
npm install
npm run apptest
npm run start:dev
```

`.env.<APP_ENV>` is loaded at startup and is gitignored. Only the `*.example` files are committed.

`GET /health` returns `200 { "status": "ok", "database": "up" }`, or `503 { "status": "error", "database": "down" }`. It never shows env, host or error details.

`npm run apptest` is Test App: lint → typecheck → test → build.

## API (v1)

Everything except `/health` is under `/v1`. Errors come back as `{ "status": "error", "error": "<reason>" }`.

| Method and path | Auth | Notes |
|---|---|---|
| `POST /v1/auth/register` `{ email, password }` | – | Always `202 { status: "accepted" }`, whether or not the email exists |
| `POST /v1/auth/verify` `{ email, code }` | – | Verifies the email and creates the Personal workspace (owner) |
| `POST /v1/auth/verify/resend` `{ email }` | – | Neutral `202` |
| `POST /v1/auth/login` `{ email, password }` | – | `{ accessToken, refreshToken, userId, expiresIn }`. `403` if the email is not verified |
| `POST /v1/auth/refresh` `{ refreshToken }` | – | Rotates the token. Reusing an old one revokes the whole session (TC-17) |
| `POST /v1/auth/logout` `{ refreshToken }` | – | Revokes the session. Its access token stops working at once |
| `POST /v1/auth/recovery` `{ email }` | – | Neutral `202`. Never reveals whether an account exists |
| `POST /v1/auth/recovery/confirm` `{ email, code, password }` | – | Sets the new password and revokes every session |
| `GET /v1/auth/me` | Bearer | `{ userId, email }` |
| `GET /v1/workspaces` | Bearer | The caller's workspaces and roles |
| `GET`/`PATCH /v1/workspaces/:id` | Bearer | `404` for any workspace you are not a member of (TC-08) |
| `POST /v1/workspaces/:id/members`, `PATCH .../members/:userId` | Bearer | Owner and admin only. Every change writes an `audit_events` record |

In development the verification and reset codes are printed in the API console (`[auth] verify code for …`). Staging and production refuse to send mail until a real email provider is wired in (DEC-07).

Rate limits are kept in memory per API instance. Behind a proxy, set `TRUST_PROXY` so the client IP is read correctly. Never trust `X-Forwarded-For` without it.

## Data

- Money is stored as int64 minor units with a currency code ([ADR-0001](docs/adr/0001-money-storage-integer-minor-units.md)). Use `src/common/money`.
- Data access goes through the official `mongodb` driver. Multi-document writes use `runInTransaction` ([ADR-0002](docs/adr/0002-mongodb-official-driver.md)).
- Transaction tests run on an in-memory replica set. Set `MONGODB_TEST_URI` to run them against a real cluster. They create and then drop a `myledja_test_*` database.

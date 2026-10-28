# MyLedja backend

The MyLedja API: NestJS on Fastify, TypeScript strict, the official MongoDB driver and Zod. Built from the build plan, TECH-SPEC and DESIGN.md. Questions and decisions are in [`docs/QUESTIONS.md`](docs/QUESTIONS.md).

## The API contract

[`openapi.json`](openapi.json) is the contract the app is generated from. It's written by `npm run openapi` from the Zod schemas in `src/modules/<module>/<module>.contract.ts`, and CI fails if the committed file is stale. Don't edit it by hand.

- Everything is under `/v1`. Workspace routes are `/v1/workspaces/{workspaceId}/...`.
- Amounts are strings of whole minor units (kobo): `"1845000"` is ₦18,450.00. Dates are `YYYY-MM-DD` in the workspace's time zone.
- Every write carries `X-Operation-Id` (a UUID made on the device). Retrying with the same id runs the change once and returns the first answer.
- Errors are `{ code, message, field?, retryAfterSeconds? }`. `message` follows DESIGN.md 2.12 and can be shown as it is.
- Sign-in answers carry a 15-minute `accessToken` (send as `Authorization: Bearer ...`) and a rotating `refreshToken`. On web with "Stay signed in", the refresh token is an HttpOnly cookie instead, and `/v1/auth/refresh` needs the `X-MyLedja-Client` header.

In the frontend, with this branch checked out at `../MyLedja_Backend`, run `npm run api:sync`.

## Commands

| Command                      | Does                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `npm run dev`                | API on port 4000 with `.env.development`                   |
| `npm run lint` / `typecheck` | ESLint and Prettier / `tsc --noEmit`                       |
| `npm test`                   | Unit tests                                                 |
| `npm run test:int`           | Integration tests against an in-memory MongoDB replica set |
| `npm run build`              | Compile to `dist/`                                         |
| `npm run openapi`            | Write `openapi.json`                                       |
| `npm run migrate`            | Run database migrations (safe to run twice)                |
| `npm run check`              | Everything CI runs                                         |

Environment variables are listed in `.env.*.example` with their exact names (TECH-SPEC 2.1). Only `src/config/` reads them. Development needs at least `MONGODB_URI`, `JWT_SECRET` and its own `ACCOUNT_NUMBER_KEY` (64 hex characters; make one with `openssl rand -hex 32`).

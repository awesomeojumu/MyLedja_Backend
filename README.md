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

## Data

- Money is stored as int64 minor units with a currency code ([ADR-0001](docs/adr/0001-money-storage-integer-minor-units.md)). Use `src/common/money`.
- Data access goes through the official `mongodb` driver. Multi-document writes use `runInTransaction` ([ADR-0002](docs/adr/0002-mongodb-official-driver.md)).
- Transaction tests run on an in-memory replica set. Set `MONGODB_TEST_URI` to run them against a real cluster. They create and then drop a `myledja_test_*` database.

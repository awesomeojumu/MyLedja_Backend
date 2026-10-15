# MyLedja_Backend

NestJS API for MyLedja. Health-only scaffold.

```bash
cp .env.development.example .env.development
npm install
npm run apptest
npm run start:dev
```

`GET /health` returns `{ "ok": true, "env": "development" }`.

`npm run apptest` is Test App: lint → typecheck → test → build.

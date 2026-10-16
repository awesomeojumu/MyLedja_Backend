# ADR-0002: Use the official MongoDB Node.js driver, not Mongoose (DEC-12)

- Status: Accepted
- Date: 2026-10-15
- Story: MYL-003
- Spec: §15, §15.1, DEC-12

## Context

Spec DEC-12 asks for one data-access library. Mixing the official driver and Mongoose leads to inconsistent validation and transactions. §15.1 requires multi-document transactions on a replica set, strict DTOs and collection validators.

## Decision

Use the **official `mongodb` driver** directly. Do not add Mongoose.

- **Connection:** `DatabaseModule` (`src/database/mongo`) owns one `MongoClient` for the whole app. It reads `MONGODB_URI` and `MONGODB_DB` and sets `useBigInt64: true` (see ADR-0001). Repositories inject `MONGO_DB` and use typed `Collection<T>` objects.
- **Transactions:** every multi-document write goes through `runInTransaction(client, fn)` in `src/database/mongo/transaction.ts`. It uses `session.withTransaction` with `readConcern: majority` and `writeConcern: majority`. That retries transient errors and aborts on any thrown error. Each operation inside it must pass `{ session }`.
- **Topology:** transactions need a replica set. Development, staging and production use a MongoDB Atlas cluster, which is always a replica set. Tests use `mongodb-memory-server`'s `MongoMemoryReplSet` when `MONGODB_URI` is not set.
- **Validation:** request input is checked by DTOs at the API edge. Collections get `$jsonSchema` validators through migrations in `src/database/migrations`, where practical.

## Consequences

- One transaction pattern and no schema layer that disagrees with the collection validators.
- Repositories map documents by hand. That is a little more code than Mongoose models, but every read and write is explicit.
- Mongoose must not be added later without a new ADR that replaces this one.

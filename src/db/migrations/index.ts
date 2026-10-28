import type { Db } from 'mongodb';
import { installValidators } from '../validators/index.js';

export interface Migration {
  /** `0001-<name>`; run in order of name. */
  name: string;
  /** Must be safe to run twice. */
  up(db: Db): Promise<void>;
}

const m0001: Migration = {
  name: '0001-validators-and-indexes',
  async up(db) {
    await installValidators(db);
    const ix = (name: string) => db.collection(name);
    await ix('users').createIndex({ email: 1 }, { unique: true });
    await ix('users').createIndex(
      { googleId: 1 },
      { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } },
    );
    await ix('sessions').createIndex({ userId: 1 });
    await ix('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await ix('codes').createIndex({ email: 1, purpose: 1 }, { unique: true });
    await ix('codes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await ix('memberships').createIndex({ workspaceId: 1, userId: 1 }, { unique: true });
    await ix('memberships').createIndex({ userId: 1 });
    await ix('audit_events').createIndex({ workspaceId: 1, at: -1 });
    await ix('jobs').createIndex({ status: 1, runAt: 1 });
    await ix('rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await ix('idempotency').createIndex({ scope: 1, operationId: 1 }, { unique: true });
    await ix('idempotency').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  },
};

export const MIGRATIONS: Migration[] = [m0001];

/** Runs every migration not yet recorded in `migrations`, in order. Safe to run twice. */
export async function migrate(db: Db, migrations: Migration[] = MIGRATIONS): Promise<string[]> {
  const log = db.collection<{ _id: string; appliedAt: Date }>('migrations');
  const done = new Set((await log.find({}).toArray()).map((m) => m._id));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    await m.up(db);
    await log.updateOne({ _id: m.name }, { $setOnInsert: { appliedAt: new Date() } }, { upsert: true });
    applied.push(m.name);
  }
  return applied;
}

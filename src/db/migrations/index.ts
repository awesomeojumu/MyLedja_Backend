import type { Db } from 'mongodb';
import { newId } from '../../common/ids/ids.js';
import { SYSTEM_ACCOUNTS, SYSTEM_KEYS } from '../../modules/ledger/ledger.types.js';
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

const m0002: Migration = {
  name: '0002-ledger',
  async up(db) {
    await installValidators(db);
    const ix = (name: string) => db.collection(name);
    const isString = (field: string) => ({ partialFilterExpression: { [field]: { $type: 'string' } } });
    await ix('ledger_accounts').createIndex({ workspaceId: 1, kind: 1 });
    await ix('ledger_accounts').createIndex(
      { workspaceId: 1, systemKey: 1 },
      { unique: true, ...isString('systemKey') },
    );
    await ix('ledger_accounts').createIndex(
      { workspaceId: 1, categoryId: 1 },
      { unique: true, ...isString('categoryId') },
    );
    await ix('ledger_accounts').createIndex(
      { workspaceId: 1, operationId: 1 },
      { unique: true, ...isString('operationId') },
    );
    await ix('transactions').createIndex({ workspaceId: 1, operationId: 1 }, { unique: true });
    await ix('transactions').createIndex({ workspaceId: 1, date: -1, _id: -1 });
    await ix('transactions').createIndex({ workspaceId: 1, 'lines.ledgerAccountId': 1, date: -1 });
    await ix('transactions').createIndex({ workspaceId: 1, payeeId: 1 });
    await ix('transactions').createIndex({ workspaceId: 1, 'links.refundOf': 1 }, isString('links.refundOf'));
    await ix('account_balances').createIndex({ workspaceId: 1, ledgerAccountId: 1, currency: 1 }, { unique: true });
    await ix('period_totals').createIndex(
      { workspaceId: 1, ledgerAccountId: 1, currency: 1, month: 1 },
      { unique: true },
    );
    await ix('period_totals').createIndex({ workspaceId: 1, month: 1 });
    await ix('changes').createIndex({ workspaceId: 1, seq: 1 }, { unique: true });
    await ix('balance_checks').createIndex({ workspaceId: 1, at: -1 });

    const workspaces = await ix('workspaces')
      .find({}, { projection: { _id: 1, currency: 1 } })
      .toArray();
    const now = new Date();
    for (const w of workspaces) {
      for (const key of SYSTEM_KEYS) {
        const { kind, name } = SYSTEM_ACCOUNTS[key];
        await ix('ledger_accounts').updateOne(
          { workspaceId: w._id, systemKey: key },
          {
            $setOnInsert: {
              _id: newId() as never,
              kind,
              name,
              currency: w.currency,
              categoryId: null,
              accountType: null,
              institution: null,
              last4: null,
              onBudget: false,
              archivedAt: null,
              sortOrder: 0,
              operationId: null,
              createdAt: now,
              updatedAt: now,
              version: 1,
            },
          },
          { upsert: true },
        );
      }
    }
  },
};

export const MIGRATIONS: Migration[] = [m0001, m0002];

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

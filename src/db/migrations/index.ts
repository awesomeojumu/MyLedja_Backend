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

/**
 * Categories, groups, tags and payees (B1.7). Default categories are seeded when a workspace is made;
 * no workspace predates this release, so there is nothing to backfill (Q-B15).
 */
const m0003: Migration = {
  name: '0003-categories',
  async up(db) {
    await installValidators(db);
    const ix = (name: string) => db.collection(name);
    await ix('category_groups').createIndex({ workspaceId: 1, sortOrder: 1 });
    await ix('categories').createIndex({ workspaceId: 1, groupId: 1, sortOrder: 1 });
    await ix('categories').createIndex(
      { workspaceId: 1, starterKey: 1 },
      { unique: true, partialFilterExpression: { starterKey: { $type: 'string' } } },
    );
    await ix('categories').createIndex({ workspaceId: 1, 'deletion.undoId': 1 }, { sparse: true });
    await ix('tags').createIndex({ workspaceId: 1, nameKey: 1 }, { unique: true });
    await ix('payees').createIndex({ workspaceId: 1, nameKey: 1, _id: 1 });
    await ix('payees').createIndex({ workspaceId: 1, aliasKeys: 1 });
    await ix('payee_merges').createIndex({ workspaceId: 1, at: -1 });
    await ix('transactions').createIndex({ workspaceId: 1, 'lines.categoryId': 1 });
    await ix('transactions').createIndex({ workspaceId: 1, tagIds: 1 });
  },
};

/**
 * Transfer-suggestion dismissals (B1.8). A dismissed pair won't be suggested again.
 */
const m0004: Migration = {
  name: '0004-transfer-dismissals',
  async up(db) {
    await installValidators(db);
    await db.collection('transfer_dismissals').createIndex({ workspaceId: 1, outId: 1, inId: 1 }, { unique: true });
  },
};

const m0005: Migration = {
  name: '0005-reconciliations',
  async up(db) {
    await installValidators(db);
    const ix = db.collection('reconciliations');
    await ix.createIndex({ workspaceId: 1, accountId: 1, createdAt: -1 });
    await ix.createIndex(
      { workspaceId: 1, accountId: 1 },
      { unique: true, partialFilterExpression: { status: 'in_progress' } },
    );
  },
};

/** Assigned plan per category per month (B1.9). */
const m0006: Migration = {
  name: '0006-budget-months',
  async up(db) {
    await installValidators(db);
    await db.collection('budget_months').createIndex({ workspaceId: 1, month: 1, categoryId: 1 }, { unique: true });
  },
};

/** CSV statement imports (B1.12). Content is kept on the doc for Phase 1; Cloudinary is optional. */
const m0007: Migration = {
  name: '0007-imports',
  async up(db) {
    await installValidators(db);
    const ix = db.collection('imports');
    await ix.createIndex({ workspaceId: 1, accountId: 1, createdAt: -1 });
    await ix.createIndex({ workspaceId: 1, status: 1 });
  },
};

const m0008: Migration = {
  name: '0008-schedules',
  async up(db) {
    await installValidators(db);
    await db.collection('schedules').createIndex({ workspaceId: 1, nextDate: 1 });
    await db
      .collection('schedules')
      .createIndex(
        { workspaceId: 1, operationId: 1 },
        { unique: true, partialFilterExpression: { operationId: { $type: 'string' } } },
      );
    await db.collection('occurrences').createIndex({ workspaceId: 1, scheduleId: 1, date: 1 }, { unique: true });
    await db.collection('occurrences').createIndex({ workspaceId: 1, date: 1 });
  },
};

const m0009: Migration = {
  name: '0009-debts',
  async up(db) {
    await installValidators(db);
    await db.collection('debts').createIndex({ workspaceId: 1, status: 1, _id: 1 });
    await db.collection('debts').createIndex({ workspaceId: 1, payeeId: 1 });
    await db
      .collection('debts')
      .createIndex(
        { workspaceId: 1, operationId: 1 },
        { unique: true, partialFilterExpression: { operationId: { $type: 'string' } } },
      );
  },
};

const m0010: Migration = {
  name: '0010-goals',
  async up(db) {
    await installValidators(db);
    await db.collection('goals').createIndex({ workspaceId: 1, status: 1 });
    await db
      .collection('goals')
      .createIndex(
        { workspaceId: 1, operationId: 1 },
        { unique: true, partialFilterExpression: { operationId: { $type: 'string' } } },
      );
    await db.collection('goal_allocations').createIndex({ workspaceId: 1, goalId: 1, date: -1 });
  },
};

export const MIGRATIONS: Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010];

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

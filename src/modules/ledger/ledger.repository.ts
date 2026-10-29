import type { ClientSession, Db, Decimal128, Filter } from 'mongodb';
import { newId } from '../../common/ids/ids.js';
import { BaseRepository, GlobalRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { InvestmentMeta } from './investments.js';
import type { AccountRef, EventLinks, EventStatus, EventType, LedgerKind, Line, SystemKey } from './ledger.types.js';

type Opts = { session?: ClientSession };

/** Real account types a person chooses from (DESIGN.md page 8). */
export const ACCOUNT_TYPES = [
  'bank',
  'cash',
  'wallet',
  'savings',
  'fixed_deposit',
  'card',
  'loan',
  'investment',
  'property',
  'pension',
  'other_asset',
  'other_liability',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type LedgerAccountDoc = {
  _id: string;
  workspaceId: string;
  kind: LedgerKind;
  name: string;
  currency: string;
  /** Set on the seeded system accounts only. */
  systemKey: SystemKey | null;
  /** Set on a category's account only. */
  categoryId: string | null;
  /** A real account's type; null for categories and system accounts. */
  accountType: AccountType | null;
  institution: string | null;
  last4: string | null;
  onBudget: boolean;
  archivedAt: Date | null;
  sortOrder: number;
  operationId: string | null;
  personDebt?: 'receivable' | 'payable' | null;
  /** Set on a holding's ledger account: the investment account it's held in. Its id is the holding's id. */
  holdingOf?: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export const toRef = (a: LedgerAccountDoc): AccountRef => ({
  id: a._id,
  kind: a.kind,
  currency: a.currency,
  systemKey: a.systemKey,
  categoryId: a.categoryId,
  archived: a.archivedAt !== null,
  personDebt: a.personDebt ?? null,
  holding: !!a.holdingOf,
});

export class LedgerAccountsRepository extends BaseRepository<LedgerAccountDoc> {
  constructor(db: Db) {
    super(db, 'ledger_accounts');
  }

  byIds(ctx: WorkspaceContext, ids: string[], o: Opts = {}) {
    return this.find(ctx, { _id: { $in: ids } }, o);
  }

  byCategories(ctx: WorkspaceContext, categoryIds: string[], o: Opts = {}) {
    return this.find(ctx, { categoryId: { $in: categoryIds } }, o);
  }

  system(ctx: WorkspaceContext, o: Opts = {}) {
    return this.find(ctx, { systemKey: { $ne: null } }, o);
  }

  /** Inserts the account unless one with the same system key or category already exists. */
  async ensure(
    ctx: WorkspaceContext,
    key: Filter<LedgerAccountDoc>,
    doc: Omit<LedgerAccountDoc, 'workspaceId'>,
    o: Opts = {},
  ) {
    await this.updateOne(ctx, key, { $setOnInsert: doc }, { ...o, upsert: true });
  }
}

export type TransactionDoc = {
  _id: string;
  workspaceId: string;
  operationId: string;
  type: EventType;
  status: EventStatus;
  date: string;
  recordedAt: Date;
  recordedBy: { userId: string | null; deviceId: string | null };
  payeeId: string | null;
  notes: string | null;
  tagIds: string[];
  receiptFileIds: string[];
  lines: Line[];
  links: EventLinks;
  fxRate: Decimal128 | null;
  /** Set while the event is locked by a finished reconcile (DESIGN.md page 10). */
  reconciliationId: string | null;
  /** Accounts on which this event is ticked as cleared. */
  clearedAccountIds: string[];
  importId: string | null;
  /** Income one-off (DESIGN page 13); excluded from steadiness. */
  oneOff?: boolean;
  /** E20 to E22: units, prices and the lots a sale took (TECH-SPEC 6.8). Absent on other events. */
  investment?: InvestmentMeta | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class TransactionsRepository extends BaseRepository<TransactionDoc> {
  constructor(db: Db) {
    super(db, 'transactions');
  }

  byId(ctx: WorkspaceContext, id: string, o: Opts = {}) {
    return this.findOne(ctx, { _id: id }, o);
  }

  byOperation(ctx: WorkspaceContext, operationId: string, o: Opts = {}) {
    return this.findOne(ctx, { operationId }, o);
  }

  /** What has already been refunded against a purchase, by its live refunds. */
  async refundedAgainst(ctx: WorkspaceContext, eventId: string, o: Opts = {}): Promise<bigint> {
    const refunds = await this.find(ctx, { 'links.refundOf': eventId, status: 'posted', type: 'refund' }, o);
    let sum = 0n;
    for (const r of refunds) for (const l of r.lines) if (l.amountMinor > 0n) sum += l.amountMinor;
    return sum;
  }

  /**
   * Marks a posted event reversed, only if nobody changed it first (TECH-SPEC 6.11 check 8).
   * Returns null when it was already reversed or its version moved on.
   */
  markReversed(ctx: WorkspaceContext, id: string, reversalId: string, version: number | null, now: Date, o: Opts = {}) {
    return this.findOneAndUpdate(
      ctx,
      { _id: id, status: 'posted', ...(version === null ? {} : { version }) },
      { $set: { status: 'reversed', 'links.reversedBy': reversalId, updatedAt: now }, $inc: { version: 1 } },
      o,
    );
  }
}

export type BalanceDoc = {
  _id: string;
  workspaceId: string;
  ledgerAccountId: string;
  currency: string;
  balanceMinor: bigint;
  updatedAt: Date;
};

/** The cached balance per account and currency, updated in the same transaction as each event (TECH-SPEC 5.4). */
export class AccountBalancesRepository extends BaseRepository<BalanceDoc> {
  constructor(db: Db) {
    super(db, 'account_balances');
  }

  add(ctx: WorkspaceContext, line: Line, now: Date, o: Opts = {}) {
    return this.updateOne(
      ctx,
      { _id: `${line.ledgerAccountId}:${line.currency}` },
      {
        $inc: { balanceMinor: line.amountMinor },
        $set: { updatedAt: now },
        $setOnInsert: { ledgerAccountId: line.ledgerAccountId, currency: line.currency },
      },
      { ...o, upsert: true },
    );
  }

  forAccounts(ctx: WorkspaceContext, ids: string[], o: Opts = {}) {
    return this.find(ctx, { ledgerAccountId: { $in: ids } }, o);
  }

  all(ctx: WorkspaceContext, o: Opts = {}) {
    return this.find(ctx, {}, o);
  }
}

export type PeriodTotalDoc = {
  _id: string;
  workspaceId: string;
  ledgerAccountId: string;
  currency: string;
  month: string;
  debitsMinor: bigint;
  creditsMinor: bigint;
  /** Live events touching the account in the month; a reversal takes one away. */
  count: number;
};

/** Debits, credits and count per account per month (TECH-SPEC 5.4). Dashboards and budgets read these. */
export class PeriodTotalsRepository extends BaseRepository<PeriodTotalDoc> {
  constructor(db: Db) {
    super(db, 'period_totals');
  }

  add(ctx: WorkspaceContext, line: Line, month: string, countDelta: number, o: Opts = {}) {
    const debit = line.amountMinor > 0n ? line.amountMinor : 0n;
    const credit = line.amountMinor < 0n ? -line.amountMinor : 0n;
    return this.updateOne(
      ctx,
      { _id: `${line.ledgerAccountId}:${line.currency}:${month}` },
      {
        $inc: { debitsMinor: debit, creditsMinor: credit, count: countDelta },
        $setOnInsert: { ledgerAccountId: line.ledgerAccountId, currency: line.currency, month },
      },
      { ...o, upsert: true },
    );
  }

  months(ctx: WorkspaceContext, from: string, to: string, o: Opts = {}) {
    return this.find(ctx, { month: { $gte: from, $lte: to } }, o);
  }
}

export type ChangeDoc = {
  _id: string;
  workspaceId: string;
  seq: bigint;
  collection: string;
  docId: string;
  op: 'upsert' | 'tombstone';
  at: Date;
};

/** Tombstones (and change rows) are kept this long; a device further behind gets `reset: true` (TECH-SPEC 5.7). */
export const CHANGE_RETENTION_DAYS = 180;

/** The sync change feed (TECH-SPEC 5.7). Every accepted change gets the next `seq` of its workspace. */
export class ChangesRepository extends BaseRepository<ChangeDoc> {
  constructor(db: Db) {
    super(db, 'changes');
  }

  async record(
    ctx: WorkspaceContext,
    firstSeq: bigint,
    items: { collection: string; docId: string; op: ChangeDoc['op'] }[],
    now: Date,
    o: Opts = {},
  ) {
    let seq = firstSeq;
    for (const item of items) {
      await this.insertOne(ctx, { _id: newId(), seq, ...item, at: now }, o);
      seq += 1n;
    }
  }

  /** Changes after `since` (exclusive), oldest first, up to `limit`. */
  since(ctx: WorkspaceContext, since: bigint, limit: number, o: Opts = {}) {
    return this.find(ctx, { seq: { $gt: since } }, { ...o, sort: { seq: 1 }, limit });
  }

  async minSeq(ctx: WorkspaceContext, o: Opts = {}): Promise<bigint | null> {
    const [row] = await this.find(ctx, {}, { ...o, sort: { seq: 1 }, limit: 1 });
    return row?.seq ?? null;
  }

  async oldest(ctx: WorkspaceContext, o: Opts = {}): Promise<ChangeDoc | null> {
    const [row] = await this.find(ctx, {}, { ...o, sort: { seq: 1 }, limit: 1 });
    return row ?? null;
  }
}

/** Every workspace id, for the nightly checks that visit each workspace. Read-only. */
export class WorkspaceIndex extends GlobalRepository<{ _id: string }> {
  constructor(db: Db) {
    super(db, 'workspaces');
  }

  async ids(): Promise<string[]> {
    return (await this.collection.find({}, { projection: { _id: 1 } }).toArray()).map((w) => w._id);
  }

  async timeZones(): Promise<{ id: string; timeZone: string }[]> {
    const rows = await this.collection.find({}, { projection: { _id: 1, timeZone: 1 } }).toArray();
    return rows.map((w) => {
      const row = w as { _id: string; timeZone: string };
      return { id: row._id, timeZone: row.timeZone };
    });
  }
}

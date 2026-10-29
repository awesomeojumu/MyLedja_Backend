import { AsyncLocalStorage } from 'node:async_hooks';
import { type ClientSession, Decimal128, MongoServerError } from 'mongodb';
import { AppError } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { CountersRepository } from '../workspaces/workspaces.repository.js';
import { buildEvent, buildReversal, type Resolver } from './builders.js';
import { checkLines } from './checks.js';
import { LedgerErrors } from './ledger.errors.js';
import type { EventInput } from './ledger.inputs.js';
import {
  type AccountBalancesRepository,
  type ChangesRepository,
  type LedgerAccountDoc,
  type LedgerAccountsRepository,
  type PeriodTotalsRepository,
  toRef,
  type TransactionDoc,
  type TransactionsRepository,
} from './ledger.repository.js';
import {
  type AccountRef,
  type LedgerKind,
  type Line,
  SYSTEM_ACCOUNTS,
  SYSTEM_KEYS,
  type SystemKey,
} from './ledger.types.js';
import { monthOf } from './read.js';

export type PostOptions = { operationId: string; deviceId?: string | null; importId?: string | null };
export type PostResult = { event: TransactionDoc; duplicate: boolean };
export type CorrectResult = { reversal: TransactionDoc; event: TransactionDoc; duplicate: boolean };

/** Fields of a posted event that change in place, because they don't affect any figure (TECH-SPEC 6.3). */
export type EventPatch = {
  notes?: string | null;
  tagIds?: string[];
  payeeId?: string | null;
  receiptFileIds?: string[];
};

const REVERSAL_SUFFIX = ':reversal';
const isDuplicateKey = (e: unknown) => e instanceof MongoServerError && e.code === 11000;

/**
 * The `ledger` module: every money write in the app goes through `post`, `correct` or `reverse`
 * (build plan B1.3, B1.4). Each one builds the lines, runs the integrity checks, and writes the event,
 * balances, period totals, change feed and audit entry in one transaction.
 */
export class LedgerService {
  /** Ids the device made for the transactions one sync operation posts (TECH-SPEC 5.4), used in posting order. */
  private readonly clientIds = new AsyncLocalStorage<{ ids: string[]; given: Map<string, string> }>();

  withClientIds<T>(ids: string[] | undefined, fn: () => Promise<T>): Promise<T> {
    if (!ids?.length) return fn();
    return this.clientIds.run({ ids: [...ids], given: new Map() }, fn);
  }

  /** The device's id for this posting, or a new one. A retried transaction keeps the id it was given. */
  private idFor(operationId: string): string {
    const store = this.clientIds.getStore();
    if (!store) return newId();
    const seen = store.given.get(operationId);
    if (seen) return seen;
    const id = store.ids.shift() ?? newId();
    store.given.set(operationId, id);
    return id;
  }

  constructor(
    private readonly database: Database,
    readonly accounts: LedgerAccountsRepository,
    readonly transactions: TransactionsRepository,
    readonly balances: AccountBalancesRepository,
    readonly totals: PeriodTotalsRepository,
    private readonly changes: ChangesRepository,
    private readonly counters: CountersRepository,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Seeds the workspace's system accounts (B1.1). Safe to run twice: each key exists at most once. */
  async seedSystemAccounts(ctx: WorkspaceContext, currency: string, session?: ClientSession): Promise<void> {
    const now = this.now();
    for (const key of SYSTEM_KEYS) {
      const { kind, name } = SYSTEM_ACCOUNTS[key];
      await this.accounts.ensure(
        ctx,
        { systemKey: key },
        { ...blankAccount(kind, name, currency, now), systemKey: key, onBudget: false },
        { session },
      );
    }
  }

  /** The one ledger account behind a category (B1.1). Safe to run twice. */
  async ensureCategoryAccount(
    ctx: WorkspaceContext,
    category: { categoryId: string; kind: 'income' | 'expense'; name: string; currency: string },
    session?: ClientSession,
  ): Promise<LedgerAccountDoc> {
    await this.accounts.ensure(
      ctx,
      { categoryId: category.categoryId },
      {
        ...blankAccount(category.kind, category.name, category.currency, this.now()),
        categoryId: category.categoryId,
      },
      { session },
    );
    const [doc] = await this.accounts.byCategories(ctx, [category.categoryId], { session });
    return doc!;
  }

  /** Gives a system income or expense account its category, so it can be chosen like any other (Q-B13). */
  async linkSystemCategory(ctx: WorkspaceContext, key: SystemKey, categoryId: string, session?: ClientSession) {
    const res = await this.accounts.updateOne(
      ctx,
      { systemKey: key, categoryId: null },
      { $set: { categoryId, onBudget: true, updatedAt: this.now() }, $inc: { version: 1 } },
      { session },
    );
    return res.modifiedCount === 1;
  }

  /** Welcome may change the workspace currency; allowed only while no money is recorded. */
  async changeCurrency(ctx: WorkspaceContext, currency: string, session: ClientSession) {
    if ((await this.transactions.count(ctx, {}, { session })) > 0) {
      throw new AppError(409, 'currency_locked', 'The currency can\u2019t change once money is recorded.', {
        field: 'currency',
      });
    }
    await this.accounts.updateMany(ctx, {}, { $set: { currency, updatedAt: this.now() } }, { session });
  }

  /** A person's own account: bank, card, loan and so on. The accounts module adds its opening balance. */
  async openAccount(
    ctx: WorkspaceContext,
    a: {
      id?: string;
      kind: 'asset' | 'liability';
      accountType: LedgerAccountDoc['accountType'];
      name: string;
      currency: string;
      institution?: string | null;
      last4?: string | null;
      onBudget?: boolean;
      sortOrder?: number;
      operationId?: string | null;
      personDebt?: 'receivable' | 'payable' | null;
    },
    session?: ClientSession,
  ): Promise<LedgerAccountDoc> {
    const doc: Omit<LedgerAccountDoc, 'workspaceId'> = {
      ...blankAccount(a.kind, a.name, a.currency, this.now()),
      _id: a.id ?? newId(),
      accountType: a.accountType,
      institution: a.institution ?? null,
      last4: a.last4 ?? null,
      onBudget: a.onBudget ?? true,
      sortOrder: a.sortOrder ?? 0,
      operationId: a.operationId ?? null,
      personDebt: a.personDebt ?? null,
    };
    return this.accounts.insertOne(ctx, doc, { session });
  }

  /** Posts one event (build plan B1.3). A repeated operationId returns the first event and posts nothing. */
  async post(ctx: WorkspaceContext, input: EventInput, opts: PostOptions): Promise<PostResult> {
    if (!opts.operationId) throw new AppError(400, 'operation_id_missing', 'This change needs an operation id.');
    const existing = await this.transactions.byOperation(ctx, opts.operationId);
    if (existing) return { event: existing, duplicate: true };
    try {
      const event = await this.database.transaction((session) => this.postIn(ctx, input, opts, session));
      return { event, duplicate: false };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const first = await this.transactions.byOperation(ctx, opts.operationId);
      if (!first) throw e;
      return { event: first, duplicate: true };
    }
  }

  /** `post` inside a transaction the caller already holds (imports post many events in one). */
  async postIn(
    ctx: WorkspaceContext,
    input: EventInput,
    opts: PostOptions,
    session: ClientSession,
  ): Promise<TransactionDoc> {
    const resolver = await this.resolverFor(ctx, input, session);
    const built = buildEvent(input, resolver);
    checkLines(built.type, built.lines, resolver.any);
    const now = this.now();
    const event: Omit<TransactionDoc, 'workspaceId'> = {
      _id: this.idFor(opts.operationId),
      operationId: opts.operationId,
      type: built.type,
      status: 'posted',
      date: input.date,
      recordedAt: now,
      recordedBy: { userId: ctx.userId, deviceId: opts.deviceId ?? null },
      payeeId: input.payeeId ?? null,
      notes: input.notes ?? null,
      tagIds: [...new Set(input.tagIds ?? [])],
      receiptFileIds: [],
      lines: built.lines,
      links: {
        ...(built.refundOf ? { refundOf: built.refundOf } : {}),
        ...(input.type === 'expense' && 'goalId' in input && input.goalId ? { goalId: input.goalId } : {}),
      },
      fxRate: built.fxRate ? Decimal128.fromString(built.fxRate) : null,
      reconciliationId: null,
      clearedAccountIds: [],
      importId: opts.importId ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const [doc] = await this.write(ctx, [event], [], session);
    return doc!;
  }

  /** "Delete": an E25 reversal only. The original keeps its history and becomes `reversed`. */
  async reverse(
    ctx: WorkspaceContext,
    id: string,
    opts: PostOptions & { baseVersion?: number | null },
  ): Promise<PostResult> {
    const reversalOp = opts.operationId + REVERSAL_SUFFIX;
    const existing = await this.transactions.byOperation(ctx, reversalOp);
    if (existing) return { event: existing, duplicate: true };
    try {
      const event = await this.database.transaction((session) =>
        this.reverseIn(ctx, id, { ...opts, operationId: reversalOp }, session),
      );
      return { event, duplicate: false };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const first = await this.transactions.byOperation(ctx, reversalOp);
      if (!first) throw e;
      return { event: first, duplicate: true };
    }
  }

  /** "Edit" of amount, date, account or category: a reversal plus the corrected event, in one transaction. */
  async correct(
    ctx: WorkspaceContext,
    id: string,
    input: EventInput,
    opts: PostOptions & { baseVersion?: number | null },
  ): Promise<CorrectResult> {
    const existing = await this.transactions.byOperation(ctx, opts.operationId);
    if (existing) {
      const reversal = await this.transactions.byOperation(ctx, opts.operationId + REVERSAL_SUFFIX);
      return { reversal: reversal!, event: existing, duplicate: true };
    }
    return this.database.transaction(async (session) => {
      const reversal = await this.reverseIn(
        ctx,
        id,
        { ...opts, operationId: opts.operationId + REVERSAL_SUFFIX },
        session,
      );
      const corrected = await this.postIn(ctx, input, opts, session);
      const linked = await this.transactions.findOneAndUpdate(
        ctx,
        { _id: corrected._id },
        { $set: { 'links.correctionOf': id } },
        { session },
      );
      return { reversal, event: linked!, duplicate: false };
    });
  }

  async reverseIn(
    ctx: WorkspaceContext,
    id: string,
    opts: PostOptions & { baseVersion?: number | null },
    session: ClientSession,
  ): Promise<TransactionDoc> {
    const original = await this.transactions.byId(ctx, id, { session });
    if (!original) throw LedgerErrors.notFoundEvent();
    if (original.type === 'reversal') throw LedgerErrors.notCorrectable();
    if (original.status !== 'posted' || (opts.baseVersion != null && opts.baseVersion !== original.version)) {
      throw LedgerErrors.alreadyChanged(original);
    }
    if (original.reconciliationId) throw LedgerErrors.locked();
    if (original.type === 'expense' && (await this.transactions.refundedAgainst(ctx, id, { session })) > 0n) {
      throw LedgerErrors.hasRefunds();
    }
    const now = this.now();
    const reversalId = this.idFor(opts.operationId);
    const marked = await this.transactions.markReversed(ctx, id, reversalId, original.version, now, { session });
    if (!marked) throw LedgerErrors.alreadyChanged(original);
    const lines = buildReversal(original.lines);
    const known = await this.accounts.byIds(ctx, [...new Set(lines.map((l) => l.ledgerAccountId))], { session });
    const byId = new Map(known.map((a) => [a._id, toRef(a)]));
    checkLines('reversal', lines, (x) => byId.get(x) ?? null);
    const reversal: Omit<TransactionDoc, 'workspaceId'> = {
      ...original,
      _id: reversalId,
      operationId: opts.operationId,
      type: 'reversal',
      status: 'posted',
      recordedAt: now,
      recordedBy: { userId: ctx.userId, deviceId: opts.deviceId ?? null },
      receiptFileIds: [],
      lines,
      links: { reversalOf: id },
      reconciliationId: null,
      clearedAccountIds: [],
      importId: opts.importId ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const [doc] = await this.write(ctx, [reversal], [id], session);
    return doc!;
  }

  /** Notes, tags, payee and receipts change in place, with an audit entry (TECH-SPEC 6.3). */
  async patch(
    ctx: WorkspaceContext,
    id: string,
    patch: EventPatch,
    baseVersion: number | null,
  ): Promise<TransactionDoc> {
    return this.database.transaction(async (session) => {
      const before = await this.transactions.byId(ctx, id, { session });
      if (!before) throw LedgerErrors.notFoundEvent();
      if (baseVersion !== null && baseVersion !== before.version) throw LedgerErrors.alreadyChanged(before);
      const set: Partial<TransactionDoc> = { updatedAt: this.now() };
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.tagIds !== undefined) set.tagIds = [...new Set(patch.tagIds)];
      if (patch.payeeId !== undefined) set.payeeId = patch.payeeId;
      if (patch.receiptFileIds !== undefined) set.receiptFileIds = [...new Set(patch.receiptFileIds)];
      const after = await this.transactions.findOneAndUpdate(
        ctx,
        { _id: id, version: before.version },
        { $set: set, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw LedgerErrors.alreadyChanged(before);
      await this.feed(ctx, [{ collection: 'transactions', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        {
          action: 'transaction.updated',
          target: { collection: 'transactions', id },
          before: {
            notes: before.notes,
            tagIds: before.tagIds,
            payeeId: before.payeeId,
            receiptFileIds: before.receiptFileIds,
          },
          after: {
            notes: after.notes,
            tagIds: after.tagIds,
            payeeId: after.payeeId,
            receiptFileIds: after.receiptFileIds,
          },
        },
        { session },
      );
      return after;
    });
  }

  /**
   * Sets payee or tags on many events in place (payee merge, tag delete), with one feed entry each and
   * one audit entry. Returns the ids changed.
   */
  async patchMany(
    ctx: WorkspaceContext,
    filter: { ids?: string[]; payeeIds?: string[]; tagId?: string },
    change: { payeeId?: string | null; pullTagId?: string },
    action: string,
    session: ClientSession,
  ): Promise<string[]> {
    const f: Record<string, unknown> = {};
    if (filter.ids) f._id = { $in: filter.ids };
    if (filter.payeeIds) f.payeeId = { $in: filter.payeeIds };
    if (filter.tagId) f.tagIds = filter.tagId;
    const ids = (await this.transactions.find(ctx, f as never, { session, projection: { _id: 1 } })).map((e) => e._id);
    if (ids.length === 0) return [];
    const update: Record<string, unknown> = { $set: { updatedAt: this.now() }, $inc: { version: 1 } };
    if (change.payeeId !== undefined) (update.$set as Record<string, unknown>).payeeId = change.payeeId;
    if (change.pullTagId) update.$pull = { tagIds: change.pullTagId };
    await this.transactions.updateMany(ctx, { _id: { $in: ids } }, update as never, { session });
    await this.feed(
      ctx,
      ids.map((docId) => ({ collection: 'transactions', docId, op: 'upsert' as const })),
      session,
    );
    await this.audit.record(ctx, { action, after: { transactions: ids.length, ...change } }, { session });
    return ids;
  }

  /** Steps 5 to 8 of `postEvent`: insert, balances, period totals, change feed, audit. */
  private async write(
    ctx: WorkspaceContext,
    events: Omit<TransactionDoc, 'workspaceId'>[],
    alsoChanged: string[],
    session: ClientSession,
  ): Promise<TransactionDoc[]> {
    const now = this.now();
    const out: TransactionDoc[] = [];
    for (const e of events) {
      const doc = await this.transactions.insertOne(ctx, e, { session });
      const month = monthOf(e.date);
      const countDelta = e.type === 'reversal' ? -1 : 1;
      const counted = new Set<string>();
      for (const l of e.lines) {
        await this.balances.add(ctx, l, now, { session });
        const key = `${l.ledgerAccountId}:${l.currency}`;
        await this.totals.add(ctx, l, month, counted.has(key) ? 0 : countDelta, { session });
        counted.add(key);
      }
      await this.audit.record(
        ctx,
        {
          action: e.type === 'reversal' ? 'transaction.reversed' : 'transaction.posted',
          target: { collection: 'transactions', id: e._id },
          after: summary(doc),
        },
        { session },
      );
      out.push(doc);
    }
    await this.feed(
      ctx,
      [...alsoChanged, ...events.map((e) => e._id)].map((docId) => ({
        collection: 'transactions',
        docId,
        op: 'upsert' as const,
      })),
      session,
    );
    return out;
  }

  /** Adds changes to the sync feed in the caller's transaction (TECH-SPEC 5.7). */
  async feed(
    ctx: WorkspaceContext,
    items: { collection: string; docId: string; op: 'upsert' | 'tombstone' }[],
    session: ClientSession,
  ) {
    const first = await this.counters.take(ctx, items.length, { session });
    await this.changes.record(ctx, first, items, this.now(), { session });
  }

  /** Loads every account the input can touch, so the builders stay pure and synchronous. */
  private async resolverFor(
    ctx: WorkspaceContext,
    input: EventInput,
    session: ClientSession,
  ): Promise<Resolver & { any(id: string): AccountRef | null }> {
    const realIds = new Set<string>();
    const categoryIds = new Set<string>();
    let original: TransactionDoc | null = null;
    let refunded = 0n;
    switch (input.type) {
      case 'transfer':
        realIds.add(input.fromAccountId).add(input.toAccountId);
        break;
      case 'expense':
        realIds.add(input.accountId);
        if (input.categoryId) categoryIds.add(input.categoryId);
        for (const p of input.splits ?? []) categoryIds.add(p.categoryId);
        break;
      case 'income':
        realIds.add(input.accountId);
        categoryIds.add(input.categoryId);
        break;
      case 'refund':
        realIds.add(input.accountId);
        original = await this.transactions.byId(ctx, input.refundOf, { session });
        if (original) {
          for (const l of original.lines) if (l.categoryId) categoryIds.add(l.categoryId);
          refunded = await this.transactions.refundedAgainst(ctx, original._id, { session });
        }
        break;
      case 'opening_balance':
      case 'balance_adjustment':
        realIds.add(input.accountId);
        break;
      case 'loan_proceeds':
        realIds.add(input.accountId).add(input.loanAccountId);
        break;
      case 'loan_repayment':
        realIds.add(input.accountId).add(input.loanAccountId);
        break;
      case 'lend':
      case 'collect':
        realIds.add(input.accountId).add(input.receivableAccountId);
        break;
      case 'write_off':
        realIds.add(input.receivableAccountId);
        break;
      case 'salary_gross':
        realIds.add(input.accountId).add(input.pensionAccountId).add(input.nhfAccountId);
        categoryIds.add(input.categoryId);
        break;
      case 'investment_buy':
      case 'investment_sell':
        realIds.add(input.holdingAccountId).add(input.cashAccountId);
        break;
    }
    // One session can run only one operation at a time, so these run in turn.
    const reals = await this.accounts.byIds(ctx, [...realIds], { session });
    const cats = categoryIds.size ? await this.accounts.byCategories(ctx, [...categoryIds], { session }) : [];
    const system = await this.accounts.system(ctx, { session });
    const byId = new Map<string, AccountRef>();
    const byCategory = new Map<string, AccountRef>();
    const bySystem = new Map<SystemKey, AccountRef>();
    for (const a of [...reals, ...cats, ...system]) byId.set(a._id, toRef(a));
    for (const a of cats) if (a.categoryId) byCategory.set(a.categoryId, toRef(a));
    for (const a of system) if (a.systemKey) bySystem.set(a.systemKey, toRef(a));
    return {
      account: (id) => (realIds.has(id) ? (byId.get(id) ?? null) : null),
      category: (id) => byCategory.get(id) ?? null,
      system: (key) => {
        const a = bySystem.get(key);
        if (!a) throw new Error(`system account ${key} missing`);
        return a;
      },
      original: (id) =>
        original && original._id === id
          ? { type: original.type, status: original.status, lines: original.lines, refunded }
          : null,
      any: (id) => byId.get(id) ?? null,
    };
  }
}

function blankAccount(
  kind: LedgerKind,
  name: string,
  currency: string,
  now: Date,
): Omit<LedgerAccountDoc, 'workspaceId'> {
  return {
    _id: newId(),
    kind,
    name,
    currency,
    systemKey: null,
    categoryId: null,
    accountType: null,
    institution: null,
    last4: null,
    onBudget: true,
    archivedAt: null,
    sortOrder: 0,
    operationId: null,
    personDebt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

/** The audit "after" of a money event: what it did, with amounts as strings. */
function summary(e: TransactionDoc) {
  return {
    type: e.type,
    date: e.date,
    lines: e.lines.map((l: Line) => ({
      ledgerAccountId: l.ledgerAccountId,
      amountMinor: toMinorString(l.amountMinor),
      currency: l.currency,
    })),
    links: e.links,
  };
}

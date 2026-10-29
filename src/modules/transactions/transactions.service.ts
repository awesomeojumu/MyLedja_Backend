import type { ClientSession, Db } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors, MESSAGES } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { parseMinor, toMinorString } from '../../common/money/money.js';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { CategoriesRepository, PayeesRepository } from '../categories/categories.repository.js';
import { decodeCursor, encodeCursor } from '../categories/categories.service.js';
import { inputOf } from '../ledger/input-of.js';
import { LedgerErrors } from '../ledger/ledger.errors.js';
import type { EventInput } from '../ledger/ledger.inputs.js';
import { type LedgerAccountDoc, toRef, type TransactionDoc } from '../ledger/ledger.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { AccountRef, Line } from '../ledger/ledger.types.js';
import type {
  BulkBody,
  BulkResult,
  CorrectBody,
  Corrected,
  CreateTransactionBody,
  LinkTransferBody,
  ReverseBody,
  Transaction,
  TransactionDetail,
  TransactionPage,
  TransactionQuery,
  TransferSuggestion,
  UpdateTransactionBody,
} from './transactions.contract.js';

type Doc = TransactionDoc;
type TxView = z.input<typeof Transaction>;
type AccountMap = Map<string, AccountRef & { accountType: string | null }>;

/** Your own accounts. A holding's ledger account isn't one: its lines point at the holding (links.holdingId). */
const isReal = (a: AccountRef | null | undefined) =>
  !!a && (a.kind === 'asset' || a.kind === 'liability') && a.systemKey === null && !a.holding;

export type TransferDismissalDoc = {
  _id: string;
  workspaceId: string;
  outId: string;
  inId: string;
  createdAt: Date;
  createdBy: string | null;
};

export class TransferDismissalsRepository extends BaseRepository<TransferDismissalDoc> {
  constructor(db: Db) {
    super(db, 'transfer_dismissals');
  }
}

/** People's money movements (build plan B1.8): list, post, correct, reverse, bulk and transfer matching. */
export class TransactionsService {
  /** Set by `buildServices` once reconcile exists, so unlock can update that history. */
  onUnlock:
    | ((
        ctx: WorkspaceContext,
        reconciliationId: string,
        transactionId: string,
        session: ClientSession,
      ) => Promise<void>)
    | null = null;

  constructor(
    private readonly database: Database,
    private readonly ledger: LedgerService,
    private readonly dismissals: TransferDismissalsRepository,
    private readonly categories: CategoriesRepository,
    private readonly payees: PayeesRepository,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    ctx: WorkspaceContext,
    query: z.output<typeof TransactionQuery>,
  ): Promise<z.input<typeof TransactionPage>> {
    const filter = await this.matchFilter(ctx, query);
    if (query.cursor) {
      const [date, id] = decodeCursor(query.cursor);
      filter.$and = [
        ...((filter.$and as object[] | undefined) ?? []),
        { $or: [{ date: { $lt: date } }, { date, _id: { $lt: id } }] },
      ];
    }
    // Over-fetch when filtering by headline size, which isn't stored as a field.
    const needSize = query.minAmount !== undefined || query.maxAmount !== undefined;
    const fetch = needSize ? Math.max(query.limit * 5, 100) : query.limit + 1;
    const docs = await this.ledger.transactions.find(ctx, filter as never, {
      sort: { date: -1, _id: -1 },
      limit: fetch,
    });
    const accounts = await this.accountMap(ctx, docs);
    const min = query.minAmount !== undefined ? absMinor(query.minAmount) : null;
    const max = query.maxAmount !== undefined ? absMinor(query.maxAmount) : null;
    const matched = docs.filter((d) => {
      if (min === null && max === null) return true;
      const size = abs(headline(d, realLines(d, accounts), accounts));
      if (min !== null && size < min) return false;
      if (max !== null && size > max) return false;
      return true;
    });
    const page = matched.slice(0, query.limit);
    const singleAccount = query.accountId?.length === 1 ? (query.accountId[0] as string) : null;
    const running = singleAccount ? await this.runningBalances(ctx, singleAccount, page, accounts) : null;
    const hasMore = matched.length > query.limit || (needSize && docs.length === fetch);
    return {
      items: page.map((d) => this.view(d, accounts, running?.get(d._id) ?? null)),
      nextCursor: hasMore && page.length ? encodeCursor([page.at(-1)!.date, page.at(-1)!._id]) : null,
    };
  }

  async get(ctx: WorkspaceContext, id: string): Promise<z.input<typeof TransactionDetail>> {
    const doc = await this.require(ctx, id);
    const chain = await this.historyChain(ctx, doc);
    const refunds = await this.ledger.transactions.find(
      ctx,
      { 'links.refundOf': id, status: 'posted', type: 'refund' },
      { sort: { date: 1, _id: 1 } },
    );
    const accounts = await this.accountMap(ctx, [...chain, ...refunds, doc]);
    return {
      transaction: this.view(doc, accounts),
      history: chain.map((d) => this.view(d, accounts)),
      refunds: refunds.map((d) => this.view(d, accounts)),
      refundable: toMinorString(await this.refundableOf(ctx, doc)),
    };
  }

  async create(
    ctx: WorkspaceContext,
    body: z.output<typeof CreateTransactionBody>,
    operationId: string,
    deviceId: string | null = null,
  ): Promise<TxView> {
    const { event } = await this.ledger.post(ctx, body as EventInput, { operationId, deviceId });
    return this.viewOf(ctx, event);
  }

  async update(ctx: WorkspaceContext, id: string, body: z.output<typeof UpdateTransactionBody>): Promise<TxView> {
    const { baseVersion, ...patch } = body;
    try {
      const after = await this.ledger.patch(ctx, id, patch, baseVersion);
      return this.viewOf(ctx, after);
    } catch (e) {
      throw await this.withCurrent(ctx, e);
    }
  }

  async correct(
    ctx: WorkspaceContext,
    id: string,
    body: z.output<typeof CorrectBody>,
    operationId: string,
    deviceId: string | null = null,
  ): Promise<z.input<typeof Corrected>> {
    try {
      const { event, reversal } = await this.ledger.correct(ctx, id, body.input as EventInput, {
        operationId,
        deviceId,
        baseVersion: body.baseVersion,
      });
      const accounts = await this.accountMap(ctx, [event, reversal]);
      return { transaction: this.view(event, accounts), reversal: this.view(reversal, accounts) };
    } catch (e) {
      throw await this.withCurrent(ctx, e);
    }
  }

  async reverse(
    ctx: WorkspaceContext,
    id: string,
    body: z.output<typeof ReverseBody>,
    operationId: string,
    deviceId: string | null = null,
  ): Promise<TxView> {
    try {
      const { event } = await this.ledger.reverse(ctx, id, {
        operationId,
        deviceId,
        baseVersion: body.baseVersion,
      });
      return this.viewOf(ctx, event);
    } catch (e) {
      throw await this.withCurrent(ctx, e);
    }
  }

  /** Clears the reconcile lock so the transaction can change (DESIGN.md page 10). */
  async unlock(ctx: WorkspaceContext, id: string): Promise<TxView> {
    return this.database.transaction(async (session) => {
      const before = await this.ledger.transactions.byId(ctx, id, { session });
      if (!before) throw LedgerErrors.notFoundEvent();
      if (!before.reconciliationId) return this.viewOf(ctx, before);
      const after = await this.ledger.transactions.findOneAndUpdate(
        ctx,
        { _id: id, reconciliationId: before.reconciliationId },
        { $set: { reconciliationId: null, updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw LedgerErrors.notFoundEvent();
      if (this.onUnlock) await this.onUnlock(ctx, before.reconciliationId, id, session);
      await this.ledger.feed(ctx, [{ collection: 'transactions', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        {
          action: 'transaction.unlocked',
          target: { collection: 'transactions', id },
          after: { reconciliationId: before.reconciliationId },
        },
        { session },
      );
      return this.viewOf(ctx, after);
    });
  }

  async bulk(
    ctx: WorkspaceContext,
    body: z.output<typeof BulkBody>,
    operationId: string,
  ): Promise<z.input<typeof BulkResult>> {
    const results: z.input<typeof BulkResult>['results'] = [];
    for (const [i, transactionId] of body.transactionIds.entries()) {
      try {
        const r = await this.bulkOne(ctx, transactionId, body.action, `${operationId}:${i}`);
        results.push(r);
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError(500, 'server_error', MESSAGES.serverError);
        results.push({
          transactionId,
          status: 'refused',
          transaction: null,
          error: { code: err.code, message: err.userMessage },
        });
      }
    }
    return { results };
  }

  async transferSuggestions(ctx: WorkspaceContext): Promise<{ suggestions: z.input<typeof TransferSuggestion>[] }> {
    const live = await this.ledger.transactions.find(
      ctx,
      { status: 'posted', type: { $in: ['income', 'expense', 'refund', 'opening_balance', 'balance_adjustment'] } },
      { sort: { date: 1, _id: 1 } },
    );
    const accounts = await this.accountMap(ctx, live);
    const dismissed = await this.dismissals.find(ctx, {});
    const skip = new Set(dismissed.map((d) => pairKey(d.outId, d.inId)));
    const outs: { doc: Doc; accountId: string; amount: bigint }[] = [];
    const ins: { doc: Doc; accountId: string; amount: bigint }[] = [];
    for (const d of live) {
      const real = d.lines.filter((l) => isReal(accounts.get(l.ledgerAccountId) ?? null));
      if (real.length !== 1) continue;
      const line = real[0]!;
      const shown = effectOnAccount(line, accounts.get(line.ledgerAccountId)!);
      if (shown < 0n) outs.push({ doc: d, accountId: line.ledgerAccountId, amount: -shown });
      if (shown > 0n) ins.push({ doc: d, accountId: line.ledgerAccountId, amount: shown });
    }
    const suggestions: z.input<typeof TransferSuggestion>[] = [];
    for (const out of outs) {
      for (const inn of ins) {
        if (out.accountId === inn.accountId) continue;
        if (out.amount !== inn.amount) continue;
        if (skip.has(pairKey(out.doc._id, inn.doc._id))) continue;
        const days = daysApart(out.doc.date, inn.doc.date);
        if (days > 3) continue;
        suggestions.push({
          out: this.view(out.doc, accounts),
          in: this.view(inn.doc, accounts),
          amount: toMinorString(out.amount),
          daysApart: days,
        });
      }
    }
    return { suggestions };
  }

  async linkTransfer(
    ctx: WorkspaceContext,
    body: z.output<typeof LinkTransferBody>,
    operationId: string,
  ): Promise<TxView> {
    return this.database.transaction(async (session) => {
      const out = await this.require(ctx, body.outId, session);
      const inn = await this.require(ctx, body.inId, session);
      const accounts = await this.accountMap(ctx, [out, inn], session);
      const outReal = out.lines.filter((l) => isReal(accounts.get(l.ledgerAccountId) ?? null));
      const inReal = inn.lines.filter((l) => isReal(accounts.get(l.ledgerAccountId) ?? null));
      if (outReal.length !== 1 || inReal.length !== 1) {
        throw Errors.validation('outId', 'Pick one money-out and one money-in transaction.');
      }
      const fromId = outReal[0]!.ledgerAccountId;
      const toId = inReal[0]!.ledgerAccountId;
      if (fromId === toId) throw Errors.validation('inId', 'A transfer needs two different accounts.');
      const amount = -effectOnAccount(outReal[0]!, accounts.get(fromId)!);
      if (amount <= 0n) throw Errors.validation('outId', 'The first transaction must be money leaving an account.');
      const inAmt = effectOnAccount(inReal[0]!, accounts.get(toId)!);
      if (inAmt <= 0n) throw Errors.validation('inId', 'The second transaction must be money arriving.');
      await this.ledger.reverseIn(
        ctx,
        out._id,
        { operationId: `${operationId}:out`, baseVersion: out.version },
        session,
      );
      await this.ledger.reverseIn(
        ctx,
        inn._id,
        { operationId: `${operationId}:in`, baseVersion: inn.version },
        session,
      );
      const from = accounts.get(fromId)!;
      const to = accounts.get(toId)!;
      const input: EventInput = {
        type: 'transfer',
        fromAccountId: fromId,
        toAccountId: toId,
        amount: toMinorString(amount),
        ...(from.currency !== to.currency ? { toAmount: toMinorString(inAmt) } : {}),
        date: out.date,
        notes: out.notes ?? inn.notes,
        payeeId: out.payeeId ?? inn.payeeId,
        tagIds: [...new Set([...out.tagIds, ...inn.tagIds])],
      };
      const event = await this.ledger.postIn(ctx, input, { operationId }, session);
      return this.viewOf(ctx, event);
    });
  }

  async dismissTransfer(ctx: WorkspaceContext, body: z.output<typeof LinkTransferBody>): Promise<void> {
    await this.dismissals.insertOne(ctx, {
      _id: newId(),
      outId: body.outId,
      inId: body.inId,
      createdAt: this.now(),
      createdBy: ctx.userId,
    });
  }

  // --- internals ---

  private async bulkOne(
    ctx: WorkspaceContext,
    id: string,
    action: z.output<typeof BulkBody>['action'],
    operationId: string,
  ): Promise<z.input<typeof BulkResult>['results'][number]> {
    const before = await this.require(ctx, id);
    switch (action.kind) {
      case 'delete': {
        const { event } = await this.ledger.reverse(ctx, id, {
          operationId,
          baseVersion: before.version,
        });
        return { transactionId: id, status: 'changed', transaction: await this.viewOf(ctx, event), error: null };
      }
      case 'add_tag': {
        if (before.tagIds.includes(action.tagId))
          return { transactionId: id, status: 'unchanged', transaction: await this.viewOf(ctx, before), error: null };
        const after = await this.ledger.patch(ctx, id, { tagIds: [...before.tagIds, action.tagId] }, before.version);
        return { transactionId: id, status: 'changed', transaction: await this.viewOf(ctx, after), error: null };
      }
      case 'remove_tag': {
        if (!before.tagIds.includes(action.tagId))
          return { transactionId: id, status: 'unchanged', transaction: await this.viewOf(ctx, before), error: null };
        const after = await this.ledger.patch(
          ctx,
          id,
          { tagIds: before.tagIds.filter((t) => t !== action.tagId) },
          before.version,
        );
        return { transactionId: id, status: 'changed', transaction: await this.viewOf(ctx, after), error: null };
      }
      case 'set_payee': {
        if (before.payeeId === action.payeeId)
          return { transactionId: id, status: 'unchanged', transaction: await this.viewOf(ctx, before), error: null };
        const after = await this.ledger.patch(ctx, id, { payeeId: action.payeeId }, before.version);
        return { transactionId: id, status: 'changed', transaction: await this.viewOf(ctx, after), error: null };
      }
      case 'categorize': {
        const accounts = await this.accountMap(ctx, [before]);
        const input = inputOf(before, (x) => accounts.get(x) ?? null);
        if (!input || (input.type !== 'expense' && input.type !== 'income' && input.type !== 'refund')) {
          throw new AppError(400, 'not_categorisable', "This transaction doesn't have a category to change.");
        }
        const next: EventInput =
          input.type === 'expense'
            ? { ...input, categoryId: action.categoryId, splits: undefined }
            : { ...input, categoryId: action.categoryId };
        if (input.type === 'expense' && input.categoryId === action.categoryId && !input.splits) {
          return { transactionId: id, status: 'unchanged', transaction: await this.viewOf(ctx, before), error: null };
        }
        if ((input.type === 'income' || input.type === 'refund') && input.categoryId === action.categoryId) {
          return { transactionId: id, status: 'unchanged', transaction: await this.viewOf(ctx, before), error: null };
        }
        const { event } = await this.ledger.correct(ctx, id, next, {
          operationId,
          baseVersion: before.version,
        });
        return { transactionId: id, status: 'changed', transaction: await this.viewOf(ctx, event), error: null };
      }
    }
  }

  private async matchFilter(ctx: WorkspaceContext, q: z.output<typeof TransactionQuery>) {
    const filter: Record<string, unknown> = {};
    const and: Record<string, unknown>[] = [];
    if (q.status === 'live') {
      filter.status = 'posted';
      filter.type = { $ne: 'reversal' };
    }
    if (q.from || q.to) {
      filter.date = {
        ...(q.from ? { $gte: q.from } : {}),
        ...(q.to ? { $lte: q.to } : {}),
      };
    }
    if (q.accountId?.length) filter['lines.ledgerAccountId'] = { $in: q.accountId };
    if (q.categoryId?.length) filter['lines.categoryId'] = { $in: q.categoryId };
    if (q.payeeId?.length) filter.payeeId = { $in: q.payeeId };
    if (q.tagId?.length) filter.tagIds = { $in: q.tagId };
    if (q.type?.length) {
      const types = q.status === 'live' ? q.type.filter((t) => t !== 'reversal') : q.type;
      filter.type = { $in: types };
    }
    if (q.uncategorized === 'true') {
      const starters = await this.categories.find(ctx, {
        starterKey: { $in: ['uncategorized', 'other_income'] },
        deletedAt: null,
      } as never);
      and.push({ 'lines.categoryId': { $in: starters.map((c) => c._id) } });
    }
    if (q.q) {
      const re = new RegExp(escapeRegex(q.q.trim()), 'i');
      const or: Record<string, unknown>[] = [{ notes: re }];
      const digits = q.q.replace(/[^\d-]/g, '');
      const amount = digits ? parseMinorSafe(digits) : null;
      if (amount !== null) or.push({ 'lines.amountMinor': amount }, { 'lines.amountMinor': -amount });
      const payees = await this.payees.find(ctx, { name: re, mergedInto: null } as never);
      if (payees.length) or.push({ payeeId: { $in: payees.map((p) => p._id) } });
      const cats = await this.categories.find(ctx, { name: re, deletedAt: null } as never);
      if (cats.length) or.push({ 'lines.categoryId': { $in: cats.map((c) => c._id) } });
      and.push({ $or: or });
    }
    if (and.length) filter.$and = and;
    return filter;
  }

  private async runningBalances(
    ctx: WorkspaceContext,
    accountId: string,
    page: Doc[],
    accounts: AccountMap,
  ): Promise<Map<string, string>> {
    const [bal] = await this.ledger.balances.find(ctx, { ledgerAccountId: accountId });
    const acct = accounts.get(accountId) ?? toAccountRef(await this.ledger.accounts.findOne(ctx, { _id: accountId }));
    let raw = BigInt(bal?.balanceMinor ?? 0n);
    const out = new Map<string, string>();
    // Page is newest-first; walking it and peeling each txn's effect yields the balance after that txn.
    for (const d of page) {
      const shown = acct ? shownOf(acct.kind as 'asset' | 'liability', raw) : raw;
      out.set(d._id, toMinorString(shown));
      for (const l of d.lines) {
        if (l.ledgerAccountId === accountId) raw -= l.amountMinor;
      }
    }
    return out;
  }

  private async historyChain(ctx: WorkspaceContext, doc: Doc): Promise<Doc[]> {
    const out: Doc[] = [];
    let cursor: Doc | null = doc;
    const seen = new Set<string>();
    while (cursor?.links.correctionOf && !seen.has(cursor.links.correctionOf)) {
      seen.add(cursor.links.correctionOf);
      const prev = await this.ledger.transactions.byId(ctx, cursor.links.correctionOf);
      if (!prev) break;
      out.unshift(prev);
      if (prev.links.reversedBy) {
        const rev = await this.ledger.transactions.byId(ctx, prev.links.reversedBy);
        if (rev) out.push(rev);
      }
      cursor = prev;
    }
    return out;
  }

  private async refundableOf(ctx: WorkspaceContext, doc: Doc): Promise<bigint> {
    if (doc.type !== 'expense' || doc.status !== 'posted') return 0n;
    const cost = doc.lines.filter((l) => l.amountMinor > 0n).reduce((s, l) => s + l.amountMinor, 0n);
    const refunded = await this.ledger.transactions.refundedAgainst(ctx, doc._id);
    const left = cost - refunded;
    return left > 0n ? left : 0n;
  }

  private async require(ctx: WorkspaceContext, id: string, session?: ClientSession): Promise<Doc> {
    const doc = await this.ledger.transactions.byId(ctx, id, { session });
    if (!doc) throw LedgerErrors.notFoundEvent();
    return doc;
  }

  private async withCurrent(ctx: WorkspaceContext, e: unknown): Promise<never> {
    if (e instanceof AppError && e.code === 'already_changed' && e.extra && 'current' in e.extra) {
      const cur = e.extra.current as Doc;
      throw LedgerErrors.alreadyChanged(await this.viewOf(ctx, cur));
    }
    throw e;
  }

  private async viewOf(ctx: WorkspaceContext, doc: Doc): Promise<TxView> {
    return this.view(doc, await this.accountMap(ctx, [doc]));
  }

  private async accountMap(ctx: WorkspaceContext, docs: Doc[], session?: ClientSession): Promise<AccountMap> {
    const ids = new Set<string>();
    for (const d of docs) for (const l of d.lines) ids.add(l.ledgerAccountId);
    if (ids.size === 0) return new Map();
    const rows = await this.ledger.accounts.byIds(ctx, [...ids], { session });
    return new Map(rows.map((a) => [a._id, { ...toRef(a), accountType: a.accountType }]));
  }

  view(doc: Doc, accounts: AccountMap, runningBalance: string | null = null): TxView {
    const real = doc.lines.filter((l) => isReal(accounts.get(l.ledgerAccountId) ?? null));
    const cats = [...new Set(doc.lines.map((l) => l.categoryId).filter((x): x is string => typeof x === 'string'))];
    const accountIds = accountOrder(doc, real, accounts);
    return {
      id: doc._id,
      type: doc.type,
      status: doc.status,
      date: doc.date,
      amount: toMinorString(headline(doc, real, accounts)),
      accountIds,
      categoryIds: cats,
      payeeId: doc.payeeId,
      notes: doc.notes,
      tagIds: doc.tagIds,
      receiptFileIds: doc.receiptFileIds,
      lines: doc.lines.map((l) => {
        const a = accounts.get(l.ledgerAccountId);
        return {
          ledgerAccountId: l.ledgerAccountId,
          accountId: isReal(a) ? l.ledgerAccountId : null,
          categoryId: l.categoryId ?? null,
          system: a?.systemKey ?? null,
          amount: toMinorString(l.amountMinor),
          currency: l.currency,
        };
      }),
      links: {
        refundOf: doc.links.refundOf ?? null,
        reversalOf: doc.links.reversalOf ?? null,
        reversedBy: doc.links.reversedBy ?? null,
        correctionOf: doc.links.correctionOf ?? null,
        goalId: doc.links.goalId ?? null,
        debtId: doc.links.debtId ?? null,
        scheduleId: doc.links.scheduleId ?? null,
        holdingId: doc.links.holdingId ?? null,
      },
      fxRate: doc.fxRate ? String(doc.fxRate) : null,
      investment: doc.investment
        ? {
            kind: doc.investment.kind,
            units: 'units' in doc.investment ? doc.investment.units : null,
            price: 'price' in doc.investment ? doc.investment.price : null,
            fees: 'fees' in doc.investment ? doc.investment.fees : null,
            lots: 'lots' in doc.investment ? doc.investment.lots : null,
          }
        : null,
      edited: !!doc.links.correctionOf,
      reconciled: doc.reconciliationId !== null,
      reconciliationId: doc.reconciliationId,
      clearedAccountIds: doc.clearedAccountIds,
      importId: doc.importId,
      runningBalance,
      recordedAt: doc.recordedAt.toISOString(),
      version: doc.version,
    };
  }
}

function headline(doc: Doc, real: Line[], accounts: AccountMap): bigint {
  if (doc.type === 'transfer') {
    const from = real.find((l) => l.amountMinor < 0n);
    return from ? -from.amountMinor : 0n;
  }
  if (real.length === 1) {
    const a = accounts.get(real[0]!.ledgerAccountId)!;
    return effectOnAccount(real[0]!, a);
  }
  // A reinvested dividend touches only its holding: the headline is what it added.
  if (real.length === 0 && doc.links.holdingId) {
    return doc.lines.find((l) => l.ledgerAccountId === doc.links.holdingId)?.amountMinor ?? 0n;
  }
  // Fallback: net on real accounts (should be rare for Phase 1 types).
  return real.reduce((s, l) => s + effectOnAccount(l, accounts.get(l.ledgerAccountId)!), 0n);
}

function effectOnAccount(line: Line, a: AccountRef): bigint {
  // Asset: debit raises what you have. Liability: credit raises what you owe (shown positive).
  return a.kind === 'liability' ? -line.amountMinor : line.amountMinor;
}

function shownOf(kind: 'asset' | 'liability', raw: bigint) {
  return kind === 'liability' ? -raw : raw;
}

function accountOrder(doc: Doc, real: Line[], _accounts: AccountMap): string[] {
  if (doc.type === 'transfer') {
    const from = real.find((l) => l.amountMinor < 0n);
    const to = real.find((l) => l.amountMinor > 0n);
    return [from?.ledgerAccountId, to?.ledgerAccountId].filter((x): x is string => !!x);
  }
  return real.map((l) => l.ledgerAccountId);
}

function daysApart(a: string, b: string) {
  const ms = Math.abs(Date.parse(a) - Date.parse(b));
  return Math.round(ms / 86_400_000);
}

const pairKey = (a: string, b: string) => `${a}:${b}`;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const abs = (n: bigint) => (n < 0n ? -n : n);
const absMinor = (s: string) => abs(parseMinor(s));
const realLines = (d: Doc, accounts: AccountMap) =>
  d.lines.filter((l) => isReal(accounts.get(l.ledgerAccountId) ?? null));

function parseMinorSafe(digits: string): bigint | null {
  try {
    const cleaned = digits.replace(/^-/, '').replace(/^0+/, '') || '0';
    if (cleaned === '0') return 0n;
    return parseMinor(cleaned);
  } catch {
    return null;
  }
}

function toAccountRef(a: LedgerAccountDoc | null): (AccountRef & { accountType: string | null }) | null {
  if (!a) return null;
  return { ...toRef(a), accountType: a.accountType };
}

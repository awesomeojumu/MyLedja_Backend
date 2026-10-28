import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { parseMinor, toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AccountsService } from '../accounts/accounts.service.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { shownBalance } from '../ledger/read.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import type { Reconciliation, ReconcileView } from './reconcile.contract.js';
import { type ReconciliationDoc, type ReconciliationsRepository } from './reconcile.repository.js';

export const ReconcileErrors = {
  notInProgress: () => new AppError(409, 'not_in_progress', 'This reconcile is already finished or cancelled.'),
  notBalanced: () =>
    new AppError(409, 'not_balanced', "The difference isn't \u20a60.00. Tick more, or finish with an adjustment."),
};

/** Account reconcile against a statement (build plan B1.13, DESIGN.md page 10). */
export class ReconcileService {
  constructor(
    private readonly database: Database,
    private readonly repos: ReconciliationsRepository,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsService,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(
    ctx: WorkspaceContext,
    accountId: string,
    body: { id?: string; statementDate: string; statementBalance: string },
  ): Promise<z.input<typeof ReconcileView>> {
    const existing = await this.repos.inProgress(ctx, accountId);
    if (existing) return this.view(ctx, existing);
    await this.accounts.real(ctx, accountId);
    const doc = await this.database.transaction(async (session) => {
      if (body.id) {
        const same = await this.repos.byId(ctx, body.id, { session });
        if (same) return same;
      }
      const again = await this.repos.inProgress(ctx, accountId, { session });
      if (again) return again;
      const now = this.now();
      const created = await this.repos.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          accountId,
          status: 'in_progress',
          statementDate: body.statementDate,
          statementBalanceMinor: body.statementBalance,
          tickedIds: [],
          adjustmentId: null,
          finishedAt: null,
          finishedBy: null,
          unlocked: [],
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'reconciliations', docId: created._id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: 'reconcile.started', target: { collection: 'reconciliations', id: created._id } },
        { session },
      );
      return created;
    });
    return this.view(ctx, doc);
  }

  async history(ctx: WorkspaceContext, accountId: string) {
    await this.accounts.real(ctx, accountId);
    const docs = await this.repos.forAccount(ctx, accountId);
    const reconciliations = [];
    for (const d of docs) reconciliations.push(await this.summary(ctx, d));
    return { reconciliations };
  }

  async get(ctx: WorkspaceContext, id: string) {
    return this.view(ctx, await this.require(ctx, id));
  }

  async tick(
    ctx: WorkspaceContext,
    id: string,
    body: { transactionIds: string[]; cleared: boolean },
  ): Promise<z.input<typeof ReconcileView>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.require(ctx, id, session);
      if (before.status !== 'in_progress') throw ReconcileErrors.notInProgress();
      const ticked = new Set(before.tickedIds);
      for (const tid of body.transactionIds) {
        const tx = await this.ledger.transactions.byId(ctx, tid, { session });
        if (!tx) throw Errors.notFound();
        const update = body.cleared
          ? { $addToSet: { clearedAccountIds: before.accountId } }
          : { $pull: { clearedAccountIds: before.accountId } };
        await this.ledger.transactions.updateOne(
          ctx,
          { _id: tid },
          { ...update, $set: { updatedAt: this.now() } } as never,
          {
            session,
          },
        );
        if (body.cleared) ticked.add(tid);
        else ticked.delete(tid);
        await this.ledger.feed(ctx, [{ collection: 'transactions', docId: tid, op: 'upsert' }], session);
      }
      const after = await this.repos.findOneAndUpdate(
        ctx,
        { _id: id, version: before.version },
        { $set: { tickedIds: [...ticked], updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw ReconcileErrors.notInProgress();
      await this.ledger.feed(ctx, [{ collection: 'reconciliations', docId: id, op: 'upsert' }], session);
      return after;
    });
    return this.view(ctx, doc);
  }

  async finish(
    ctx: WorkspaceContext,
    id: string,
    body: { adjust: boolean },
    operationId: string,
  ): Promise<z.input<typeof ReconcileView>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.require(ctx, id, session);
      if (before.status !== 'in_progress') throw ReconcileErrors.notInProgress();
      const { cleared, difference } = await this.figures(ctx, before, session);
      let adjustmentId: string | null = null;
      if (difference !== 0n) {
        if (!body.adjust) throw ReconcileErrors.notBalanced();
        const event = await this.ledger.postIn(
          ctx,
          {
            type: 'balance_adjustment',
            reason: 'reconcile',
            accountId: before.accountId,
            amount: toMinorString(difference),
            date: before.statementDate,
            notes: 'Reconcile adjustment',
          },
          { operationId: `${operationId}:adjust` },
          session,
        );
        adjustmentId = event._id;
        // The adjustment itself is cleared and locked with the rest.
        await this.ledger.transactions.updateOne(
          ctx,
          { _id: event._id },
          {
            $set: {
              clearedAccountIds: [before.accountId],
              reconciliationId: before._id,
              updatedAt: this.now(),
            },
          },
          { session },
        );
      }
      const lockIds = [...before.tickedIds, ...(adjustmentId ? [adjustmentId] : [])];
      if (lockIds.length) {
        await this.ledger.transactions.updateMany(
          ctx,
          { _id: { $in: lockIds } },
          { $set: { reconciliationId: before._id, updatedAt: this.now() } },
          { session },
        );
        await this.ledger.feed(
          ctx,
          lockIds.map((docId) => ({ collection: 'transactions', docId, op: 'upsert' as const })),
          session,
        );
      }
      const after = await this.repos.findOneAndUpdate(
        ctx,
        { _id: id, version: before.version },
        {
          $set: {
            status: 'finished',
            adjustmentId,
            finishedAt: this.now(),
            finishedBy: ctx.userId,
            updatedAt: this.now(),
            ...(adjustmentId ? { tickedIds: lockIds } : {}),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw ReconcileErrors.notInProgress();
      await this.ledger.feed(ctx, [{ collection: 'reconciliations', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        {
          action: 'reconcile.finished',
          target: { collection: 'reconciliations', id },
          after: { cleared: toMinorString(cleared), difference: toMinorString(difference), adjustmentId },
        },
        { session },
      );
      return after;
    });
    return this.view(ctx, doc);
  }

  async cancel(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Reconciliation>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.require(ctx, id, session);
      if (before.status !== 'in_progress') throw ReconcileErrors.notInProgress();
      const after = await this.repos.findOneAndUpdate(
        ctx,
        { _id: id, version: before.version },
        { $set: { status: 'cancelled', updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw ReconcileErrors.notInProgress();
      await this.ledger.feed(ctx, [{ collection: 'reconciliations', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: 'reconcile.cancelled', target: { collection: 'reconciliations', id } },
        { session },
      );
      return after;
    });
    return this.summary(ctx, doc);
  }

  /** Called from transactions.unlock so the reconcile history shows who unlocked what. */
  async recordUnlock(ctx: WorkspaceContext, reconciliationId: string, transactionId: string, session: ClientSession) {
    await this.repos.updateOne(
      ctx,
      { _id: reconciliationId },
      {
        $push: { unlocked: { transactionId, at: this.now().toISOString(), by: ctx.userId } },
        $set: { updatedAt: this.now() },
        $inc: { version: 1 },
      } as never,
      { session },
    );
  }

  private async require(ctx: WorkspaceContext, id: string, session?: ClientSession) {
    const doc = await this.repos.byId(ctx, id, { session });
    if (!doc) throw Errors.notFound();
    return doc;
  }

  private async view(ctx: WorkspaceContext, doc: ReconciliationDoc): Promise<z.input<typeof ReconcileView>> {
    const reconciliation = await this.summary(ctx, doc);
    const candidates = await this.candidates(ctx, doc);
    return { reconciliation, candidates };
  }

  private async summary(ctx: WorkspaceContext, doc: ReconciliationDoc): Promise<z.input<typeof Reconciliation>> {
    const { cleared, difference } = await this.figures(ctx, doc);
    return {
      id: doc._id,
      accountId: doc.accountId,
      status: doc.status,
      statementDate: doc.statementDate,
      statementBalance: doc.statementBalanceMinor,
      cleared: toMinorString(cleared),
      difference: toMinorString(difference),
      tickedIds: doc.tickedIds,
      adjustmentId: doc.adjustmentId,
      finishedAt: doc.finishedAt?.toISOString() ?? null,
      finishedBy: doc.finishedBy,
      unlocked: doc.unlocked,
      version: doc.version,
    };
  }

  private async figures(ctx: WorkspaceContext, doc: ReconciliationDoc, session?: ClientSession) {
    const account = await this.accounts.real(ctx, doc.accountId, session);
    const clearedIds = await this.clearedIds(ctx, doc, session);
    let raw = 0n;
    if (clearedIds.length) {
      const txs = await this.ledger.transactions.find(ctx, { _id: { $in: clearedIds } }, { session });
      for (const tx of txs) {
        for (const l of tx.lines) {
          if (l.ledgerAccountId === doc.accountId) raw += l.amountMinor;
        }
      }
    }
    const cleared = shownBalance(account.kind as 'asset', raw);
    const statement = parseMinor(doc.statementBalanceMinor);
    return { cleared, difference: statement - cleared };
  }

  private async clearedIds(ctx: WorkspaceContext, doc: ReconciliationDoc, session?: ClientSession) {
    // Prefer tickedIds for in-progress; for finished, also anything locked to this reconcile.
    if (doc.status === 'in_progress') return doc.tickedIds;
    const locked = await this.ledger.transactions.find(
      ctx,
      { reconciliationId: doc._id },
      { session, projection: { _id: 1 } },
    );
    return [...new Set([...doc.tickedIds, ...locked.map((t) => t._id)])];
  }

  private async candidates(ctx: WorkspaceContext, doc: ReconciliationDoc) {
    const page = await this.transactions.list(ctx, {
      status: 'live',
      accountId: [doc.accountId],
      to: doc.statementDate,
      limit: 500,
    } as never);
    const docs = await this.ledger.transactions.find(
      ctx,
      {
        _id: { $in: page.items.map((i) => i.id) },
      } as never,
      {},
    );
    const byId = new Map(docs.map((d) => [d._id, d]));
    return page.items.filter((item) => {
      const d = byId.get(item.id);
      if (!d) return false;
      return (
        !d.clearedAccountIds.includes(doc.accountId) ||
        doc.tickedIds.includes(item.id) ||
        d.reconciliationId === doc._id
      );
    });
  }
}

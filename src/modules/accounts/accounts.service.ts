import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { parseMinor, toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { AccountType, LedgerAccountDoc } from '../ledger/ledger.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { netWorth, shownBalance } from '../ledger/read.js';
import type {
  Account,
  ACCOUNT_GROUPS,
  AccountList,
  ArchiveBody,
  CreateAccountBody,
  UpdateAccountBody,
  UpdateValueBody,
} from './accounts.contract.js';

type Group = (typeof ACCOUNT_GROUPS)[number];

const LIABILITIES: AccountType[] = ['card', 'loan', 'other_liability'];
const GROUP_OF: Record<AccountType, Group> = {
  bank: 'cash_bank',
  cash: 'cash_bank',
  wallet: 'cash_bank',
  savings: 'cash_bank',
  fixed_deposit: 'investments',
  card: 'cards_credit',
  loan: 'loans',
  investment: 'investments',
  property: 'property',
  pension: 'investments',
  other_asset: 'other',
  other_liability: 'other',
};
/** Accounts whose value moves on its own; off budget unless asked (DESIGN.md page 8, "Tracking"). */
const TRACKING: AccountType[] = ['investment', 'property', 'pension', 'loan', 'fixed_deposit'];

export const kindOf = (type: AccountType) => (LIABILITIES.includes(type) ? 'liability' : 'asset');

export const AccountErrors = {
  stale: (current: unknown) =>
    new AppError(409, 'already_changed', 'This was already changed on another device.', { current }),
  nameTaken: () => new AppError(409, 'name_taken', 'You already have an account with this name.', { field: 'name' }),
  archived: () => new AppError(409, 'account_archived', 'This account is archived. Restore it first.'),
  moveToSelf: () => Errors.validation('moveBalanceTo', 'Choose a different account to move the balance to.'),
  unknownIds: () => Errors.validation('accountIds', 'This list has changed. Refresh and try again.'),
};

type Doc = LedgerAccountDoc & { closedWithBalance?: boolean; importMapping?: Record<string, unknown> | null };
const isReal = { accountType: { $ne: null }, systemKey: null } as const;

/** People's own accounts (build plan B1.6): bank, cash, cards, loans, investments and property. */
export class AccountsService {
  /**
   * Exchange rates and holdings, once those modules exist (Phase 5). Net worth then converts other currencies
   * and counts holdings at market value, so it includes unrealised gains (TECH-SPEC 6.7).
   */
  wealthFor?: (ctx: WorkspaceContext) => Promise<{
    convert: (amount: bigint, from: string, date: string) => bigint | null;
    holdings: { holding: { accountId: string; currency: string }; position: { value: bigint } }[];
  }>;

  constructor(
    private readonly database: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditRepository,
    private readonly currencyOf: (ctx: WorkspaceContext, session?: ClientSession) => Promise<string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(ctx: WorkspaceContext): Promise<z.input<typeof AccountList>> {
    const docs = (await this.ledger.accounts.find(ctx, isReal as never, {
      sort: { sortOrder: 1, createdAt: 1 },
    })) as Doc[];
    const wealth = await this.wealthFor?.(ctx);
    const views = await this.views(ctx, docs, wealth);
    const currency = await this.currencyOf(ctx);
    const today = new Date(this.now()).toISOString().slice(0, 10);
    // An investment account is worth its own balance plus its holdings at market value.
    const balanceOf = new Map(
      views.map((v, i) => [docs[i]!._id, rawOf(docs[i]!, v.balance) + parseMinor(v.holdingsValue)]),
    );
    const live = docs.filter((d) => !d.archivedAt || d.closedWithBalance);
    const toHome = (amount: bigint, from: string) =>
      from === currency ? amount : (wealth?.convert(amount, from, today) ?? null);
    const worth = netWorth(
      balanceOf,
      live.map((d) => ({ id: d._id, kind: d.kind, currency: d.currency, systemKey: null })),
      currency,
      toHome,
    );
    let assets = 0n;
    let owed = 0n;
    for (const d of live) {
      const b = toHome(balanceOf.get(d._id) ?? 0n, d.currency);
      if (b === null) continue;
      if (b > 0n) assets += b;
      else owed -= b;
    }
    return {
      accounts: views,
      netWorth: {
        amount: toMinorString(worth.amount),
        assets: toMinorString(assets),
        owed: toMinorString(owed),
        partial: worth.partial,
      },
    };
  }

  async get(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Account>> {
    const [view] = await this.views(ctx, [await this.real(ctx, id)]);
    return view!;
  }

  async create(ctx: WorkspaceContext, body: z.output<typeof CreateAccountBody>, operationId: string) {
    const id = await this.database.transaction((session) =>
      this.createIn(ctx, body, `${operationId}:opening`, session),
    );
    return this.get(ctx, id);
  }

  /** Makes the account and posts its opening balance (E8) in the caller's transaction. Returns its id. */
  async createIn(
    ctx: WorkspaceContext,
    body: z.output<typeof CreateAccountBody>,
    openingOperationId: string,
    session: ClientSession,
  ): Promise<string> {
    if (body.id) {
      const same = await this.ledger.accounts.findOne(ctx, { _id: body.id, ...isReal } as never, { session });
      if (same) return same._id;
    }
    const all = await this.ledger.accounts.find(ctx, isReal as never, { session });
    if (all.some((a) => !a.archivedAt && a.name.trim().toLowerCase() === body.name.trim().toLowerCase()))
      throw AccountErrors.nameTaken();
    const doc = await this.ledger.openAccount(
      ctx,
      {
        id: body.id,
        kind: kindOf(body.type),
        accountType: body.type,
        name: body.name,
        currency: body.currency ?? (await this.currencyOf(ctx, session)),
        institution: body.institution ?? null,
        last4: body.last4 ?? null,
        onBudget: body.onBudget ?? !TRACKING.includes(body.type),
        sortOrder: (Math.max(0, ...all.map((a) => a.sortOrder)) || 0) + 10,
      },
      session,
    );
    if (parseMinor(body.openingBalance) !== 0n) {
      await this.ledger.postIn(
        ctx,
        { type: 'opening_balance', accountId: doc._id, amount: body.openingBalance, date: body.openingDate },
        { operationId: openingOperationId },
        session,
      );
    }
    await this.ledger.feed(ctx, [{ collection: 'accounts', docId: doc._id, op: 'upsert' }], session);
    await this.audit.record(
      ctx,
      { action: 'account.created', target: { collection: 'accounts', id: doc._id } },
      { session },
    );
    return doc._id;
  }

  async update(ctx: WorkspaceContext, id: string, body: z.output<typeof UpdateAccountBody>) {
    await this.database.transaction(async (session) => {
      const before = await this.real(ctx, id, session);
      const { baseVersion, ...changes } = body;
      if (changes.name && changes.name.toLowerCase() !== before.name.toLowerCase()) {
        const all = await this.ledger.accounts.find(ctx, isReal as never, { session });
        if (all.some((a) => a._id !== id && !a.archivedAt && a.name.toLowerCase() === changes.name!.toLowerCase()))
          throw AccountErrors.nameTaken();
      }
      await this.bump(ctx, before, baseVersion, changes, session);
    });
    return this.get(ctx, id);
  }

  /** Moves the balance first when asked (a transfer, never income or spending), then archives. */
  async archive(ctx: WorkspaceContext, id: string, body: z.output<typeof ArchiveBody>, operationId: string) {
    await this.database.transaction(async (session) => {
      const before = await this.real(ctx, id, session);
      if (before.archivedAt) throw AccountErrors.archived();
      let shown = await this.shown(ctx, before, session);
      if (body.moveBalanceTo && shown !== 0n) {
        if (body.moveBalanceTo === id) throw AccountErrors.moveToSelf();
        const other = await this.real(ctx, body.moveBalanceTo, session);
        if (other.archivedAt) throw AccountErrors.archived();
        const raw = before.kind === 'liability' ? -shown : shown;
        const out = raw > 0n;
        const amount = toMinorString(out ? raw : -raw);
        await this.ledger.postIn(
          ctx,
          {
            type: 'transfer',
            fromAccountId: out ? id : other._id,
            toAccountId: out ? other._id : id,
            amount,
            date: body.date,
            notes: `Balance moved when archiving ${before.name}`,
          },
          { operationId: `${operationId}:move` },
          session,
        );
        shown = 0n;
      }
      await this.bump(
        ctx,
        before,
        body.baseVersion,
        { archivedAt: this.now(), closedWithBalance: shown !== 0n },
        session,
      );
    });
    return this.get(ctx, id);
  }

  async restore(ctx: WorkspaceContext, id: string) {
    await this.database.transaction(async (session) => {
      const before = await this.real(ctx, id, session);
      if (!before.archivedAt) return;
      await this.bump(ctx, before, before.version, { archivedAt: null, closedWithBalance: false }, session);
    });
    return this.get(ctx, id);
  }

  /** E10: the difference goes to equity:Revaluation, never income or spending. */
  async updateValue(ctx: WorkspaceContext, id: string, body: z.output<typeof UpdateValueBody>, operationId: string) {
    await this.database.transaction(async (session) => {
      const doc = await this.real(ctx, id, session);
      if (doc.archivedAt) throw AccountErrors.archived();
      const change = parseMinor(body.value) - (await this.shown(ctx, doc, session));
      if (change === 0n) return;
      await this.ledger.postIn(
        ctx,
        {
          type: 'balance_adjustment',
          accountId: id,
          amount: toMinorString(change),
          reason: 'revaluation',
          date: body.date,
          notes: body.notes ?? null,
        },
        { operationId },
        session,
      );
    });
    return this.get(ctx, id);
  }

  async reorder(ctx: WorkspaceContext, ids: string[]) {
    await this.database.transaction(async (session) => {
      const all = await this.ledger.accounts.find(ctx, isReal as never, { session });
      const known = new Set(all.map((a) => a._id));
      if (new Set(ids).size !== ids.length || ids.some((x) => !known.has(x))) throw AccountErrors.unknownIds();
      const rest = all.filter((a) => !ids.includes(a._id)).sort((a, b) => a.sortOrder - b.sortOrder);
      const order = [...ids, ...rest.map((a) => a._id)];
      for (const [i, accountId] of order.entries()) {
        await this.ledger.accounts.updateOne(
          ctx,
          { _id: accountId },
          { $set: { sortOrder: (i + 1) * 10, updatedAt: this.now() }, $inc: { version: 1 } },
          { session },
        );
      }
      await this.ledger.feed(
        ctx,
        order.map((docId) => ({ collection: 'accounts', docId, op: 'upsert' as const })),
        session,
      );
    });
    return this.list(ctx);
  }

  /** Saves the last CSV column mapping (P09-05). */
  async saveImportMapping(
    ctx: WorkspaceContext,
    id: string,
    mapping: Record<string, unknown>,
    session?: ClientSession,
  ) {
    await this.ledger.accounts.updateOne(ctx, { _id: id }, { $set: { importMapping: mapping } as never }, { session });
  }

  async real(ctx: WorkspaceContext, id: string, session?: ClientSession): Promise<Doc> {
    const doc = await this.ledger.accounts.findOne(ctx, { _id: id, ...isReal } as never, { session });
    if (!doc) throw Errors.notFound();
    return doc as Doc;
  }

  private async shown(ctx: WorkspaceContext, doc: Doc, session?: ClientSession) {
    const [b] = await this.ledger.balances.find(ctx, { ledgerAccountId: doc._id, currency: doc.currency }, { session });
    return shownBalance(doc.kind as 'asset', BigInt(b?.balanceMinor ?? 0n));
  }

  private async bump(
    ctx: WorkspaceContext,
    before: Doc,
    baseVersion: number,
    set: Record<string, unknown>,
    session: ClientSession,
  ) {
    const after = await this.ledger.accounts.findOneAndUpdate(
      ctx,
      { _id: before._id, version: baseVersion },
      { $set: { ...set, updatedAt: this.now() }, $inc: { version: 1 } },
      { session },
    );
    if (!after) throw AccountErrors.stale((await this.views(ctx, [before]))[0]);
    await this.ledger.feed(ctx, [{ collection: 'accounts', docId: before._id, op: 'upsert' }], session);
    await this.audit.record(
      ctx,
      { action: 'account.updated', target: { collection: 'accounts', id: before._id }, after: set },
      { session },
    );
  }

  private async views(
    ctx: WorkspaceContext,
    docs: Doc[],
    wealth?: Awaited<ReturnType<NonNullable<AccountsService['wealthFor']>>>,
  ): Promise<z.input<typeof Account>[]> {
    if (docs.length === 0) return [];
    const holds =
      wealth ??
      (docs.some((d) => d.accountType && GROUP_OF[d.accountType] === 'investments')
        ? await this.wealthFor?.(ctx)
        : undefined);
    const holdingsValue = new Map<string, bigint>();
    for (const h of holds?.holdings ?? []) {
      holdingsValue.set(h.holding.accountId, (holdingsValue.get(h.holding.accountId) ?? 0n) + h.position.value);
    }
    const ids = docs.map((d) => d._id);
    const balances = await this.ledger.balances.forAccounts(ctx, ids);
    const uncleared = await this.ledger.transactions.aggregate<{ _id: string; total: bigint }>(ctx, [
      { $match: { 'lines.ledgerAccountId': { $in: ids } } },
      { $project: { clearedAccountIds: 1, lines: 1 } },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.ledgerAccountId': { $in: ids },
          $expr: { $not: { $in: ['$lines.ledgerAccountId', { $ifNull: ['$clearedAccountIds', []] }] } },
        },
      },
      { $group: { _id: '$lines.ledgerAccountId', total: { $sum: '$lines.amountMinor' } } },
    ]);
    const last = await this.ledger.transactions.aggregate<{ _id: string; date: string }>(ctx, [
      { $match: { reconciliationId: { $type: 'string' }, clearedAccountIds: { $in: ids } } },
      { $unwind: '$clearedAccountIds' },
      { $match: { clearedAccountIds: { $in: ids } } },
      { $group: { _id: '$clearedAccountIds', date: { $max: '$date' } } },
    ]);
    return docs.map((d) => {
      const raw = BigInt(
        balances.find((b) => b.ledgerAccountId === d._id && b.currency === d.currency)?.balanceMinor ?? 0n,
      );
      const unc = BigInt(uncleared.find((u) => u._id === d._id)?.total ?? 0n);
      const show = (x: bigint) => toMinorString(shownBalance(d.kind as 'asset', x));
      return {
        id: d._id,
        type: d.accountType!,
        group: GROUP_OF[d.accountType!],
        kind: d.kind as 'asset' | 'liability',
        name: d.name,
        institution: d.institution,
        last4: d.last4,
        currency: d.currency,
        onBudget: d.onBudget,
        archived: d.archivedAt !== null,
        closedWithBalance: d.closedWithBalance ?? false,
        sortOrder: d.sortOrder,
        balance: show(raw),
        holdingsValue: toMinorString(holdingsValue.get(d._id) ?? 0n),
        clearedBalance: show(raw - unc),
        unclearedBalance: show(unc),
        lastReconciledAt: last.find((l) => l._id === d._id)?.date ?? null,
        importMapping: d.importMapping ?? null,
        version: d.version,
      };
    });
  }
}

const rawOf = (d: Doc, shown: string) => (d.kind === 'liability' ? -parseMinor(shown) : parseMinor(shown));

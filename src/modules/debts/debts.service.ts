import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { parseMinor, toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { PayeesRepository } from '../categories/categories.repository.js';
import type { EventInput } from '../ledger/ledger.inputs.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { daysInMonth, formatLocalDate, parseLocalDate } from '../schedules/recurrence.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import { debtRoutes as debtRouteDefs } from './debts.contract.js';
import type {
  Debt,
  DebtPaymentSplit,
  InstalmentSchedule,
  InterestTerms,
  MoneyBackSuggestion,
} from './debts.contract.js';
import { type DebtDoc, DebtsRepository } from './debts.repository.js';

type LendBody = z.output<NonNullable<(typeof debtRouteDefs)['lend']['body']>>;
type UpdateBody = z.output<NonNullable<(typeof debtRouteDefs)['update']['body']>>;
type PaymentBody = z.output<NonNullable<(typeof debtRouteDefs)['recordPayment']['body']>>;
type ConfirmBody = z.output<NonNullable<(typeof debtRouteDefs)['confirmMoneyBack']['body']>>;

type SuggestionPayload = {
  debtId: string;
  transactionId: string | null;
  draft: { date: string; amount: string; accountId: string; payeeId: string | null } | null;
  direction: 'incoming' | 'outgoing';
};

const encodeSuggestionId = (p: SuggestionPayload) => Buffer.from(JSON.stringify(p)).toString('base64url');

const decodeSuggestionId = (id: string): SuggestionPayload => {
  try {
    return JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as SuggestionPayload;
  } catch {
    throw Errors.validation('suggestionId', 'This suggestion has expired. Refresh and try again.');
  }
};

const DebtsErrors = {
  stale: (current: z.input<typeof Debt>) =>
    new AppError(409, 'already_changed', 'This was already changed on another device.', { current }),
  closed: () => new AppError(409, 'debt_closed', 'This debt is already settled or written off.'),
  notZero: () => Errors.validation('outstanding', 'Outstanding must be zero before you settle.'),
  wrongDirection: () => Errors.validation('direction', 'Write-off applies only when they owe you.'),
};

const keyOf = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

function addMonthsLocal(date: string, months: number): string {
  const { y, m, d } = parseLocalDate(date);
  let nm = m - 1 + months;
  const ny = y + Math.floor(nm / 12);
  nm = ((nm % 12) + 12) % 12;
  const nd = Math.min(d, daysInMonth(ny, nm + 1));
  return formatLocalDate(ny, nm + 1, nd);
}

function instalmentMeta(
  instalments: z.output<typeof InstalmentSchedule> | null,
  paymentCount: number,
  outstanding: bigint,
): { nextInstalmentDate: string | null; nextInstalmentAmount: string | null } {
  if (!instalments || outstanding <= 0n || paymentCount >= instalments.count) {
    return { nextInstalmentDate: null, nextInstalmentAmount: null };
  }
  const nextDate = addMonthsLocal(instalments.firstDate, paymentCount * instalments.everyMonths);
  const isLast = paymentCount === instalments.count - 1;
  const planned = parseMinor(instalments.amount);
  const amount = isLast ? outstanding : planned > outstanding ? outstanding : planned;
  return { nextInstalmentDate: nextDate, nextInstalmentAmount: toMinorString(amount) };
}

function defaultSplit(
  amount: bigint,
  outstanding: bigint,
  interest: z.output<typeof InterestTerms>,
): { principal: bigint; interest: bigint } {
  const cap = amount > outstanding ? outstanding : amount;
  if (interest.kind === 'none') return { principal: cap, interest: 0n };
  const interestPart =
    interest.kind === 'fixed' ? parseMinor(interest.amount) : (outstanding * BigInt(interest.rateBasisPoints)) / 10000n;
  const interestCapped = interestPart > cap ? cap : interestPart;
  return { principal: cap - interestCapped, interest: interestCapped };
}

const toDebt = (d: DebtDoc): z.input<typeof Debt> => {
  const outstanding = parseMinor(d.outstandingMinor);
  const meta = instalmentMeta(d.instalments, d.paymentTransactionIds.length, outstanding);
  return {
    id: d._id,
    direction: d.direction,
    personName: d.personName,
    payeeId: d.payeeId,
    ledgerAccountId: d.ledgerAccountId,
    principal: d.principalMinor,
    outstanding: d.outstandingMinor,
    interest: d.interest,
    dueDate: d.dueDate,
    instalments: d.instalments,
    accountId: d.accountId,
    openedOn: d.openedOn,
    status: d.status,
    notes: d.notes,
    nextInstalmentDate: meta.nextInstalmentDate,
    nextInstalmentAmount: meta.nextInstalmentAmount,
    version: d.version,
  };
};

export class DebtsService {
  constructor(
    private readonly database: Database,
    private readonly debts: DebtsRepository,
    private readonly payees: PayeesRepository,
    private readonly ledger: LedgerService,
    private readonly transactions: TransactionsService,
    private readonly audit: AuditRepository,
    private readonly currencyOf: (ctx: WorkspaceContext, session?: ClientSession) => Promise<string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    ctx: WorkspaceContext,
    q: { filter: string; cursor?: string; limit: number },
  ): Promise<{
    summary: { owedToYou: string; youOwe: string; net: string };
    items: z.input<typeof Debt>[];
    nextCursor: string | null;
  }> {
    const filter: Record<string, unknown> = {};
    if (q.filter === 'they_owe_me' || q.filter === 'i_owe_them') filter.direction = q.filter;
    else if (q.filter === 'settled') filter.status = { $in: ['settled', 'written_off'] };
    else filter.status = 'open';
    const rows = await this.debts.page(ctx, filter, q.cursor, q.limit);
    const items = rows.slice(0, q.limit).map(toDebt);
    const nextCursor = rows.length > q.limit ? rows[q.limit]!._id : null;
    const open = await this.debts.find(ctx, { status: 'open' });
    let owedToYou = 0n;
    let youOwe = 0n;
    for (const d of open) {
      const o = parseMinor(d.outstandingMinor);
      if (d.direction === 'they_owe_me') owedToYou += o;
      else youOwe += o;
    }
    return {
      summary: {
        owedToYou: toMinorString(owedToYou),
        youOwe: toMinorString(youOwe),
        net: toMinorString(owedToYou - youOwe),
      },
      items,
      nextCursor,
    };
  }

  async get(ctx: WorkspaceContext, id: string) {
    const doc = await this.requireOpenable(ctx, id);
    const payments = [];
    for (const txId of doc.paymentTransactionIds) {
      const { transaction } = await this.transactions.get(ctx, txId);
      const split = await this.splitFromTransaction(ctx, doc, transaction.id);
      payments.push({
        transactionId: transaction.id,
        date: transaction.date,
        amount: transaction.amount,
        split,
      });
    }
    return { debt: toDebt(doc), payments };
  }

  async lend(ctx: WorkspaceContext, body: LendBody, operationId: string): Promise<z.input<typeof Debt>> {
    return this.open(ctx, 'they_owe_me', body, operationId, {
      type: 'lend',
      receivableAccountId: '', // filled in transaction
      accountId: body.accountId,
      amount: body.amount,
      date: body.date,
    });
  }

  async borrow(ctx: WorkspaceContext, body: LendBody, operationId: string): Promise<z.input<typeof Debt>> {
    return this.open(ctx, 'i_owe_them', body, operationId, {
      type: 'loan_proceeds',
      loanAccountId: '',
      accountId: body.accountId,
      amount: body.amount,
      date: body.date,
    });
  }

  private async open(
    ctx: WorkspaceContext,
    direction: 'they_owe_me' | 'i_owe_them',
    body: LendBody,
    operationId: string,
    event: EventInput,
  ): Promise<z.input<typeof Debt>> {
    if (body.id) {
      const existing = await this.debts.findOne(ctx, { _id: body.id });
      if (existing) return toDebt(existing);
    }
    const dup = await this.debts.findOne(ctx, { operationId });
    if (dup) return toDebt(dup);
    const amount = parseMinor(body.amount);
    const doc = await this.database.transaction(async (session) => {
      const payeeId = await this.resolvePayee(ctx, body.personName, body.payeeId, session);
      const ledgerAccountId = await this.openPersonAccount(ctx, direction, body.personName, session);
      const input =
        event.type === 'lend'
          ? ({ ...event, receivableAccountId: ledgerAccountId } as EventInput)
          : ({ ...event, loanAccountId: ledgerAccountId } as EventInput);
      const tx = await this.ledger.postIn(ctx, input, { operationId: `${operationId}:open` }, session);
      const now = this.now();
      const created = await this.debts.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          direction,
          personName: body.personName.trim(),
          payeeId,
          ledgerAccountId,
          principalMinor: toMinorString(amount),
          outstandingMinor: toMinorString(amount),
          interest: body.interest ?? { kind: 'none' },
          dueDate: body.dueDate ?? null,
          instalments: body.instalments ?? null,
          accountId: body.accountId,
          openedOn: body.date,
          status: 'open',
          notes: body.notes ?? null,
          openTransactionId: tx._id,
          paymentTransactionIds: [],
          operationId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'debts', docId: created._id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        {
          action: direction === 'they_owe_me' ? 'debt.lent' : 'debt.borrowed',
          target: { collection: 'debts', id: created._id },
        },
        { session },
      );
      return created;
    });
    return toDebt(doc);
  }

  async update(ctx: WorkspaceContext, id: string, body: UpdateBody): Promise<z.input<typeof Debt>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.debts.findOne(ctx, { _id: id, status: 'open' }, { session });
      if (!before) {
        const cur = await this.debts.findOne(ctx, { _id: id }, { session });
        if (!cur) throw Errors.notFound();
        throw DebtsErrors.closed();
      }
      const set: Partial<DebtDoc> = { updatedAt: this.now() };
      if (body.notes !== undefined) set.notes = body.notes;
      if (body.interest !== undefined) set.interest = body.interest;
      if (body.dueDate !== undefined) set.dueDate = body.dueDate;
      if (body.instalments !== undefined) set.instalments = body.instalments;
      const after = await this.debts.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        { $set: set, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw DebtsErrors.stale(toDebt(before));
      await this.ledger.feed(ctx, [{ collection: 'debts', docId: id, op: 'upsert' }], session);
      return after;
    });
    return toDebt(doc);
  }

  async setSchedule(
    ctx: WorkspaceContext,
    id: string,
    instalments: z.output<typeof InstalmentSchedule>,
    baseVersion: number,
  ) {
    return this.update(ctx, id, { baseVersion, instalments });
  }

  async recordPayment(
    ctx: WorkspaceContext,
    id: string,
    body: PaymentBody,
    operationId: string,
  ): Promise<{
    debt: z.input<typeof Debt>;
    transaction: Awaited<ReturnType<TransactionsService['get']>>['transaction'];
  }> {
    const result = await this.database.transaction(async (session) => {
      const before = await this.debts.findOne(ctx, { _id: id, status: 'open' }, { session });
      if (!before) {
        const cur = await this.debts.findOne(ctx, { _id: id }, { session });
        if (!cur) throw Errors.notFound();
        throw DebtsErrors.closed();
      }
      const outstanding = parseMinor(before.outstandingMinor);
      const amount = parseMinor(body.amount);
      let principal: bigint;
      let interest: bigint;
      if (body.split) {
        principal = parseMinor(body.split.principal);
        interest = parseMinor(body.split.interest);
        if (principal + interest !== amount)
          throw Errors.validation('split', 'Principal and interest must add up to the payment amount.');
      } else {
        ({ principal, interest } = defaultSplit(amount, outstanding, before.interest));
      }
      if (principal > outstanding) throw Errors.validation('split', 'Principal cannot exceed what is still owed.');
      if (principal + interest > outstanding) interest = outstanding - principal;
      const input: EventInput =
        before.direction === 'they_owe_me'
          ? {
              type: 'collect',
              receivableAccountId: before.ledgerAccountId,
              accountId: body.accountId,
              principal: toMinorString(principal),
              interest: toMinorString(interest),
              date: body.date,
            }
          : {
              type: 'loan_repayment',
              loanAccountId: before.ledgerAccountId,
              accountId: body.accountId,
              principal: toMinorString(principal),
              interest: toMinorString(interest),
              date: body.date,
            };
      const tx = await this.ledger.postIn(ctx, input, { operationId }, session);
      const newOutstanding = outstanding - principal;
      const after = await this.debts.findOneAndUpdate(
        ctx,
        { _id: id },
        {
          $set: {
            outstandingMinor: toMinorString(newOutstanding > 0n ? newOutstanding : 0n),
            updatedAt: this.now(),
          },
          $push: { paymentTransactionIds: tx._id },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw Errors.notFound();
      await this.ledger.feed(ctx, [{ collection: 'debts', docId: id, op: 'upsert' }], session);
      await this.audit.record(ctx, { action: 'debt.payment', target: { collection: 'debts', id } }, { session });
      return { after, txId: tx._id };
    });
    const { transaction } = await this.transactions.get(ctx, result.txId);
    return { debt: toDebt(result.after), transaction };
  }

  async writeOff(
    ctx: WorkspaceContext,
    id: string,
    date: string,
    baseVersion: number,
    operationId: string,
  ): Promise<{
    debt: z.input<typeof Debt>;
    transaction: Awaited<ReturnType<TransactionsService['get']>>['transaction'];
  }> {
    const result = await this.database.transaction(async (session) => {
      const before = await this.debts.findOne(ctx, { _id: id, status: 'open', version: baseVersion }, { session });
      if (!before) {
        const cur = await this.debts.findOne(ctx, { _id: id }, { session });
        if (!cur) throw Errors.notFound();
        if (cur.status !== 'open') throw DebtsErrors.closed();
        throw DebtsErrors.stale(toDebt(cur));
      }
      if (before.direction !== 'they_owe_me') throw DebtsErrors.wrongDirection();
      const amount = before.outstandingMinor;
      if (parseMinor(amount) <= 0n) throw DebtsErrors.notZero();
      const tx = await this.ledger.postIn(
        ctx,
        { type: 'write_off', receivableAccountId: before.ledgerAccountId, amount, date },
        { operationId },
        session,
      );
      const after = await this.debts.findOneAndUpdate(
        ctx,
        { _id: id },
        {
          $set: {
            outstandingMinor: '0',
            status: 'written_off',
            updatedAt: this.now(),
          },
          $push: { paymentTransactionIds: tx._id },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw Errors.notFound();
      await this.ledger.feed(ctx, [{ collection: 'debts', docId: id, op: 'upsert' }], session);
      await this.audit.record(ctx, { action: 'debt.write_off', target: { collection: 'debts', id } }, { session });
      return { after, txId: tx._id };
    });
    const { transaction } = await this.transactions.get(ctx, result.txId);
    return { debt: toDebt(result.after), transaction };
  }

  async settle(ctx: WorkspaceContext, id: string, baseVersion: number): Promise<z.input<typeof Debt>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.debts.findOne(ctx, { _id: id, status: 'open', version: baseVersion }, { session });
      if (!before) {
        const cur = await this.debts.findOne(ctx, { _id: id }, { session });
        if (!cur) throw Errors.notFound();
        if (cur.status !== 'open') throw DebtsErrors.closed();
        throw DebtsErrors.stale(toDebt(cur));
      }
      if (parseMinor(before.outstandingMinor) !== 0n) throw DebtsErrors.notZero();
      const after = await this.debts.findOneAndUpdate(
        ctx,
        { _id: id },
        { $set: { status: 'settled', updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw Errors.notFound();
      await this.ledger.feed(ctx, [{ collection: 'debts', docId: id, op: 'upsert' }], session);
      return after;
    });
    return toDebt(doc);
  }

  async listMoneyBackSuggestions(
    ctx: WorkspaceContext,
    q: {
      transactionId?: string;
      importRowId?: string;
      accountId?: string;
      payeeId?: string;
      amount?: string;
      date?: string;
    },
  ): Promise<{ suggestions: z.input<typeof MoneyBackSuggestion>[] }> {
    void q.importRowId;
    let payeeId = q.payeeId ?? null;
    let amount = q.amount ? parseMinor(q.amount) : null;
    let date = q.date ?? null;
    let accountId = q.accountId ?? null;
    let transactionId: string | null = q.transactionId ?? null;
    if (q.transactionId) {
      const { transaction } = await this.transactions.get(ctx, q.transactionId);
      transactionId = transaction.id;
      payeeId = transaction.payeeId ?? payeeId;
      amount = parseMinor(transaction.amount);
      date = transaction.date;
      accountId = transaction.accountIds[0] ?? accountId;
    }
    if (!amount || !date || !accountId) {
      return { suggestions: [] };
    }
    const open = await this.debts.find(ctx, { status: 'open' });
    const suggestions: z.input<typeof MoneyBackSuggestion>[] = [];
    for (const debt of open) {
      const direction = debt.direction === 'they_owe_me' ? 'incoming' : 'outgoing';
      let reason: 'payee_match' | 'instalment_amount' | 'both' | null = null;
      if (payeeId && debt.payeeId === payeeId) reason = 'payee_match';
      const meta = instalmentMeta(
        debt.instalments,
        debt.paymentTransactionIds.length,
        parseMinor(debt.outstandingMinor),
      );
      if (meta.nextInstalmentAmount && parseMinor(meta.nextInstalmentAmount) === amount) {
        reason = reason === 'payee_match' ? 'both' : 'instalment_amount';
      }
      if (!reason) continue;
      const split = defaultSplit(amount, parseMinor(debt.outstandingMinor), debt.interest);
      const payload: SuggestionPayload = {
        debtId: debt._id,
        transactionId,
        draft: transactionId ? null : { date, amount: toMinorString(amount), accountId, payeeId },
        direction,
      };
      suggestions.push({
        id: encodeSuggestionId(payload),
        debtId: debt._id,
        direction,
        transactionId,
        draft: payload.draft,
        personName: debt.personName,
        outstanding: debt.outstandingMinor,
        suggestedSplit: { principal: toMinorString(split.principal), interest: toMinorString(split.interest) },
        reason,
      });
    }
    return { suggestions };
  }

  async confirmMoneyBack(
    ctx: WorkspaceContext,
    suggestionId: string,
    body: ConfirmBody,
    operationId: string,
  ): Promise<{
    debt: z.input<typeof Debt> | null;
    transaction: Awaited<ReturnType<TransactionsService['get']>>['transaction'];
  }> {
    const payload = decodeSuggestionId(suggestionId);
    const debtDoc = await this.debts.findOne(ctx, { _id: payload.debtId, status: 'open' });
    if (!debtDoc) throw Errors.notFound();

    if (body.choice === 'money_back') {
      if (payload.transactionId) {
        const { transaction } = await this.transactions.get(ctx, payload.transactionId);
        if (transaction.type === 'income') {
          await this.transactions.reverse(
            ctx,
            payload.transactionId,
            { baseVersion: transaction.version },
            `${operationId}:reverse`,
          );
        }
      }
      const amount =
        payload.draft?.amount ??
        (payload.transactionId ? (await this.transactions.get(ctx, payload.transactionId)).transaction.amount : null);
      const date = payload.draft?.date ?? (await this.transactions.get(ctx, payload.transactionId!)).transaction.date;
      const accountId =
        payload.draft?.accountId ??
        (await this.transactions.get(ctx, payload.transactionId!)).transaction.accountIds[0]!;
      if (!amount || !date || !accountId)
        throw Errors.validation('suggestionId', 'This suggestion is missing payment details.');
      const split =
        body.split ??
        (
          await this.listMoneyBackSuggestions(ctx, {
            transactionId: payload.transactionId ?? undefined,
            amount,
            date,
            accountId,
            payeeId: debtDoc.payeeId,
          })
        ).suggestions.find((s) => s.debtId === debtDoc._id)?.suggestedSplit;
      const { debt, transaction } = await this.recordPayment(
        ctx,
        debtDoc._id,
        { date, accountId, amount, split: split ?? undefined },
        operationId,
      );
      return { debt, transaction };
    }

    if (payload.transactionId) {
      const { transaction } = await this.transactions.get(ctx, payload.transactionId);
      return { debt: toDebt(debtDoc), transaction };
    }
    if (!payload.draft) throw Errors.validation('suggestionId', 'This suggestion is missing payment details.');
    if (!body.categoryId) throw Errors.validation('categoryId', 'Choose an income category.');
    const tx = await this.transactions.create(
      ctx,
      {
        type: 'income',
        accountId: payload.draft.accountId,
        categoryId: body.categoryId,
        amount: payload.draft.amount,
        date: payload.draft.date,
        payeeId: payload.draft.payeeId ?? debtDoc.payeeId,
      },
      operationId,
    );
    return { debt: toDebt(debtDoc), transaction: tx };
  }

  private async requireOpenable(ctx: WorkspaceContext, id: string): Promise<DebtDoc> {
    const doc = await this.debts.findOne(ctx, { _id: id });
    if (!doc) throw Errors.notFound();
    return doc;
  }

  private async resolvePayee(
    ctx: WorkspaceContext,
    personName: string,
    payeeId: string | undefined,
    session: ClientSession,
  ): Promise<string> {
    if (payeeId) {
      const p = await this.payees.findOne(ctx, { _id: payeeId, mergedInto: null }, { session });
      if (!p) throw Errors.notFound();
      return p._id;
    }
    const existing = await this.payees.findOne(ctx, { nameKey: keyOf(personName), mergedInto: null }, { session });
    if (existing) return existing._id;
    const now = this.now();
    const p = await this.payees.insertOne(
      ctx,
      {
        _id: newId(),
        name: personName.trim(),
        nameKey: keyOf(personName),
        aliases: [],
        aliasKeys: [],
        defaultCategoryId: null,
        logoFileId: null,
        mergedInto: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
      { session },
    );
    await this.ledger.feed(ctx, [{ collection: 'payees', docId: p._id, op: 'upsert' }], session);
    return p._id;
  }

  private async openPersonAccount(
    ctx: WorkspaceContext,
    direction: 'they_owe_me' | 'i_owe_them',
    personName: string,
    session: ClientSession,
  ): Promise<string> {
    const currency = await this.currencyOf(ctx, session);
    const baseName = direction === 'they_owe_me' ? `${personName.trim()} owes me` : `I owe ${personName.trim()}`;
    let name = baseName;
    const accounts = await this.ledger.accounts.find(ctx, { systemKey: null, categoryId: null }, { session });
    let n = 2;
    while (accounts.some((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      name = `${baseName} (${n})`;
      n += 1;
    }
    const doc = await this.ledger.openAccount(
      ctx,
      {
        kind: direction === 'they_owe_me' ? 'asset' : 'liability',
        accountType: direction === 'they_owe_me' ? 'other_asset' : 'other_liability',
        name,
        currency,
        onBudget: false,
        personDebt: direction === 'they_owe_me' ? 'receivable' : 'payable',
        sortOrder: (Math.max(0, ...accounts.map((a) => a.sortOrder)) || 0) + 10,
      },
      session,
    );
    await this.ledger.feed(ctx, [{ collection: 'accounts', docId: doc._id, op: 'upsert' }], session);
    return doc._id;
  }

  private async splitFromTransaction(
    ctx: WorkspaceContext,
    debt: DebtDoc,
    transactionId: string,
  ): Promise<z.input<typeof DebtPaymentSplit>> {
    const doc = await this.ledger.transactions.byId(ctx, transactionId);
    if (!doc) return { principal: '0', interest: '0' };
    let principal = 0n;
    let interest = 0n;
    for (const line of doc.lines) {
      if (line.ledgerAccountId === debt.ledgerAccountId) {
        principal += line.amountMinor < 0n ? -line.amountMinor : line.amountMinor;
      }
    }
    const interestCat = await this.ledger.accounts.findOne(ctx, { systemKey: 'interest_earned' });
    const interestExp = await this.ledger.accounts.findOne(ctx, { systemKey: 'interest_and_charges' });
    for (const line of doc.lines) {
      if (interestCat && line.ledgerAccountId === interestCat._id)
        interest += line.amountMinor < 0n ? -line.amountMinor : line.amountMinor;
      if (interestExp && line.ledgerAccountId === interestExp._id)
        interest += line.amountMinor > 0n ? line.amountMinor : -line.amountMinor;
    }
    return { principal: toMinorString(principal), interest: toMinorString(interest) };
  }
}

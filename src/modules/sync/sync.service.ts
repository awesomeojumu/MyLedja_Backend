import { z } from 'zod';
import { AppError, Errors, type ErrorBody } from '../../common/errors/errors.js';
import { Uuid } from '../../common/http/schemas.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import { CreateAccountBody, UpdateAccountBody } from '../accounts/accounts.contract.js';
import type { AccountsService } from '../accounts/accounts.service.js';
import type { BudgetService } from '../budget/budget.service.js';
import {
  CreateCategoryBody,
  CreateGroupBody,
  CreatePayeeBody,
  DeleteCategoryBody,
  UpdateCategoryBody,
  UpdatePayeeBody,
} from '../categories/categories.contract.js';
import type { CategoriesService } from '../categories/categories.service.js';
import { CHANGE_RETENTION_DAYS, type ChangeDoc, type ChangesRepository } from '../ledger/ledger.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import {
  CorrectBody,
  CreateTransactionBody,
  ReverseBody,
  UpdateTransactionBody,
} from '../transactions/transactions.contract.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import type { SchedulesService } from '../schedules/schedules.service.js';
import { scheduleRoutes } from '../schedules/schedules.contract.js';
import type { DebtsService } from '../debts/debts.service.js';
import { debtRoutes } from '../debts/debts.contract.js';
import type { GoalsService } from '../goals/goals.service.js';
import { goalRoutes } from '../goals/goals.contract.js';
import type { IncomeService } from '../income/income.service.js';
import { incomeRoutes } from '../income/income.contract.js';
import type { CountersRepository } from '../workspaces/workspaces.repository.js';
import { RuleBody } from '../rules/rules.contract.js';
import type { RulesService } from '../rules/rules.service.js';
import { CreateHoldingBody, SetPricesBody, UpdateHoldingBody } from '../investments/investments.contract.js';
import type { InvestmentsService } from '../investments/investments.service.js';
import type { CurrenciesService } from '../currencies/currencies.service.js';
import type { ReportsService } from '../reports/reports.service.js';
import { reportRoutes } from '../reports/reports.contract.js';
import { SetExchangeRateBody } from '../currencies/currencies.contract.js';
import type { ReconcileService } from '../reconcile/reconcile.service.js';
import { CURRENT_SCHEMA_VERSION, type Change, type Operation, type OperationResult } from './sync.contract.js';

const PREVIOUS_SCHEMA_VERSION = 0;
const REVERSAL_SUFFIX = ':reversal';
const CreateScheduleBody = scheduleRoutes.create.body!;
const UpdateScheduleBody = scheduleRoutes.update.body!;
const LendBody = debtRoutes.lend.body!;
const BorrowBody = debtRoutes.borrow.body!;
const DebtPaymentBody = debtRoutes.recordPayment.body!;
const WriteOffBody = debtRoutes.writeOff.body!;
const UpdateDebtBody = debtRoutes.update.body!;
const SetDebtScheduleBody = debtRoutes.setSchedule.body!;
const SettleDebtBody = debtRoutes.settle.body!;
const CreateGoalBody = goalRoutes.create.body!;
const UpdateGoalBody = goalRoutes.update.body!;
const AllocateGoalBody = goalRoutes.allocate.body!;
const SpendGoalBody = goalRoutes.spend.body!;
const DeleteGoalBody = goalRoutes.remove.body!;
const SetGoalScheduleBody = goalRoutes.setSchedule.body!;
const CreateIncomeStreamBody = incomeRoutes.createStream.body!;
const UpdateIncomeStreamBody = incomeRoutes.updateStream.body!;
const TagCreateBody = z.object({ id: Uuid.optional(), name: z.string().trim().min(1).max(40) });

type PushBody = {
  deviceId: string;
  operations: z.output<typeof Operation>[];
};

type PullQuery = { since: string; limit: number };

/** Offline sync: push queued operations in order, pull the change feed (build plan B1.11). */
export class SyncService {
  /** Set after construction, like transactions.onUnlock, to keep the constructor's order stable. */
  rules!: RulesService;
  investments!: InvestmentsService;
  currencies!: CurrenciesService;
  reports!: ReportsService;
  reconcile!: ReconcileService;

  constructor(
    private readonly counters: CountersRepository,
    private readonly changes: ChangesRepository,
    private readonly ledger: LedgerService,
    private readonly transactions: TransactionsService,
    private readonly accounts: AccountsService,
    private readonly categories: CategoriesService,
    private readonly budget: BudgetService,
    private readonly schedules: SchedulesService,
    private readonly debts: DebtsService,
    private readonly goals: GoalsService,
    private readonly income: IncomeService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async push(
    ctx: WorkspaceContext,
    body: PushBody,
  ): Promise<{ results: z.input<typeof OperationResult>[]; seq: string }> {
    const results: z.input<typeof OperationResult>[] = [];
    for (const op of body.operations) {
      results.push(await this.one(ctx, op, body.deviceId));
    }
    const seq = await this.counters.current(ctx);
    return { results, seq: seq.toString() };
  }

  async pull(
    ctx: WorkspaceContext,
    query: PullQuery,
  ): Promise<{ changes: z.input<typeof Change>[]; nextSince: string; hasMore: boolean; reset: boolean }> {
    const since = BigInt(query.since);
    if (await this.needsReset(ctx, since)) {
      return { changes: [], nextSince: '0', hasMore: false, reset: true };
    }
    const rows = await this.changes.since(ctx, since, query.limit);
    const changes: z.input<typeof Change>[] = [];
    for (const row of rows) {
      changes.push({
        seq: row.seq.toString(),
        collection: row.collection,
        id: row.docId,
        op: row.op,
        doc: row.op === 'tombstone' ? null : await this.loadDoc(ctx, row),
      });
    }
    const last = rows.at(-1)?.seq ?? since;
    return {
      changes,
      nextSince: last.toString(),
      hasMore: rows.length >= query.limit,
      reset: false,
    };
  }

  private async needsReset(ctx: WorkspaceContext, since: bigint): Promise<boolean> {
    if (since <= 0n) return false;
    const oldest = await this.changes.oldest(ctx);
    if (!oldest) {
      const current = await this.counters.current(ctx);
      return current > since;
    }
    // Gap in the feed: tombstones/changes before `oldest.seq` are gone.
    if (since + 1n < oldest.seq) return true;
    const retentionMs = CHANGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoff = new Date(this.now().getTime() - retentionMs);
    if (oldest.at <= cutoff && since + 1n < oldest.seq) return true;
    return false;
  }

  private async one(
    ctx: WorkspaceContext,
    op: z.output<typeof Operation>,
    deviceId: string,
  ): Promise<z.input<typeof OperationResult>> {
    if (op.schemaVersion !== CURRENT_SCHEMA_VERSION && op.schemaVersion !== PREVIOUS_SCHEMA_VERSION) {
      return this.rejected(op.operationId, Errors.validation('schemaVersion', 'Update the app and try again.'));
    }
    try {
      const outcome = await this.ledger.withClientIds(op.transactionIds, () => this.apply(ctx, op, deviceId));
      return {
        operationId: op.operationId,
        status: outcome.duplicate ? 'duplicate' : 'applied',
        result: outcome.result,
        current: null,
        error: null,
      };
    } catch (e) {
      if (e instanceof AppError && e.code === 'already_changed') {
        const current = e.extra && 'current' in e.extra ? e.extra.current : null;
        return {
          operationId: op.operationId,
          status: 'conflict',
          result: null,
          current: current ?? null,
          error: errorBody(e),
        };
      }
      if (e instanceof AppError) return this.rejected(op.operationId, e);
      if (e instanceof z.ZodError) {
        const issue = e.issues[0];
        return this.rejected(
          op.operationId,
          Errors.validation(issue?.path.join('.') || undefined, issue?.message ?? 'Check this and try again.'),
        );
      }
      throw e;
    }
  }

  private rejected(operationId: string, e: AppError): z.input<typeof OperationResult> {
    return { operationId, status: 'rejected', result: null, current: null, error: errorBody(e) };
  }

  private async apply(
    ctx: WorkspaceContext,
    op: z.output<typeof Operation>,
    deviceId: string,
  ): Promise<{ result: unknown; duplicate: boolean }> {
    const payload = op.payload ?? {};
    const targetId = op.targetId ?? null;
    const baseVersion = op.baseVersion ?? (typeof payload.baseVersion === 'number' ? payload.baseVersion : null);

    switch (op.type) {
      case 'transaction.create': {
        const existing = await this.ledger.transactions.byOperation(ctx, op.operationId);
        if (existing) {
          return {
            result: (await this.transactions.get(ctx, existing._id)).transaction,
            duplicate: true,
          };
        }
        const body = CreateTransactionBody.parse(payload);
        return { result: await this.transactions.create(ctx, body, op.operationId, deviceId), duplicate: false };
      }
      case 'transaction.correct': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the transaction to correct.');
        const existing = await this.ledger.transactions.byOperation(ctx, op.operationId);
        if (existing) {
          const detail = await this.transactions.get(ctx, existing._id);
          const reversal = await this.ledger.transactions.byOperation(ctx, op.operationId + REVERSAL_SUFFIX);
          return {
            result: {
              transaction: detail.transaction,
              reversal: reversal ? (await this.transactions.get(ctx, reversal._id)).transaction : null,
            },
            duplicate: true,
          };
        }
        const inputSource =
          payload.input && typeof payload.input === 'object'
            ? payload.input
            : Object.fromEntries(Object.entries(payload).filter(([k]) => k !== 'baseVersion'));
        const body = CorrectBody.parse({
          baseVersion: baseVersion ?? payload.baseVersion,
          input: inputSource,
        });
        return {
          result: await this.transactions.correct(ctx, targetId, body, op.operationId, deviceId),
          duplicate: false,
        };
      }
      case 'transaction.reverse': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the transaction to reverse.');
        const existing = await this.ledger.transactions.byOperation(ctx, op.operationId + REVERSAL_SUFFIX);
        if (existing) {
          return {
            result: (await this.transactions.get(ctx, existing._id)).transaction,
            duplicate: true,
          };
        }
        const body = ReverseBody.parse({ baseVersion: baseVersion ?? payload.baseVersion });
        return {
          result: await this.transactions.reverse(ctx, targetId, body, op.operationId, deviceId),
          duplicate: false,
        };
      }
      case 'transaction.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the transaction to update.');
        const body = UpdateTransactionBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.transactions.update(ctx, targetId, body), duplicate: false };
      }
      case 'account.create': {
        const body = CreateAccountBody.parse(payload);
        if (body.id) {
          try {
            return { result: await this.accounts.get(ctx, body.id), duplicate: true };
          } catch (e) {
            if (!(e instanceof AppError && e.code === 'not_found')) throw e;
          }
        }
        return { result: await this.accounts.create(ctx, body, op.operationId), duplicate: false };
      }
      case 'account.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the account to update.');
        const body = UpdateAccountBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.accounts.update(ctx, targetId, body), duplicate: false };
      }
      case 'category.create': {
        const body = CreateCategoryBody.parse(payload);
        if (body.id) {
          const tree = await this.categories.tree(ctx);
          const same = tree.categories.find((c) => c.id === body.id);
          if (same) return { result: same, duplicate: true };
        }
        return { result: await this.categories.create(ctx, body), duplicate: false };
      }
      case 'category.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the category to update.');
        const body = UpdateCategoryBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.categories.update(ctx, targetId, body), duplicate: false };
      }
      case 'category.delete': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the category to delete.');
        const body = DeleteCategoryBody.parse(payload);
        return {
          result: await this.categories.remove(ctx, targetId, body.moveTo, op.operationId, body.undoId),
          duplicate: false,
        };
      }
      case 'category.undo_delete': {
        const undoId = typeof payload.undoId === 'string' ? payload.undoId : null;
        if (!undoId) throw Errors.validation('undoId', 'Choose the delete to undo.');
        return { result: await this.categories.undoRemove(ctx, undoId, op.operationId), duplicate: false };
      }
      case 'category_group.create': {
        const body = CreateGroupBody.parse(payload);
        if (body.id) {
          const tree = await this.categories.tree(ctx);
          const same = tree.groups.find((g) => g.id === body.id);
          if (same) return { result: same, duplicate: true };
        }
        return { result: await this.categories.createGroup(ctx, body), duplicate: false };
      }
      case 'payee.create': {
        const body = CreatePayeeBody.parse(payload);
        if (body.id) {
          try {
            return { result: await this.categories.getPayee(ctx, body.id), duplicate: true };
          } catch (e) {
            if (!(e instanceof AppError && e.code === 'not_found')) throw e;
          }
        }
        return { result: await this.categories.createPayee(ctx, body), duplicate: false };
      }
      case 'payee.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the payee to update.');
        const body = UpdatePayeeBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.categories.updatePayee(ctx, targetId, body), duplicate: false };
      }
      case 'tag.create': {
        const body = TagCreateBody.parse(payload);
        if (body.id) {
          const { tags } = await this.categories.listTags(ctx);
          const same = tags.find((t) => t.id === body.id);
          if (same) return { result: same, duplicate: true };
        }
        return { result: await this.categories.createTag(ctx, body), duplicate: false };
      }
      case 'budget.assign': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the category to assign.');
        const month = typeof payload.month === 'string' ? payload.month : null;
        if (!month) throw Errors.validation('month', 'Choose a month.');
        const assigned = payload.assigned;
        if (typeof assigned !== 'string') throw Errors.validation('assigned', 'Enter an amount.');
        const carryOver = typeof payload.carryOver === 'boolean' ? payload.carryOver : undefined;
        const note = typeof payload.note === 'string' ? payload.note : undefined;
        return {
          result: await this.budget.assign(ctx, month, targetId, { assigned, carryOver, note }),
          duplicate: false,
        };
      }
      case 'budget.template.save': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the template to save.');
        const name = typeof payload.name === 'string' ? payload.name : null;
        const rules = Array.isArray(payload.rules) ? payload.rules : null;
        if (!name || !rules) throw Errors.validation('rules', 'Add a name and at least one rule.');
        return {
          result: await this.budget.saveTemplate(ctx, targetId, {
            name,
            rules: rules as { categoryId: string; assigned: string; kind?: string; meta?: Record<string, string> }[],
          }),
          duplicate: false,
        };
      }
      case 'schedule.create': {
        const body = CreateScheduleBody.parse(payload);
        return { result: await this.schedules.create(ctx, body, op.operationId), duplicate: false };
      }
      case 'schedule.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the schedule to update.');
        const body = UpdateScheduleBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.schedules.update(ctx, targetId, body), duplicate: false };
      }
      case 'schedule.cancel': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the schedule to cancel.');
        const bv =
          typeof baseVersion === 'number'
            ? baseVersion
            : typeof payload.baseVersion === 'number'
              ? payload.baseVersion
              : null;
        if (bv === null) throw Errors.validation('baseVersion', 'Send the schedule version.');
        return { result: await this.schedules.cancel(ctx, targetId, bv), duplicate: false };
      }
      case 'occurrence.mark_paid': {
        const body = z
          .object({
            scheduleId: Uuid.optional(),
            date: z.string().optional(),
            matchTransactionId: Uuid.optional(),
            create: z
              .object({
                date: z.string(),
                amount: z.string().optional(),
                notes: z.string().nullable().optional(),
              })
              .optional(),
          })
          .parse(payload);
        const occurrenceKey = targetId ?? (body.scheduleId && body.date ? `${body.scheduleId}:${body.date}` : null);
        if (!occurrenceKey) throw Errors.validation('targetId', 'Choose the occurrence to mark paid.');
        return {
          result: await this.schedules.markPaid(
            ctx,
            occurrenceKey,
            {
              matchTransactionId: body.matchTransactionId,
              create: body.create,
            },
            op.operationId,
          ),
          duplicate: false,
        };
      }
      case 'occurrence.mark_received': {
        const body = z
          .object({
            scheduleId: Uuid.optional(),
            date: z.string().optional(),
            matchTransactionId: Uuid.optional(),
            create: z
              .object({
                date: z.string(),
                amount: z.string().optional(),
                notes: z.string().nullable().optional(),
              })
              .optional(),
          })
          .parse(payload);
        const occurrenceKey = targetId ?? (body.scheduleId && body.date ? `${body.scheduleId}:${body.date}` : null);
        if (!occurrenceKey) throw Errors.validation('targetId', 'Choose the occurrence to mark received.');
        return {
          result: await this.schedules.markReceived(
            ctx,
            occurrenceKey,
            {
              matchTransactionId: body.matchTransactionId,
              create: body.create,
            },
            op.operationId,
          ),
          duplicate: false,
        };
      }
      case 'occurrence.unmark': {
        const body = z
          .object({
            scheduleId: Uuid.optional(),
            date: z.string().optional(),
          })
          .parse(payload);
        const occurrenceKey = targetId ?? (body.scheduleId && body.date ? `${body.scheduleId}:${body.date}` : null);
        if (!occurrenceKey) throw Errors.validation('targetId', 'Choose the occurrence to unmark.');
        return {
          result: await this.schedules.unmark(ctx, occurrenceKey),
          duplicate: false,
        };
      }
      case 'goal.create': {
        const body = CreateGoalBody.parse(payload);
        return { result: await this.goals.create(ctx, body, op.operationId), duplicate: false };
      }
      case 'goal.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the goal to update.');
        const body = UpdateGoalBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.goals.update(ctx, targetId, body), duplicate: false };
      }
      case 'goal.allocate': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the goal to fund.');
        const body = AllocateGoalBody.parse(payload);
        return { result: await this.goals.allocate(ctx, targetId, body, op.operationId), duplicate: false };
      }
      case 'goal.spend': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the goal to spend from.');
        const body = SpendGoalBody.parse(payload);
        return { result: await this.goals.spend(ctx, targetId, body, op.operationId), duplicate: false };
      }
      case 'goal.delete': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the goal to delete.');
        const body = DeleteGoalBody.parse({
          baseVersion: baseVersion ?? payload.baseVersion,
        });
        await this.goals.remove(ctx, targetId, body.baseVersion);
        return { result: null, duplicate: false };
      }
      case 'goal.schedule': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the goal to schedule.');
        const body = SetGoalScheduleBody.parse({
          ...payload,
          baseVersion: baseVersion ?? payload.baseVersion,
        });
        return { result: await this.goals.setSchedule(ctx, targetId, body), duplicate: false };
      }
      case 'debt.lend': {
        const body = LendBody.parse(payload);
        return { result: await this.debts.lend(ctx, body, op.operationId), duplicate: false };
      }
      case 'debt.borrow': {
        const body = BorrowBody.parse(payload);
        return { result: await this.debts.borrow(ctx, body, op.operationId), duplicate: false };
      }
      case 'debt.payment': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the debt to update.');
        const body = DebtPaymentBody.parse(payload);
        return { result: await this.debts.recordPayment(ctx, targetId, body, op.operationId), duplicate: false };
      }
      case 'debt.write_off': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the debt to write off.');
        const body = WriteOffBody.parse(payload);
        const { debt } = await this.debts.writeOff(
          ctx,
          targetId,
          body.date,
          body.baseVersion,
          op.operationId,
          body.reason,
        );
        return { result: debt, duplicate: false };
      }
      case 'debt.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the debt to update.');
        const body = UpdateDebtBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.debts.update(ctx, targetId, body), duplicate: false };
      }
      case 'debt.schedule': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the debt to schedule.');
        const body = SetDebtScheduleBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return {
          result: await this.debts.setSchedule(ctx, targetId, body.instalments, body.baseVersion),
          duplicate: false,
        };
      }
      case 'debt.settle': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the debt to settle.');
        const body = SettleDebtBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.debts.settle(ctx, targetId, body.baseVersion), duplicate: false };
      }
      case 'income.stream.create': {
        const body = CreateIncomeStreamBody.parse(payload);
        return { result: await this.income.createStream(ctx, body, op.operationId), duplicate: false };
      }
      case 'income.stream.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the income stream to update.');
        const body = UpdateIncomeStreamBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.income.updateStream(ctx, targetId, body), duplicate: false };
      }
      case 'income.mark_one_off': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the transaction to mark one-off.');
        return { result: await this.income.markOneOff(ctx, targetId), duplicate: false };
      }
      case 'rule.upsert': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the rule to save.');
        return {
          result: await this.rules.upsert(ctx, targetId, RuleBody.parse(payload), baseVersion),
          duplicate: false,
        };
      }
      case 'rule.delete': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the rule to delete.');
        return { result: await this.rules.remove(ctx, targetId), duplicate: false };
      }
      case 'holding.create': {
        const body = CreateHoldingBody.parse(payload);
        return { result: await this.investments.create(ctx, body, op.operationId), duplicate: false };
      }
      case 'holding.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the holding to update.');
        const body = UpdateHoldingBody.parse({ ...payload, baseVersion: baseVersion ?? payload.baseVersion });
        return { result: await this.investments.update(ctx, targetId, body), duplicate: false };
      }
      case 'holding.prices': {
        return { result: await this.investments.setPrices(ctx, SetPricesBody.parse(payload)), duplicate: false };
      }
      case 'holding.archive': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the holding to remove.');
        return { result: await this.investments.archive(ctx, targetId), duplicate: false };
      }
      case 'holding.price.delete': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the holding.');
        const date = z.string().parse(payload.date);
        await this.investments.deletePrice(ctx, targetId, date);
        return { result: null, duplicate: false };
      }
      case 'exchange_rate.delete': {
        const body = SetExchangeRateBody.pick({ currency: true, date: true }).parse(payload);
        await this.currencies.remove(ctx, body.currency, body.date);
        return { result: null, duplicate: false };
      }
      case 'exchange_rate.set': {
        const body = SetExchangeRateBody.parse(payload);
        return { result: await this.currencies.set(ctx, body), duplicate: false };
      }
      case 'report_dashboard.create': {
        const body = reportRoutes.createDashboard.body!.parse(payload);
        return { result: await this.reports.createDashboard(ctx, body, op.operationId), duplicate: false };
      }
      case 'report_dashboard.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the dashboard to update.');
        const body = reportRoutes.updateDashboard.body!.parse({
          ...payload,
          baseVersion: baseVersion ?? payload.baseVersion,
        });
        return { result: await this.reports.updateDashboard(ctx, targetId, body), duplicate: false };
      }
      case 'report_dashboard.delete': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the dashboard to delete.');
        await this.reports.deleteDashboard(ctx, targetId);
        return { result: null, duplicate: false };
      }
      case 'saved_report.delete': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the report to delete.');
        await this.reports.deleteSaved(ctx, targetId);
        return { result: null, duplicate: false };
      }
      case 'saved_report.create': {
        const body = reportRoutes.createSaved.body!.parse(payload);
        return { result: await this.reports.createSaved(ctx, body, op.operationId), duplicate: false };
      }
      case 'saved_report.update': {
        if (!targetId) throw Errors.validation('targetId', 'Choose the report to update.');
        const body = reportRoutes.updateSaved.body!.parse({
          ...payload,
          baseVersion: baseVersion ?? payload.baseVersion,
        });
        return { result: await this.reports.updateSaved(ctx, targetId, body), duplicate: false };
      }
      default: {
        const _exhaustive: never = op.type;
        throw Errors.validation('type', `Unknown operation type: ${_exhaustive}`);
      }
    }
  }

  private async loadDoc(ctx: WorkspaceContext, row: ChangeDoc): Promise<unknown> {
    try {
      switch (row.collection) {
        case 'transactions':
          return (await this.transactions.get(ctx, row.docId)).transaction;
        case 'accounts':
          return await this.accounts.get(ctx, row.docId);
        case 'categories': {
          const tree = await this.categories.tree(ctx);
          return tree.categories.find((c) => c.id === row.docId) ?? null;
        }
        case 'category_groups': {
          const tree = await this.categories.tree(ctx);
          return tree.groups.find((g) => g.id === row.docId) ?? null;
        }
        case 'payees':
          return await this.categories.getPayee(ctx, row.docId);
        case 'tags': {
          const { tags } = await this.categories.listTags(ctx);
          return tags.find((t) => t.id === row.docId) ?? null;
        }
        case 'budget_months': {
          const [categoryId, month] = row.docId.split(':');
          if (!categoryId || !month) return null;
          const { months } = await this.budget.get(ctx, month, 1);
          const m = months[0];
          if (!m) return null;
          return m.categories.find((c) => c.categoryId === categoryId) ?? m;
        }
        case 'schedules':
          return await this.schedules.get(ctx, row.docId);
        case 'occurrences':
          try {
            return await this.schedules.getOccurrence(ctx, row.docId);
          } catch {
            return null;
          }
        case 'debts': {
          try {
            return (await this.debts.get(ctx, row.docId)).debt;
          } catch {
            return null;
          }
        }
        case 'goals':
          try {
            return (await this.goals.get(ctx, row.docId)).goal;
          } catch {
            return null;
          }
        case 'goal_allocations':
          try {
            return await this.goals.getAllocation(ctx, row.docId);
          } catch {
            return null;
          }
        case 'rules':
          return await this.rules.get(ctx, row.docId).catch(() => null);
        case 'holdings':
          return await this.investments.getHolding(ctx, row.docId).catch(() => null);
        case 'prices':
          return await this.investments.getPrice(ctx, row.docId);
        case 'exchange_rates':
          return await this.currencies.get(ctx, row.docId);
        case 'report_dashboards':
          return await this.reports.getDashboard(ctx, row.docId);
        case 'saved_reports':
          return await this.reports.getSaved(ctx, row.docId);
        case 'income_streams':
          try {
            return await this.income.getStreamDoc(ctx, row.docId);
          } catch {
            return null;
          }
        case 'reconciliations':
          try {
            return (await this.reconcile.get(ctx, row.docId)).reconciliation;
          } catch {
            return null;
          }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }
}

function errorBody(e: AppError): ErrorBody {
  const { code, message, field, retryAfterSeconds } = e.body();
  return {
    code,
    message,
    ...(typeof field === 'string' ? { field } : {}),
    ...(typeof retryAfterSeconds === 'number' ? { retryAfterSeconds } : {}),
  };
}

import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, LocalDate, MinorAmount, Month, PageQuery, Uuid } from '../../common/http/schemas.js';
import { Transaction } from '../transactions/transactions.contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const SCHEDULE_KINDS = ['bill', 'subscription', 'transfer', 'income'] as const;

export const RecurrenceRule = z
  .object({
    every: z.number().int().min(1).max(999),
    unit: z.enum(['day', 'week', 'month', 'year']),
    /** Day of month 1–31, or 0 for last day of month (TECH-SPEC 6.4). */
    dayOfMonth: z.number().int().min(0).max(31).nullable(),
    weekday: z.number().int().min(0).max(6).nullable().meta({ description: '0 = Sunday, when unit is week.' }),
  })
  .meta({ id: 'RecurrenceRule' });

export const ScheduleEnd = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('never') }),
  z.object({ kind: z.literal('after'), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('on'), date: LocalDate }),
]);

export const ReminderRule = z
  .object({
    daysBefore: z.array(z.enum(['0', '1', '3', '7'])).min(1),
    hideAmountOnLockScreen: z.boolean().default(true),
  })
  .meta({ id: 'ReminderRule' });

export const Schedule = z
  .object({
    id: z.string(),
    kind: z.enum(SCHEDULE_KINDS),
    name: z.string(),
    payeeId: z.string().nullable(),
    accountId: z.string().nullable().meta({ description: 'Account money leaves or enters.' }),
    categoryId: z.string().nullable(),
    toAccountId: z.string().nullable().optional().meta({ description: 'Transfer destination account.' }),
    amount: MinorAmount.meta({ description: 'Positive; exact or the midpoint when approximate.' }),
    amountApproximate: z.boolean(),
    recurrence: RecurrenceRule,
    startDate: LocalDate,
    end: ScheduleEnd,
    autoPost: z.boolean().meta({ description: '"Create the transaction for me".' }),
    reminder: ReminderRule.nullable(),
    nextDate: LocalDate.nullable(),
    status: z.enum(['active', 'paused', 'cancelled']),
    cancelledAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Schedule' });

export const OccurrenceStatus = z.enum(['scheduled', 'due', 'overdue', 'paid', 'received', 'missed', 'skipped']);

export const Occurrence = z
  .object({
    id: z.string(),
    scheduleId: z.string(),
    date: LocalDate,
    amount: MinorAmount,
    status: OccurrenceStatus,
    matchedTransactionId: z.string().nullable(),
    paidAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Occurrence' });

export const RecurringCandidate = z
  .object({
    payeeId: z.string().nullable(),
    payeeName: z.string(),
    recurrence: RecurrenceRule,
    averageAmount: MinorAmount,
    lastDate: LocalDate,
    confidence: z.enum(['strong', 'likely']),
    sampleTransactionIds: z.array(z.string()).max(20),
  })
  .meta({ id: 'RecurringCandidate' });

export const PlanMonthSummary = z
  .object({
    month: Month,
    comingIn: MinorAmount,
    goingOut: MinorAmount,
    leftAfterBills: MinorAmount,
    missedCount: z.number().int(),
    matchBannerCount: z.number().int().meta({ description: 'Transactions that look like bills this month.' }),
  })
  .meta({ id: 'PlanMonthSummary' });

export const ScheduleParams = WorkspaceParams.extend({ scheduleId: Uuid });
/** UUID or FE composite `scheduleId:date` (sync mark-paid). */
export const OccurrenceParams = WorkspaceParams.extend({
  occurrenceId: z.string().min(1).max(80),
});
export const PlanMonthParams = WorkspaceParams.extend({ month: Month });

const tag = 'Plan';
const base = '/v1/workspaces/:workspaceId/schedules';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const scheduleRoutes = {
  list: defineRoute({
    name: 'listSchedules',
    method: 'GET',
    path: base,
    tag,
    summary: 'Bills, subscriptions, transfers and income schedules',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({
      kind: z.enum(SCHEDULE_KINDS).optional(),
      status: z.enum(['active', 'paused', 'cancelled', 'all']).default('active'),
      ...PageQuery,
    }),
    status: 200,
    response: z.object({ items: z.array(Schedule), nextCursor: z.string().nullable() }).meta({ id: 'SchedulePage' }),
    errors: [400, 401, 404],
  }),
  create: defineRoute({
    name: 'createSchedule',
    method: 'POST',
    path: base,
    tag,
    summary: 'Add a recurring bill, subscription, transfer or income schedule',
    access: editor,
    params: WorkspaceParams,
    body: z
      .object({
        id: Uuid.optional(),
        kind: z.enum(SCHEDULE_KINDS),
        name: z.string().trim().min(1).max(120),
        payeeId: Uuid.nullable().optional(),
        accountId: Uuid.nullable().optional(),
        categoryId: Uuid.nullable().optional(),
        toAccountId: Uuid.nullable().optional(),
        amount: MinorAmount,
        amountApproximate: z.boolean().default(false),
        recurrence: RecurrenceRule,
        startDate: LocalDate,
        end: ScheduleEnd.default({ kind: 'never' }),
        autoPost: z.boolean().default(false),
        reminder: ReminderRule.nullable().optional(),
      })
      .meta({ id: 'CreateScheduleBody' }),
    status: 201,
    response: Schedule,
    errors: [400, 401, 403, 404, 409],
  }),
  get: defineRoute({
    name: 'getSchedule',
    method: 'GET',
    path: `${base}/:scheduleId`,
    tag,
    summary: 'One schedule',
    access: viewer,
    params: ScheduleParams,
    status: 200,
    response: Schedule,
    errors: [400, 401, 404],
  }),
  update: defineRoute({
    name: 'updateSchedule',
    method: 'PATCH',
    path: `${base}/:scheduleId`,
    tag,
    summary: 'Edit a schedule',
    access: editor,
    params: ScheduleParams,
    body: z
      .object({
        baseVersion: BaseVersion,
        name: z.string().trim().min(1).max(120).optional(),
        payeeId: Uuid.nullable().optional(),
        accountId: Uuid.nullable().optional(),
        categoryId: Uuid.nullable().optional(),
        toAccountId: Uuid.nullable().optional(),
        amount: MinorAmount.optional(),
        amountApproximate: z.boolean().optional(),
        recurrence: RecurrenceRule.optional(),
        startDate: LocalDate.optional(),
        end: ScheduleEnd.optional(),
        autoPost: z.boolean().optional(),
        reminder: ReminderRule.nullable().optional(),
        status: z.enum(['active', 'paused']).optional(),
      })
      .meta({ id: 'UpdateScheduleBody' }),
    status: 200,
    response: Schedule,
    errors: [400, 401, 403, 404, 409],
  }),
  cancel: defineRoute({
    name: 'cancelSchedule',
    method: 'POST',
    path: `${base}/:scheduleId/cancel`,
    tag,
    summary: 'Stop a schedule',
    access: editor,
    params: ScheduleParams,
    body: z.object({ baseVersion: BaseVersion }),
    status: 200,
    response: Schedule,
    errors: [400, 401, 403, 404, 409],
  }),
  listOccurrences: defineRoute({
    name: 'listOccurrences',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/plan/:month/occurrences',
    tag,
    summary: 'Occurrences for a calendar month',
    description: 'Powers list and calendar on Bills & recurring (DESIGN page 12).',
    access: viewer,
    params: PlanMonthParams,
    query: z.object({ scheduleId: Uuid.optional() }),
    status: 200,
    response: z
      .object({ occurrences: z.array(Occurrence), schedules: z.array(Schedule) })
      .meta({ id: 'OccurrenceList' }),
    errors: [400, 401, 404],
  }),
  markPaid: defineRoute({
    name: 'markOccurrencePaid',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/plan/occurrences/:occurrenceId/mark-paid',
    tag,
    summary: 'Mark a bill paid or match an existing transaction',
    description: 'Second mark answers 409 `already_paid` with the first payment date (DESIGN page 12).',
    access: editor,
    params: OccurrenceParams,
    body: z
      .object({
        matchTransactionId: Uuid.optional().meta({ description: 'Pick a suggested transaction.' }),
        create: z
          .object({
            date: LocalDate,
            amount: MinorAmount.optional(),
            notes: z.string().max(500).nullable().optional(),
          })
          .optional()
          .meta({ description: 'Or create a new expense or transfer.' }),
      })
      .meta({ id: 'MarkOccurrencePaidBody' }),
    status: 200,
    response: z
      .object({ occurrence: Occurrence, transaction: Transaction.nullable() })
      .meta({ id: 'MarkOccurrencePaidResult' }),
    errors: [400, 401, 403, 404, 409],
  }),
  markReceived: defineRoute({
    name: 'markOccurrenceReceived',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/plan/occurrences/:occurrenceId/mark-received',
    tag,
    summary: 'Mark expected income received or match',
    access: editor,
    params: OccurrenceParams,
    body: z
      .object({
        matchTransactionId: Uuid.optional(),
        create: z
          .object({
            date: LocalDate,
            amount: MinorAmount.optional(),
            notes: z.string().max(500).nullable().optional(),
          })
          .optional(),
      })
      .meta({ id: 'MarkOccurrenceReceivedBody' }),
    status: 200,
    response: z
      .object({ occurrence: Occurrence, transaction: Transaction.nullable() })
      .meta({ id: 'MarkOccurrenceReceivedResult' }),
    errors: [400, 401, 403, 404, 409],
  }),
  unmark: defineRoute({
    name: 'unmarkOccurrence',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/plan/occurrences/:occurrenceId/unmark',
    tag,
    summary: 'Undo mark paid / received (PU-26)',
    description:
      'Unlinks the occurrence from its matched transaction and returns it to due/scheduled. Keeps the transaction.',
    access: editor,
    params: OccurrenceParams,
    body: z
      .object({
        scheduleId: Uuid.optional().meta({ description: 'When occurrenceId is a composite key, optional.' }),
        date: LocalDate.optional(),
      })
      .meta({ id: 'UnmarkOccurrenceBody' }),
    status: 200,
    response: z.object({ occurrence: Occurrence }).meta({ id: 'UnmarkOccurrenceResult' }),
    errors: [400, 401, 403, 404, 409],
  }),
  findRecurring: defineRoute({
    name: 'findRecurringSchedules',
    method: 'POST',
    path: `${base}/find-recurring`,
    tag,
    summary: 'Detect repeating payees in transaction history',
    access: viewer,
    params: WorkspaceParams,
    body: z.object({ from: LocalDate.optional(), to: LocalDate.optional() }),
    status: 200,
    response: z.object({ candidates: z.array(RecurringCandidate) }).meta({ id: 'RecurringCandidates' }),
    errors: [400, 401, 404],
  }),
  planSummary: defineRoute({
    name: 'getPlanMonthSummary',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/plan/:month',
    tag,
    summary: 'Coming in, going out and missed counts for a month',
    access: viewer,
    params: PlanMonthParams,
    status: 200,
    response: PlanMonthSummary,
    errors: [400, 401, 404],
  }),
};

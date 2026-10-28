import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, LocalDate, MinorAmount, Month, Uuid } from '../../common/http/schemas.js';
import { RecurrenceRule, ReminderRule, Schedule } from '../schedules/schedules.contract.js';
import { Transaction } from '../transactions/transactions.contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const INCOME_STREAM_KINDS = ['regular', 'varies', 'irregular', 'passive'] as const;
export const TAX_CLASSES = ['paye', 'self_employed', 'rental', 'investment', 'other'] as const;

export const GrossDeduction = z
  .object({
    label: z.string().max(60),
    amount: MinorAmount.optional(),
    percentBasisPoints: z.number().int().min(0).max(100_00).optional(),
    categoryId: Uuid.nullable()
      .optional()
      .meta({ description: 'PAYE → Taxes expense; pension/NHF → asset accounts (E24).' }),
    ledgerAccountId: Uuid.nullable().optional(),
  })
  .meta({ id: 'GrossDeduction' });

export const IncomeRoutingRule = z
  .object({
    goalId: Uuid.nullable(),
    categoryId: Uuid.nullable(),
    amount: MinorAmount.optional(),
    percentBasisPoints: z.number().int().min(0).max(100_00).optional(),
    remainderToBudget: z.boolean().optional(),
  })
  .meta({ id: 'IncomeRoutingRule' });

export const IncomeStream = Schedule.extend({
  streamKind: z.enum(INCOME_STREAM_KINDS),
  employerOrSource: z.string().nullable(),
  taxClass: z.enum(TAX_CLASSES),
  countInBudget: z.boolean(),
  recordAs: z.enum(['take_home', 'gross']),
  grossAmount: MinorAmount.nullable(),
  deductions: z.array(GrossDeduction),
  routing: z.array(IncomeRoutingRule),
  amountRange: z
    .object({ min: MinorAmount, max: MinorAmount })
    .nullable()
    .meta({ description: 'For varies streams (DESIGN page 13).' }),
  steadinessDots: z
    .array(z.enum(['on_time', 'partial', 'late', 'missed']))
    .max(6)
    .meta({ description: 'Last six occurrences for UI; computed on read.' }),
  expectedThisMonth: MinorAmount,
  receivedThisMonth: MinorAmount,
}).meta({ id: 'IncomeStream' });

export const IncomeMonthSummary = z
  .object({
    month: Month,
    expected: MinorAmount,
    received: MinorAmount,
    stillToCome: MinorAmount,
    steadinessPercent: z.number().int().min(0).max(100).nullable(),
  })
  .meta({ id: 'IncomeMonthSummary' });

export const UnmatchedIncome = z
  .object({
    transaction: Transaction,
    suggestedStreamIds: z.array(z.string()),
  })
  .meta({ id: 'UnmatchedIncome' });

export const IncomeMonthParams = WorkspaceParams.extend({ month: Month });
export const StreamParams = WorkspaceParams.extend({ streamId: Uuid });

const tag = 'Income';
const base = '/v1/workspaces/:workspaceId/income';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const incomeRoutes = {
  getMonth: defineRoute({
    name: 'getIncomeMonth',
    method: 'GET',
    path: `${base}/:month`,
    tag,
    summary: 'Expected, received and steadiness for a month',
    access: viewer,
    params: IncomeMonthParams,
    status: 200,
    response: z
      .object({
        summary: IncomeMonthSummary,
        streams: z.array(IncomeStream),
        unmatched: z.array(UnmatchedIncome),
      })
      .meta({ id: 'IncomeMonth' }),
    errors: [400, 401, 404],
  }),
  createStream: defineRoute({
    name: 'createIncomeStream',
    method: 'POST',
    path: `${base}/streams`,
    tag,
    summary: 'Add an income stream (schedule kind income)',
    access: editor,
    params: WorkspaceParams,
    body: z
      .object({
        id: Uuid.optional(),
        name: z.string().trim().min(1).max(120),
        employerOrSource: z.string().max(120).nullable().optional(),
        streamKind: z.enum(INCOME_STREAM_KINDS),
        accountId: Uuid,
        categoryId: Uuid,
        amount: MinorAmount,
        amountRange: z.object({ min: MinorAmount, max: MinorAmount }).nullable().optional(),
        amountApproximate: z.boolean().default(false),
        recurrence: RecurrenceRule,
        startDate: LocalDate,
        taxClass: z.enum(TAX_CLASSES),
        countInBudget: z.boolean().default(true),
        recordAs: z.enum(['take_home', 'gross']).default('take_home'),
        grossAmount: MinorAmount.nullable().optional(),
        deductions: z.array(GrossDeduction).default([]),
        routing: z.array(IncomeRoutingRule).default([]),
        reminder: ReminderRule.nullable().optional(),
      })
      .meta({ id: 'CreateIncomeStreamBody' }),
    status: 201,
    response: IncomeStream,
    errors: [400, 401, 403, 404, 409],
  }),
  updateStream: defineRoute({
    name: 'updateIncomeStream',
    method: 'PATCH',
    path: `${base}/streams/:streamId`,
    tag,
    summary: 'Edit stream fields including gross salary and routing',
    access: editor,
    params: StreamParams,
    body: z
      .object({
        baseVersion: BaseVersion,
        name: z.string().trim().min(1).max(120).optional(),
        employerOrSource: z.string().max(120).nullable().optional(),
        streamKind: z.enum(INCOME_STREAM_KINDS).optional(),
        accountId: Uuid.optional(),
        categoryId: Uuid.optional(),
        amount: MinorAmount.optional(),
        amountRange: z.object({ min: MinorAmount, max: MinorAmount }).nullable().optional(),
        amountApproximate: z.boolean().optional(),
        taxClass: z.enum(TAX_CLASSES).optional(),
        countInBudget: z.boolean().optional(),
        recordAs: z.enum(['take_home', 'gross']).optional(),
        grossAmount: MinorAmount.nullable().optional(),
        deductions: z.array(GrossDeduction).optional(),
        routing: z.array(IncomeRoutingRule).optional(),
        status: z.enum(['active', 'paused']).optional(),
      })
      .meta({ id: 'UpdateIncomeStreamBody' }),
    status: 200,
    response: IncomeStream,
    errors: [400, 401, 403, 404, 409],
  }),
  linkTransaction: defineRoute({
    name: 'linkIncomeToStream',
    method: 'POST',
    path: `${base}/streams/:streamId/link-transaction`,
    tag,
    summary: 'Attach unmatched income to a stream (partial matching allowed)',
    access: editor,
    params: StreamParams,
    body: z
      .object({
        transactionId: Uuid,
        amount: MinorAmount.optional().meta({ description: 'Portion of the transaction to count toward the stream.' }),
      })
      .meta({ id: 'LinkIncomeToStreamBody' }),
    status: 200,
    response: IncomeStream,
    errors: [400, 401, 403, 404, 409],
  }),
  markOneOff: defineRoute({
    name: 'markIncomeOneOff',
    method: 'POST',
    path: `${base}/transactions/:transactionId/mark-one-off`,
    tag,
    summary: 'Keep income out of steadiness as a one-off',
    access: editor,
    params: WorkspaceParams.extend({ transactionId: Uuid }),
    body: z.object({ baseVersion: BaseVersion.optional() }),
    status: 200,
    response: Transaction,
    errors: [400, 401, 403, 404, 409],
  }),
};

import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, LocalDate, MinorAmount, Uuid } from '../../common/http/schemas.js';
import { RecurrenceRule } from '../schedules/schedules.contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const GoalStatus = z.enum(['in_progress', 'paused', 'completed']);

export const Goal = z
  .object({
    id: z.string(),
    name: z.string(),
    icon: z.string().nullable(),
    targetAmount: MinorAmount,
    targetDate: LocalDate.nullable(),
    accountId: z.string().meta({ description: 'Where the earmarked money sits (TECH-SPEC E18).' }),
    categoryId: z.string().nullable().meta({ description: 'Optional budget category link (DESIGN page 14).' }),
    savedAmount: MinorAmount.meta({ description: 'Sum of allocations minus E19 spending from this goal.' }),
    neededPerMonth: MinorAmount.nullable(),
    status: GoalStatus,
    notes: z.string().nullable(),
    schedule: z
      .object({ amount: MinorAmount, recurrence: RecurrenceRule, startDate: LocalDate })
      .nullable()
      .meta({ description: 'Optional recurring allocation (DESIGN "Schedule" popup).' }),
    completedAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Goal' });

export const Allocation = z
  .object({
    id: z.string(),
    goalId: z.string(),
    date: LocalDate,
    amount: MinorAmount,
    fromAccountId: z
      .string()
      .nullable()
      .meta({ description: 'When different from the goal account, an E6 transfer is posted.' }),
    transactionId: z.string().nullable(),
    kind: z
      .enum(['allocate', 'spend'])
      .meta({ description: 'allocate = E18 earmark; spend = E19 spending from the goal.' }),
    version: z.number().int(),
  })
  .meta({ id: 'GoalAllocation' });

export const GoalParams = WorkspaceParams.extend({ goalId: Uuid });

const tag = 'Goals';
const base = '/v1/workspaces/:workspaceId/goals';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const goalRoutes = {
  list: defineRoute({
    name: 'listGoals',
    method: 'GET',
    path: base,
    tag,
    summary: 'Goals in progress or completed',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({ status: z.enum(['in_progress', 'completed', 'all']).default('in_progress') }),
    status: 200,
    response: z.object({ goals: z.array(Goal) }).meta({ id: 'GoalList' }),
    errors: [400, 401, 404],
  }),
  create: defineRoute({
    name: 'createGoal',
    method: 'POST',
    path: base,
    tag,
    summary: 'Add a savings goal',
    access: editor,
    params: WorkspaceParams,
    body: z
      .object({
        id: Uuid.optional(),
        name: z.string().trim().min(1).max(80),
        icon: z.string().max(40).nullable().optional(),
        targetAmount: MinorAmount,
        targetDate: LocalDate.nullable().optional(),
        accountId: Uuid,
        categoryId: Uuid.nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
      .meta({ id: 'CreateGoalBody' }),
    status: 201,
    response: Goal,
    errors: [400, 401, 403, 404, 409],
  }),
  get: defineRoute({
    name: 'getGoal',
    method: 'GET',
    path: `${base}/:goalId`,
    tag,
    summary: 'Goal with progress',
    access: viewer,
    params: GoalParams,
    status: 200,
    response: z.object({ goal: Goal, allocations: z.array(Allocation) }).meta({ id: 'GoalDetail' }),
    errors: [400, 401, 404],
  }),
  update: defineRoute({
    name: 'updateGoal',
    method: 'PATCH',
    path: `${base}/:goalId`,
    tag,
    summary: 'Edit, pause or mark done',
    access: editor,
    params: GoalParams,
    body: z
      .object({
        baseVersion: BaseVersion,
        name: z.string().trim().min(1).max(80).optional(),
        icon: z.string().max(40).nullable().optional(),
        targetAmount: MinorAmount.optional(),
        targetDate: LocalDate.nullable().optional(),
        accountId: Uuid.optional(),
        categoryId: Uuid.nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
        status: z.enum(['in_progress', 'paused', 'completed']).optional(),
      })
      .meta({ id: 'UpdateGoalBody' }),
    status: 200,
    response: Goal,
    errors: [400, 401, 403, 404, 409],
  }),
  allocate: defineRoute({
    name: 'allocateToGoal',
    method: 'POST',
    path: `${base}/:goalId/allocations`,
    tag,
    summary: 'Add money to a goal (E18)',
    description: 'Same account: allocation only. Different account: transfer plus allocation (TECH-SPEC 6.2 E18).',
    access: editor,
    params: GoalParams,
    body: z
      .object({
        id: Uuid.optional(),
        date: LocalDate,
        amount: MinorAmount,
        fromAccountId: Uuid.nullable().optional(),
      })
      .meta({ id: 'AllocateToGoalBody' }),
    status: 201,
    response: z.object({ allocation: Allocation, goal: Goal }).meta({ id: 'AllocateToGoalResult' }),
    errors: [400, 401, 403, 404, 409],
  }),
  setSchedule: defineRoute({
    name: 'setGoalSchedule',
    method: 'PUT',
    path: `${base}/:goalId/schedule`,
    tag,
    summary: 'Recurring allocation into a goal',
    access: editor,
    params: GoalParams,
    body: z
      .object({
        baseVersion: BaseVersion,
        amount: MinorAmount,
        recurrence: RecurrenceRule,
        startDate: LocalDate,
      })
      .meta({ id: 'SetGoalScheduleBody' }),
    status: 200,
    response: Goal,
    errors: [400, 401, 403, 404, 409],
  }),
  spend: defineRoute({
    name: 'spendFromGoal',
    method: 'POST',
    path: `${base}/:goalId/spend`,
    tag,
    summary: 'Spend from a goal earmark (E19)',
    description:
      'Posts an expense linked by goalId and lowers the earmark. Budget category activity ignores this spend (TECH-SPEC 6.2 E19, 6.6).',
    access: editor,
    params: GoalParams,
    body: z
      .object({
        id: Uuid.optional(),
        date: LocalDate,
        amount: MinorAmount,
        categoryId: Uuid,
        accountId: Uuid.optional().meta({ description: 'Defaults to the goal account.' }),
        payeeId: Uuid.nullable().optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      })
      .meta({ id: 'SpendFromGoalBody' }),
    status: 201,
    response: z
      .object({
        goal: Goal,
        allocation: Allocation,
        transactionId: z.string(),
      })
      .meta({ id: 'SpendFromGoalResult' }),
    errors: [400, 401, 403, 404, 409],
  }),
};

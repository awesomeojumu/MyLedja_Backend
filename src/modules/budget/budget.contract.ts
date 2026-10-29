import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { MinorAmount, Month, Uuid } from '../../common/http/schemas.js';
import { Transaction } from '../transactions/transactions.contract.js';
import { BUDGET_STYLES, WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const BudgetCategory = z
  .object({
    categoryId: z.string(),
    carried: MinorAmount,
    assigned: MinorAmount.meta({ description: 'Planned (envelope) or the limit (tracking).' }),
    activity: MinorAmount.meta({ description: 'Spent: expense lines minus refunds dated in the month.' }),
    available: MinorAmount.meta({ description: 'Envelope: available. Tracking: remaining.' }),
    usedBasisPoints: z
      .number()
      .int()
      .nullable()
      .meta({ description: 'Spent ÷ (planned + carried), in hundredths of a percent.' }),
    state: z.enum(['within_plan', 'near_limit', 'over_plan', 'no_plan']),
    carryOver: z.boolean(),
  })
  .meta({ id: 'BudgetCategory' });

export const BudgetMonth = z
  .object({
    month: z.string(),
    style: z.enum(BUDGET_STYLES),
    categories: z.array(BudgetCategory).meta({ description: 'Spending categories that are not hidden.' }),
    income: z.object({
      received: MinorAmount.meta({ description: 'All income in the month.' }),
      budgetable: MinorAmount.meta({ description: 'Income in categories with "Count in budget" on.' }),
    }),
    planned: MinorAmount,
    spent: MinorAmount,
    leftToPlan: MinorAmount.nullable().meta({
      description: 'Envelope only. Negative reads "Planned ₦X more than you have".',
    }),
    overspentFromLastMonth: MinorAmount,
    overspentCount: z.number().int(),
    leftToSpend: MinorAmount.meta({ description: 'Sum of available (or remaining) above zero across categories.' }),
  })
  .meta({ id: 'BudgetMonth' });

export const MonthParams = WorkspaceParams.extend({ month: Month });
export const BudgetCategoryParams = MonthParams.extend({ categoryId: Uuid });

export const BudgetTemplateRuleKind = z.enum(['monthly', 'saveBy', 'coverBill', 'average', 'cap', 'none']);

export const BudgetTemplateRule = z
  .object({
    categoryId: z.string(),
    assigned: MinorAmount,
    kind: BudgetTemplateRuleKind.optional(),
    meta: z.record(z.string(), z.string()).optional(),
  })
  .meta({ id: 'BudgetTemplateRule' });

export const BudgetTemplate = z
  .object({
    id: z.string(),
    name: z.string(),
    rules: z.array(BudgetTemplateRule),
    version: z.number().int(),
  })
  .meta({ id: 'BudgetTemplate' });

/** Sentinel for Cover overspending from envelope Left to plan (PU-10). */
export const LEFT_TO_PLAN = '__left_to_plan__' as const;

const tag = 'Budget';
const base = '/v1/workspaces/:workspaceId/budget/:month';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const budgetRoutes = {
  get: defineRoute({
    name: 'getBudgetMonth',
    method: 'GET',
    path: base,
    tag,
    summary: 'A month of the budget, in the workspace style',
    description: 'Formulas: TECH-SPEC 6.6. `months=3` returns this month and the two before it, oldest first.',
    access: viewer,
    params: MonthParams,
    query: z.object({ months: z.coerce.number().int().min(1).max(3).default(1) }),
    status: 200,
    response: z.object({ months: z.array(BudgetMonth) }).meta({ id: 'BudgetMonths' }),
    errors: [400, 401, 404],
  }),
  assign: defineRoute({
    name: 'setPlanned',
    method: 'PUT',
    path: `${base}/categories/:categoryId`,
    tag,
    summary: 'Set the planned amount (or limit) for a category',
    access: editor,
    params: BudgetCategoryParams,
    body: z.object({
      assigned: MinorAmount,
      carryOver: z.boolean().optional(),
      note: z.string().trim().max(500).optional(),
    }),
    status: 200,
    response: BudgetMonth,
    errors: [400, 401, 403, 404],
  }),
  move: defineRoute({
    name: 'moveMoney',
    method: 'POST',
    path: `${base}/move`,
    tag,
    summary: 'Move plan from one category to another',
    access: editor,
    params: MonthParams,
    body: z.object({ fromCategoryId: Uuid, toCategoryId: Uuid, amount: MinorAmount }),
    status: 200,
    response: BudgetMonth,
    errors: [400, 401, 403, 404],
  }),
  cover: defineRoute({
    name: 'coverOverspending',
    method: 'POST',
    path: `${base}/cover`,
    tag,
    summary: 'Cover overspent categories from others',
    description: 'fromCategoryId may be `__left_to_plan__` in envelope style (PU-10).',
    access: editor,
    params: MonthParams,
    body: z.object({
      covers: z
        .array(
          z.object({
            categoryId: Uuid,
            fromCategoryId: z.union([Uuid, z.literal(LEFT_TO_PLAN)]),
            amount: MinorAmount,
          }),
        )
        .min(1)
        .max(100),
    }),
    status: 200,
    response: BudgetMonth,
    errors: [400, 401, 403, 404],
  }),
  listTemplates: defineRoute({
    name: 'listBudgetTemplates',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/budget/templates',
    tag,
    summary: 'Saved budget templates for this workspace',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: z.object({ templates: z.array(BudgetTemplate) }).meta({ id: 'BudgetTemplateList' }),
    errors: [400, 401, 404],
  }),
  saveTemplate: defineRoute({
    name: 'saveBudgetTemplate',
    method: 'PUT',
    path: '/v1/workspaces/:workspaceId/budget/templates/:templateId',
    tag,
    summary: 'Create or replace a budget template',
    description: 'Each rule sets a category planned amount when applied (DESIGN.md page 6, Templates). Optional kind/meta keep sentence rules in sync.',
    access: editor,
    params: WorkspaceParams.extend({ templateId: Uuid }),
    body: z.object({
      name: z.string().trim().min(1).max(80),
      rules: z.array(BudgetTemplateRule.extend({ categoryId: Uuid })).min(1).max(200),
    }),
    status: 200,
    response: BudgetTemplate,
    errors: [400, 401, 403, 404],
  }),
  applyTemplate: defineRoute({
    name: 'applyBudgetTemplate',
    method: 'POST',
    path: `${base}/templates/:templateId/apply`,
    tag,
    summary: 'Fill the month from a template',
    description: 'When replace is false, categories that already have a plan keep it (PU-09).',
    access: editor,
    params: MonthParams.extend({ templateId: Uuid }),
    body: z.object({ preview: z.boolean().default(false), replace: z.boolean().default(true) }),
    status: 200,
    response: BudgetMonth,
    errors: [400, 401, 403, 404],
  }),
};

export const Tile = z
  .object({ amount: MinorAmount, lastMonth: MinorAmount, change: MinorAmount })
  .meta({ id: 'DashboardTile' });

export const Dashboard = z
  .object({
    month: z.string(),
    netWorth: z.object({
      amount: MinorAmount,
      partial: z.array(z.string()),
      series: z
        .array(z.object({ month: z.string(), amount: MinorAmount }))
        .meta({ description: '12 month-ends, oldest first.' }),
    }),
    tiles: z.object({
      income: Tile.meta({ description: 'Budgetable income only (TECH-SPEC 6.7).' }),
      spent: Tile,
      netCash: Tile,
      budgetLeft: Tile,
    }),
    leftToSpend: z.object({ amount: MinorAmount, planned: MinorAmount }),
    incomeVsSpending: z
      .array(z.object({ month: z.string(), income: MinorAmount, spent: MinorAmount }))
      .meta({ description: '6 months, oldest first.' }),
    spendingByDay: z
      .array(z.object({ day: z.number().int(), thisMonth: MinorAmount, lastMonth: MinorAmount }))
      .meta({ description: 'Cumulative spending by day of month.' }),
    budgetProgress: z.array(BudgetCategory).meta({ description: 'The five fullest categories.' }),
    whereItWent: z.array(z.object({ categoryId: z.string(), amount: MinorAmount })),
    recent: z.array(Transaction).meta({ description: 'The latest five.' }),
    getStarted: z.object({
      hidden: z.boolean(),
      steps: z.array(z.object({ key: z.string(), done: z.boolean() })),
    }),
    health: z
      .object({
        ready: z.boolean(),
        score: z.number().int().nullable(),
        band: z.enum(['strong', 'okay', 'needs_attention']).nullable(),
        change: z.number().int().nullable(),
      })
      .nullable()
      .meta({ description: 'Phase 5 Health card (DESIGN.md page 5).' }),
    investments: z
      .object({
        value: MinorAmount,
        unrealised: MinorAmount,
        change: MinorAmount.meta({ description: 'Over the last month.' }),
      })
      .nullable()
      .meta({ description: 'Phase 5 Investments card; null with no holdings.' }),
  })
  .meta({ id: 'Dashboard' });

export const dashboardRoutes = {
  get: defineRoute({
    name: 'getDashboard',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/dashboard',
    tag: 'Dashboard',
    summary: 'Phase 1 Dashboard figures for a month',
    description:
      'From period totals (TECH-SPEC 6.7). Transfers, loans, savings and investing never change Income or Spent.',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({ month: Month }),
    status: 200,
    response: Dashboard,
    errors: [400, 401, 404],
  }),
};

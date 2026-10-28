import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, LocalDate, MinorAmount, Month, Uuid } from '../../common/http/schemas.js';
import { EVENT_TYPES } from '../ledger/ledger.types.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';
import { DIMENSIONS, INTERVALS, MEASURES } from './engine.js';
import { PILLARS } from './health.js';

/** DESIGN.md page 19, report types. The tax summary comes later. */
export const REPORT_KINDS = [
  'net_worth',
  'income_vs_expenses',
  'spending_by_category',
  'spending_trends',
  'cash_flow',
  'transaction_calendar',
  'summary_number',
  'budget_analysis',
  'age_of_money',
  'balance_forecast',
  'crossover',
  'investment_performance',
  'debt_payoff',
  'income_steadiness',
  'formula',
  'note',
  'custom',
] as const;
export const ReportKind = z.enum(REPORT_KINDS);

export const CHARTS = ['bar', 'line', 'area', 'donut', 'table', 'number', 'sankey', 'calendar', 'note'] as const;
export const Chart = z.enum(CHARTS);

export const ReportFilters = z
  .object({
    accountIds: z.array(Uuid).max(50).optional(),
    categoryIds: z.array(Uuid).max(200).optional(),
    payeeIds: z.array(Uuid).max(200).optional(),
    tagIds: z.array(Uuid).max(50).optional(),
    types: z.array(z.enum(EVENT_TYPES)).max(20).optional(),
  })
  .meta({ id: 'ReportFilters', description: 'The same filters as Transactions (P21-02).' });

export const BuilderSpec = z
  .object({
    show: z.enum(MEASURES),
    groupBy: z.enum(DIMENSIONS),
    splitBy: z.enum(DIMENSIONS).nullable().default(null),
    chart: Chart.default('bar'),
    filters: ReportFilters.default({}),
  })
  .meta({ id: 'BuilderSpec', description: 'Report builder: show, group by, split by and chart (DESIGN.md page 21).' });

/** How a card on a dashboard picks its dates. */
export const RANGE_PRESETS = [
  'this_month',
  'last_month',
  'last_3_months',
  'this_year',
  'last_12_months',
  'all',
] as const;
export const RangePreset = z.enum(RANGE_PRESETS);

export const RunBody = z
  .object({
    kind: ReportKind,
    from: LocalDate,
    to: LocalDate,
    interval: z.enum(INTERVALS).default('month'),
    compare: z.boolean().default(false).meta({ description: 'Also return the previous period of the same length.' }),
    filters: ReportFilters.default({}),
    spec: BuilderSpec.optional().meta({ description: 'custom and summary_number: what to show.' }),
    savedReportId: Uuid.optional().meta({ description: 'custom: run a saved builder report.' }),
    formula: z
      .string()
      .max(200)
      .optional()
      .meta({ description: 'formula: an expression over income, spending, net, assets, debts and net_worth.' }),
    monthsAhead: z.number().int().min(3).max(12).default(6).meta({ description: 'balance_forecast only.' }),
  })
  .meta({ id: 'RunReportBody' });

const TableRow = z.object({
  key: z.string(),
  label: z.string(),
  values: z.array(z.string()),
  total: z.string(),
});

export const ReportTable = z
  .object({
    columns: z.array(z.object({ key: z.string(), label: z.string() })),
    rows: z.array(TableRow),
    columnTotals: z.array(z.string()),
    total: z.string(),
  })
  .meta({
    id: 'ReportTable',
    description:
      'Every number in the chart, with totals (P20-02). The chart draws exactly this table: one series per column, one point per row.',
  });

export const ReportResult = z
  .object({
    kind: ReportKind,
    from: LocalDate,
    to: LocalDate,
    interval: z.enum(INTERVALS),
    chart: Chart,
    unit: z.enum(['money', 'count', 'days', 'basis_points']),
    table: ReportTable,
    previous: ReportTable.nullable(),
    finding: z
      .object({
        key: z.string().meta({ description: 'What the title says, for the app to phrase ("spending_fell").' }),
        amount: MinorAmount.nullable(),
        changeBasisPoints: z.string().nullable(),
        previousFrom: LocalDate.nullable(),
      })
      .nullable()
      .meta({ description: 'What the card found, so its title can say it (P19-01).' }),
    drill: z
      .record(z.string(), ReportFilters.extend({ from: LocalDate, to: LocalDate }))
      .meta({ description: 'For each row key: the Transactions filters behind it (P20-03).' }),
    partial: z.array(z.string()),
    note: z.string().nullable().meta({ description: 'note: the card text (Markdown).' }),
  })
  .meta({ id: 'ReportResult' });

export const ReportCard = z
  .object({
    id: Uuid,
    kind: ReportKind,
    title: z.string().max(80).nullable().default(null),
    savedReportId: Uuid.nullable().default(null),
    range: RangePreset.default('this_month'),
    interval: z.enum(INTERVALS).default('month'),
    chart: Chart.nullable().default(null),
    spec: BuilderSpec.nullable().default(null),
    formula: z.string().max(200).nullable().default(null),
    text: z.string().max(4000).nullable().default(null),
    layout: z
      .object({
        x: z.number().int().min(0).max(11),
        y: z.number().int().min(0).max(1000),
        w: z.number().int().min(1).max(12),
        h: z.number().int().min(1).max(12),
      })
      .meta({ description: '12 columns on web; phones show cards in y order.' }),
    hidden: z.boolean().default(false),
  })
  .meta({ id: 'ReportCard' });

export const ReportDashboard = z
  .object({
    id: z.string(),
    name: z.string(),
    sortOrder: z.number().int(),
    cards: z.array(ReportCard),
    version: z.number().int(),
  })
  .meta({ id: 'ReportDashboard' });

export const SavedReport = z
  .object({ id: z.string(), name: z.string(), spec: BuilderSpec, version: z.number().int() })
  .meta({ id: 'SavedReport' });

export const CashFlowBand = z
  .object({
    key: z.string(),
    side: z.enum(['in', 'out']),
    kind: z.enum([
      'income',
      'borrowed',
      'collected',
      'returns',
      'transfers',
      'spending',
      'goals',
      'debt_payments',
      'lent',
      'investments',
      'left_over',
      'shortfall',
    ]),
    categoryId: z.string().nullable(),
    groupId: z.string().nullable(),
    label: z.string(),
    amount: MinorAmount,
    shareBasisPoints: z.string().nullable().meta({ description: 'Share of income (P22-03).' }),
  })
  .meta({ id: 'CashFlowBand' });

export const CashFlow = z
  .object({
    from: LocalDate,
    to: LocalDate,
    bands: z.array(CashFlowBand),
    tiles: z.object({
      in: MinorAmount,
      out: MinorAmount.meta({ description: 'Everything that went out, not counting what was left over.' }),
      savedBasisPoints: z.string().nullable().meta({ description: 'Left over ÷ income.' }),
    }),
    groups: z
      .array(
        z.object({
          key: z.string(),
          label: z.string(),
          kind: z.string(),
          amount: MinorAmount,
          shareBasisPoints: z.string().nullable(),
          previous: MinorAmount,
          change: MinorAmount,
          categories: z.array(z.object({ categoryId: z.string(), label: z.string(), amount: MinorAmount })),
        }),
      )
      .meta({ description: 'The table under the diagram: each group with amount, share and change (P22-05).' }),
  })
  .meta({ id: 'CashFlow' });

export const HealthSettings = z
  .object({
    cashAccountIds: z
      .array(Uuid)
      .nullable()
      .meta({ description: 'Accounts that count as cash. Null: bank, cash, wallet and savings (TECH-SPEC 6.10).' }),
    targetMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]),
    countInvestments: z.boolean(),
  })
  .meta({ id: 'HealthSettings' });

export const HealthPillar = z
  .object({
    key: z.enum(PILLARS),
    value: z.string().nullable().meta({ description: 'Basis points; runway in hundredths of a month.' }),
    score: z.number().int().nullable(),
    used: z.record(z.string(), z.string()).meta({ description: 'The numbers the formula used (P23-02).' }),
  })
  .meta({ id: 'HealthPillar' });

export const HealthInputs = z
  .object({
    months: z.array(
      z.object({
        month: Month,
        income: MinorAmount,
        spending: MinorAmount,
        essential: MinorAmount,
        hasData: z.boolean(),
      }),
    ),
    liquidCash: MinorAmount,
    recentBorrowing: MinorAmount,
    debtPayments: z.array(MinorAmount),
    bills: z.object({ due: z.number().int(), onTime: z.number().int() }),
    budget: z.object({ planned: z.number().int(), within: z.number().int(), overspent: z.number().int() }),
    historyDays: z.number().int(),
    targetMonths: z.number().int(),
  })
  .meta({
    id: 'HealthInputs',
    description: 'What the score was worked out from, so the stress test runs on the device.',
  });

export const HealthPage = z
  .object({
    month: Month,
    ready: z.boolean(),
    score: z.number().int().nullable(),
    band: z.enum(['strong', 'okay', 'needs_attention']).nullable(),
    change: z.number().int().nullable().meta({ description: 'Points since last month.' }),
    reason: z
      .object({ strongest: z.enum(PILLARS).nullable(), weakest: z.enum(PILLARS).nullable() })
      .meta({ description: 'For the one plain sentence about why (P23-01).' }),
    pillars: z.array(HealthPillar),
    missing: z.array(z.enum(['two_months', 'three_pillars'])),
    basedOnDataUpTo: LocalDate.nullable().meta({ description: 'Set when a counted account is 30 days stale.' }),
    advice: z.array(
      z.object({
        pillar: z.enum(PILLARS),
        link: z.enum(['budget', 'goals', 'debts', 'plan']),
        amount: MinorAmount.nullable(),
        count: z.number().int().nullable(),
      }),
    ),
    history: z.array(z.object({ month: Month, score: z.number().int().nullable() })),
    inputs: HealthInputs,
    settings: HealthSettings,
  })
  .meta({ id: 'HealthPage' });

const tag = 'Reports';
const base = '/v1/workspaces/:workspaceId/reports';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;
const DashboardParams = WorkspaceParams.extend({ dashboardId: Uuid });
const SavedParams = WorkspaceParams.extend({ reportId: Uuid });

export const reportRoutes = {
  run: defineRoute({
    name: 'runReport',
    method: 'POST',
    path: `${base}/run`,
    tag,
    summary: 'Run a report: its table, which is also its chart, and what it found',
    description:
      'Read-only, so it takes no operation id. Every report reads the event type, not the sign (DESIGN.md 9.2).',
    access: viewer,
    params: WorkspaceParams,
    body: RunBody,
    status: 200,
    response: ReportResult,
    errors: [400, 401, 404],
    idempotent: false,
  }),
  listDashboards: defineRoute({
    name: 'listReportDashboards',
    method: 'GET',
    path: `${base}/dashboards`,
    tag,
    summary: 'Report dashboards; Overview and Year in review are made the first time',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: z.object({ dashboards: z.array(ReportDashboard) }).meta({ id: 'ReportDashboardList' }),
    errors: [401, 404],
  }),
  createDashboard: defineRoute({
    name: 'createReportDashboard',
    method: 'POST',
    path: `${base}/dashboards`,
    tag,
    summary: 'Make a new dashboard',
    access: editor,
    params: WorkspaceParams,
    body: z
      .object({ id: Uuid.optional(), name: z.string().trim().min(1, { error: 'Enter a name' }).max(60) })
      .meta({ id: 'CreateReportDashboardBody' }),
    status: 201,
    response: ReportDashboard,
    errors: [400, 401, 403, 404],
  }),
  updateDashboard: defineRoute({
    name: 'updateReportDashboard',
    method: 'PATCH',
    path: `${base}/dashboards/:dashboardId`,
    tag,
    summary: 'Rename, or change its cards and layout',
    access: editor,
    params: DashboardParams,
    body: z
      .object({
        baseVersion: BaseVersion,
        name: z.string().trim().min(1).max(60).optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
        cards: z.array(ReportCard).max(40).optional(),
      })
      .meta({ id: 'UpdateReportDashboardBody' }),
    status: 200,
    response: ReportDashboard,
    errors: [400, 401, 403, 404, 409],
  }),
  deleteDashboard: defineRoute({
    name: 'deleteReportDashboard',
    method: 'DELETE',
    path: `${base}/dashboards/:dashboardId`,
    tag,
    summary: 'Delete a dashboard',
    access: editor,
    params: DashboardParams,
    status: 204,
    response: null,
    errors: [400, 401, 403, 404],
  }),
  listSaved: defineRoute({
    name: 'listSavedReports',
    method: 'GET',
    path: `${base}/saved`,
    tag,
    summary: 'Reports made in the builder',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: z.object({ reports: z.array(SavedReport) }).meta({ id: 'SavedReportList' }),
    errors: [401, 404],
  }),
  createSaved: defineRoute({
    name: 'createSavedReport',
    method: 'POST',
    path: `${base}/saved`,
    tag,
    summary: 'Save a builder report with a name (P21-03)',
    access: editor,
    params: WorkspaceParams,
    body: z
      .object({
        id: Uuid.optional(),
        name: z.string().trim().min(1, { error: 'Enter a name' }).max(80),
        spec: BuilderSpec,
        dashboardId: Uuid.optional().meta({ description: 'Also add it to this dashboard.' }),
      })
      .meta({ id: 'CreateSavedReportBody' }),
    status: 201,
    response: SavedReport,
    errors: [400, 401, 403, 404],
  }),
  updateSaved: defineRoute({
    name: 'updateSavedReport',
    method: 'PATCH',
    path: `${base}/saved/:reportId`,
    tag,
    summary: 'Change a saved report',
    access: editor,
    params: SavedParams,
    body: z
      .object({
        baseVersion: BaseVersion,
        name: z.string().trim().min(1).max(80).optional(),
        spec: BuilderSpec.optional(),
      })
      .meta({ id: 'UpdateSavedReportBody' }),
    status: 200,
    response: SavedReport,
    errors: [400, 401, 403, 404, 409],
  }),
  deleteSaved: defineRoute({
    name: 'deleteSavedReport',
    method: 'DELETE',
    path: `${base}/saved/:reportId`,
    tag,
    summary: 'Delete a saved report',
    access: editor,
    params: SavedParams,
    status: 204,
    response: null,
    errors: [400, 401, 403, 404],
  }),
  cashFlow: defineRoute({
    name: 'getCashFlow',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/cash-flow',
    tag: 'Cash flow',
    summary: 'Where money came from and where it went (DESIGN.md page 22)',
    description:
      'Income bands add up to Income and spending bands to Spent. Borrowed money is a grey source, never income; goals, debt payments and investments sit apart from spending.',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({
      from: LocalDate,
      to: LocalDate,
      accountIds: z
        .preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(Uuid).max(50))
        .optional(),
      includeTransfers: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
    }),
    status: 200,
    response: CashFlow,
    errors: [400, 401, 404],
  }),
  health: defineRoute({
    name: 'getFinancialHealth',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/health/:month',
    tag: 'Health',
    summary: 'Financial health for a month (DESIGN.md page 23)',
    description:
      'The score needs three pillars with data and 60 days of history; until then `ready` is false and `missing` says why. Advice is chosen by rules (TECH-SPEC 6.10).',
    access: viewer,
    params: WorkspaceParams.extend({ month: Month }),
    status: 200,
    response: HealthPage,
    errors: [400, 401, 404],
  }),
  healthSettings: defineRoute({
    name: 'setHealthSettings',
    method: 'PUT',
    path: '/v1/workspaces/:workspaceId/health-settings',
    tag: 'Health',
    summary: 'Which accounts count as cash, the emergency target, and investments in runway',
    access: editor,
    params: WorkspaceParams,
    body: HealthSettings,
    status: 200,
    response: HealthSettings,
    errors: [400, 401, 403, 404],
  }),
};

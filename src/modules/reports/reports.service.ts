import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { divRoundHalfAwayFromZero, parseMinor, toMinorString } from '../../common/money/money.js';
import { localDateString } from '../../common/time/workspace-clock.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { BudgetService } from '../budget/budget.service.js';
import type {
  CategoriesRepository,
  GroupsRepository,
  PayeesRepository,
  TagsRepository,
} from '../categories/categories.repository.js';
import type { CurrenciesService, Converter } from '../currencies/currencies.service.js';
import type { GoalAllocationsRepository } from '../goals/goals.repository.js';
import type { IncomeService } from '../income/income.service.js';
import type { InvestmentsService } from '../investments/investments.service.js';
import type { LedgerAccountDoc, TransactionDoc } from '../ledger/ledger.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { monthRange } from '../ledger/read.js';
import { occurrencesInMonth } from '../schedules/recurrence.js';
import type { OccurrencesRepository, SchedulesRepository } from '../schedules/schedules.repository.js';
import type { HealthSettingsDoc, WorkspacesRepository } from '../workspaces/workspaces.repository.js';
import {
  ageOfMoney,
  bucketsBetween,
  cashFlow as cashFlowBands,
  changeBasisPoints,
  type Dimension,
  type Fact,
  type Filters,
  type Interval,
  type Lookup,
  previousRange,
  run,
  type Spec,
  type Table,
} from './engine.js';
import { evaluate, FormulaError } from './formula.js';
import { health, type HealthInput, PILLARS } from './health.js';
import type {
  CashFlow,
  HealthPage,
  ReportCard,
  ReportDashboard,
  ReportResult,
  RunBody,
  SavedReport,
  BuilderSpec,
} from './reports.contract.js';
import type {
  ReportDashboardDoc,
  ReportDashboardsRepository,
  SavedReportDoc,
  SavedReportsRepository,
} from './reports.repository.js';

export type ReportsDeps = {
  database: Database;
  dashboards: ReportDashboardsRepository;
  saved: SavedReportsRepository;
  ledger: LedgerService;
  categories: CategoriesRepository;
  groups: GroupsRepository;
  payees: PayeesRepository;
  tags: TagsRepository;
  workspaces: WorkspacesRepository;
  budget: BudgetService;
  investments: InvestmentsService;
  currencies: CurrenciesService;
  income: IncomeService;
  schedules: SchedulesRepository;
  occurrences: OccurrencesRepository;
  goalAllocations: GoalAllocationsRepository;
  audit: AuditRepository;
  now: () => Date;
};

type Result = z.input<typeof ReportResult>;
type Kind = z.output<typeof RunBody>['kind'];
type RunInput = z.output<typeof RunBody>;

/** Money is spent from these (TECH-SPEC 6.10's default "counts as cash" is the same set without cards). */
const CASH_TYPES = new Set(['bank', 'cash', 'wallet', 'savings', 'card']);
const LIQUID_TYPES = new Set(['bank', 'cash', 'wallet', 'savings']);
const INVESTMENT_TYPES = new Set(['investment', 'pension', 'fixed_deposit']);
const NONE = 'none';
const ESSENTIAL_GROUPS = new Set(['home', 'food', 'getting around', 'health', 'education']);

const DEFAULT_HEALTH: HealthSettingsDoc = { cashAccountIds: null, targetMonths: 6, countInvestments: false };

/** A workspace's names and kinds, loaded once per request. */
type Book = {
  look: Lookup;
  accounts: LedgerAccountDoc[];
  byId: Map<string, LedgerAccountDoc>;
  currency: string;
  timeZone: string;
  today: string;
  convert: Converter;
  essentialLedgerIds: Set<string>;
  categoryNames: Map<string, string>;
  groupNames: Map<string, string>;
};

const tableOut = (t: Table): z.input<typeof ReportResult>['table'] => ({
  columns: t.columns,
  rows: t.rows.map((r) => ({
    key: r.key,
    label: r.label,
    values: r.values.map(String),
    total: String(r.total),
  })),
  columnTotals: t.columnTotals.map(String),
  total: String(t.total),
});

/** A hand-made table: rows of values under the given columns. `total` is each row's headline figure. */
function table(
  columns: { key: string; label: string }[],
  rows: { key: string; label: string; values: bigint[]; total?: bigint }[],
  closing = false,
): Table {
  const out = rows.map((r) => ({ ...r, total: r.total ?? r.values.reduce((s, v) => s + v, 0n) }));
  // For balances (net worth, debt), the totals are the closing values, not sums of points in time.
  const columnTotals = closing
    ? (out.at(-1)?.values ?? columns.map(() => 0n))
    : columns.map((_, i) => out.reduce((s, r) => s + r.values[i]!, 0n));
  const total = closing ? (out.at(-1)?.total ?? 0n) : out.reduce((s, r) => s + r.total, 0n);
  return { columns, rows: out, columnTotals, total };
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isMonthStart = (d: string) => d.endsWith('-01');
const isMonthEnd = (d: string) => monthBounds(d.slice(0, 7)).to === d;
const minDate = (a: string, b: string) => (a < b ? a : b);

/** Reports, cash flow and Health (build plan B5.2 to B5.4). Read-only sums, except dashboards and settings. */
export class ReportsService {
  constructor(private readonly d: ReportsDeps) {}

  private async book(ctx: WorkspaceContext): Promise<Book> {
    const [ws, accounts, cats, groups, payees, tags, convert] = await Promise.all([
      this.d.workspaces.get(ctx),
      this.d.ledger.accounts.find(ctx, {}),
      this.d.categories.find(ctx, {}),
      this.d.groups.find(ctx, {}),
      this.d.payees.find(ctx, {}),
      this.d.tags.find(ctx, {}),
      this.d.currencies.converterFor(ctx),
    ]);
    if (!ws) throw Errors.notFound();
    const byId = new Map(accounts.map((a) => [a._id, a]));
    const catById = new Map(cats.map((c) => [c._id, c]));
    const categoryNames = new Map(cats.map((c) => [c._id, c.name]));
    const groupNames = new Map(groups.map((g) => [g._id, g.name]));
    const payeeNames = new Map(payees.map((p) => [p._id, p.name]));
    const tagNames = new Map(tags.map((t) => [t._id, t.name]));
    // Essential: marked so, or by default the Fixed type and the Home, Food, Getting around, Health and
    // Education groups (TECH-SPEC 6.13 decision 6).
    const essential = (c: (typeof cats)[number] | undefined) =>
      !!c &&
      (c.essential || c.type === 'fixed' || ESSENTIAL_GROUPS.has((groupNames.get(c.groupId) ?? '').toLowerCase()));
    const essentialLedgerIds = new Set(
      accounts.filter((a) => a.categoryId && essential(catById.get(a.categoryId))).map((a) => a._id),
    );
    const look: Lookup = {
      kindOf: (id) => byId.get(id)?.kind ?? null,
      categoryOf: (id) => byId.get(id)?.categoryId ?? null,
      groupOf: (c) => catById.get(c)?.groupId ?? null,
      isCash: (id) => {
        const a = byId.get(id);
        return !!a && !a.holdingOf && !a.personDebt && CASH_TYPES.has(a.accountType ?? '');
      },
      label: (dim: Dimension, key: string) => {
        if (key === NONE) return '';
        switch (dim) {
          case 'category':
            return categoryNames.get(key) ?? byId.get(key)?.name ?? '';
          case 'group':
            return groupNames.get(key) ?? '';
          case 'payee':
            return payeeNames.get(key) ?? '';
          case 'account':
            return byId.get(key)?.name ?? '';
          case 'tag':
            return tagNames.get(key) ?? '';
          case 'month':
            return key;
        }
      },
    };
    const today = localDateString(this.d.now(), ws.timeZone);
    return {
      look,
      accounts,
      byId,
      currency: ws.currency,
      timeZone: ws.timeZone,
      today,
      convert,
      essentialLedgerIds,
      categoryNames,
      groupNames,
    };
  }

  /** Every line of every event dated in the range, reversed ones and reversals included (they cancel). */
  private async facts(ctx: WorkspaceContext, b: Book, from: string | null, to: string): Promise<Fact[]> {
    const docs = await this.d.ledger.transactions.find(ctx, { date: { ...(from ? { $gte: from } : {}), $lte: to } });
    const originals = new Map(docs.map((e) => [e._id, e.type]));
    const missing = docs
      .filter((e) => e.links.reversalOf && !originals.has(e.links.reversalOf))
      .map((e) => e.links.reversalOf!);
    if (missing.length) {
      for (const e of await this.d.ledger.transactions.find(ctx, { _id: { $in: missing } }))
        originals.set(e._id, e.type);
    }
    return docs.flatMap((e) => factsOf(e, b, originals));
  }

  /** Period totals as facts dated the 1st of their month: enough for whole-month reports by category. */
  private async totalFacts(ctx: WorkspaceContext, fromMonth: string | null, toMonth: string): Promise<Fact[]> {
    const rows = await this.d.ledger.totals.months(ctx, fromMonth ?? '0000-00', toMonth);
    return rows.flatMap((r) => {
      const date = `${r.month}-01`;
      const base = { date, type: 'period_total', payeeId: null, tagIds: [], accountIds: [] };
      return [
        { ...base, eventId: `${r._id}:d`, ledgerAccountId: r.ledgerAccountId, amount: BigInt(r.debitsMinor) },
        { ...base, eventId: `${r._id}:c`, ledgerAccountId: r.ledgerAccountId, amount: -BigInt(r.creditsMinor) },
      ];
    });
  }

  /** Whole months, grouped by category, group or month, with no filter period totals can't apply. */
  private totalsWill(spec: Spec): boolean {
    const f = spec.filters;
    return (
      isMonthStart(spec.from) &&
      isMonthEnd(spec.to) &&
      (spec.interval === 'month' || spec.interval === 'year') &&
      spec.show !== 'count' &&
      [spec.groupBy, spec.splitBy].every((d) => d === null || d === 'category' || d === 'group' || d === 'month') &&
      !f.accountIds?.length &&
      !f.payeeIds?.length &&
      !f.tagIds?.length &&
      !f.types?.length
    );
  }

  private async runSpec(ctx: WorkspaceContext, b: Book, spec: Spec): Promise<Table> {
    if (this.totalsWill(spec)) {
      const facts = await this.totalFacts(
        ctx,
        spec.show === 'balance' ? null : spec.from.slice(0, 7),
        spec.to.slice(0, 7),
      );
      return run(spec, facts, b.look);
    }
    return run(spec, await this.facts(ctx, b, spec.show === 'balance' ? null : spec.from, spec.to), b.look);
  }

  private drillFor(spec: Pick<Spec, 'groupBy' | 'from' | 'to' | 'interval' | 'filters'>, t: Table): Result['drill'] {
    const out: Record<string, Filters & { from: string; to: string }> = {};
    for (const r of t.rows) {
      const base = { ...spec.filters, from: spec.from, to: spec.to };
      switch (spec.groupBy) {
        case 'category':
          out[r.key] = r.key === NONE ? base : { ...base, categoryIds: [r.key] };
          break;
        case 'payee':
          out[r.key] = r.key === NONE ? base : { ...base, payeeIds: [r.key] };
          break;
        case 'account':
          out[r.key] = r.key === NONE ? base : { ...base, accountIds: [r.key] };
          break;
        case 'tag':
          out[r.key] = r.key === NONE ? base : { ...base, tagIds: [r.key] };
          break;
        case 'month': {
          const range = bucketRange(r.key, spec.interval);
          out[r.key] = {
            ...base,
            from: range.from < spec.from ? spec.from : range.from,
            to: minDate(range.to, spec.to),
          };
          break;
        }
        case 'group':
          out[r.key] = base;
          break;
      }
    }
    return out as Result['drill'];
  }

  async run(ctx: WorkspaceContext, body: RunInput): Promise<Result> {
    if (body.from > body.to) throw Errors.validation('to', 'Choose an end date after the start date.');
    const b = await this.book(ctx);
    const base = { kind: body.kind, from: body.from, to: body.to, interval: body.interval };
    const out = await this.runKind(ctx, b, body);
    return {
      ...base,
      previous: null,
      finding: null,
      drill: {},
      partial: [],
      note: null,
      ...out,
      table: tableOut(out.table),
      ...(out.previous ? { previous: tableOut(out.previous) } : {}),
    } as Result;
  }

  private async runKind(
    ctx: WorkspaceContext,
    b: Book,
    body: RunInput,
  ): Promise<
    Pick<Result, 'chart' | 'unit'> &
      Partial<Pick<Result, 'finding' | 'drill' | 'partial' | 'note'>> & { table: Table; previous?: Table | null }
  > {
    const { from, to, interval } = body;
    const prev = previousRange(from, to);
    const spending = (s: Partial<Spec>): Spec => ({
      show: 'spending',
      groupBy: 'category',
      splitBy: null,
      interval,
      from,
      to,
      filters: body.filters,
      ...s,
    });
    const finding = (now: bigint, before: bigint, measure: string): Result['finding'] => {
      const change = changeBasisPoints(now, before);
      const direction = change === null ? 'new' : change > 0n ? 'rose' : change < 0n ? 'fell' : 'same';
      return {
        key: `${measure}_${direction}`,
        amount: toMinorString(now),
        changeBasisPoints: change === null ? null : String(change),
        previousFrom: prev.from,
      };
    };
    switch (body.kind as Kind) {
      case 'spending_by_category': {
        const spec = spending({});
        const t = await this.runSpec(ctx, b, spec);
        const p = await this.runSpec(ctx, b, { ...spec, from: prev.from, to: prev.to });
        return {
          chart: 'donut',
          unit: 'money',
          table: t,
          previous: body.compare ? p : null,
          finding: finding(t.total, p.total, 'spending'),
          drill: this.drillFor(spec, t),
        };
      }
      case 'income_vs_expenses': {
        const spec = spending({ show: 'income', groupBy: 'month' });
        const income = await this.runSpec(ctx, b, spec);
        const spent = await this.runSpec(ctx, b, { ...spec, show: 'spending' });
        const t = table(
          [
            { key: 'income', label: 'income' },
            { key: 'spending', label: 'spending' },
          ],
          income.rows.map((r, i) => {
            const s = spent.rows[i]?.total ?? 0n;
            return { key: r.key, label: r.label, values: [r.total, s], total: r.total - s };
          }),
        );
        return {
          chart: 'bar',
          unit: 'money',
          table: t,
          finding: finding(t.total, 0n, 'net'),
          drill: this.drillFor(spec, t),
        };
      }
      case 'spending_trends': {
        const now = await this.facts(ctx, b, from, to);
        const before = await this.facts(ctx, b, prev.from, prev.to);
        const days = bucketsBetween(from, to, 'day');
        const cumulative = (facts: Fact[], start: string) => {
          const spent = run(
            spending({ groupBy: 'month', interval: 'day', from: start, to: addDays(start, days.length - 1) }),
            facts,
            b.look,
          );
          let sum = 0n;
          return spent.rows.map((r) => (sum += r.total));
        };
        const a = cumulative(now, from);
        const p = cumulative(before, prev.from);
        const t = table(
          [
            { key: 'this', label: 'this' },
            { key: 'previous', label: 'previous' },
          ],
          days.map((d, i) => ({ key: d, label: d, values: [a[i] ?? 0n, p[i] ?? 0n], total: a[i] ?? 0n })),
          true,
        );
        return { chart: 'line', unit: 'money', table: t, finding: finding(a.at(-1) ?? 0n, p.at(-1) ?? 0n, 'spending') };
      }
      case 'transaction_calendar': {
        const facts = await this.facts(ctx, b, from, to);
        const day = { interval: 'day' as Interval, groupBy: 'month' as Dimension };
        const income = run(spending({ ...day, show: 'income' }), facts, b.look);
        const spent = run(spending(day), facts, b.look);
        const t = table(
          [
            { key: 'in', label: 'in' },
            { key: 'out', label: 'out' },
          ],
          income.rows.map((r, i) => ({
            key: r.key,
            label: r.key,
            values: [r.total, spent.rows[i]?.total ?? 0n],
            total: r.total - (spent.rows[i]?.total ?? 0n),
          })),
        );
        return { chart: 'calendar', unit: 'money', table: t, drill: this.drillFor({ ...spending(day) }, t) };
      }
      case 'summary_number': {
        const spec = {
          ...spending({ groupBy: 'month' }),
          ...(body.spec ? { show: body.spec.show, filters: { ...body.spec.filters, ...body.filters } } : {}),
        };
        const t = await this.runSpec(ctx, b, { ...spec, groupBy: 'month', splitBy: null, interval: 'year' });
        const p = await this.runSpec(ctx, b, {
          ...spec,
          groupBy: 'month',
          splitBy: null,
          interval: 'year',
          from: prev.from,
          to: prev.to,
        });
        const one = table([{ key: 'total', label: 'total' }], [{ key: 'total', label: 'total', values: [t.total] }]);
        return {
          chart: 'number',
          unit: spec.show === 'count' ? 'count' : 'money',
          table: one,
          finding: finding(t.total, p.total, spec.show),
          drill: { total: { ...spec.filters, from, to } } as Result['drill'],
        };
      }
      case 'custom': {
        const saved = body.savedReportId ? await this.d.saved.findOne(ctx, { _id: body.savedReportId }) : null;
        if (body.savedReportId && !saved) throw Errors.notFound();
        const s = saved?.spec ?? body.spec;
        if (!s) throw Errors.validation('spec', 'Choose what the report shows.');
        const spec: Spec = {
          show: s.show,
          groupBy: s.groupBy,
          splitBy: s.splitBy,
          interval,
          from,
          to,
          filters: { ...s.filters, ...body.filters },
        };
        const t = await this.runSpec(ctx, b, spec);
        const p = body.compare ? await this.runSpec(ctx, b, { ...spec, from: prev.from, to: prev.to }) : null;
        return {
          chart: s.chart,
          unit: s.show === 'count' ? 'count' : 'money',
          table: t,
          previous: p,
          finding: s.show === 'balance' ? null : finding(t.total, p?.total ?? 0n, s.show),
          drill: this.drillFor(spec, t),
        };
      }
      case 'net_worth': {
        const months = monthRange(from.slice(0, 7), to.slice(0, 7));
        const points = await this.netWorthAt(
          ctx,
          b,
          months.map((m) => minDate(monthBounds(m).to, minDate(to, b.today))),
        );
        const t = table(
          ['assets', 'debts', 'unrealised', 'adjustments', 'written_off'].map((k) => ({ key: k, label: k })),
          months.map((m, i) => {
            const p = points[i]!;
            return {
              key: m,
              label: m,
              values: [p.assets, p.debts, p.unrealised, p.adjustments, p.writtenOff],
              total: p.assets - p.debts + p.unrealised,
            };
          }),
          true,
        );
        const first = t.rows[0]?.total ?? 0n;
        return {
          chart: 'line',
          unit: 'money',
          table: t,
          finding: finding(t.total, first, 'net_worth'),
          partial: [...new Set(points.flatMap((p) => p.partial))].sort(),
        };
      }
      case 'cash_flow': {
        const flow = await this.cashFlow(ctx, {
          from,
          to,
          accountIds: body.filters.accountIds,
          includeTransfers: false,
        });
        const t = table(
          [{ key: 'amount', label: 'amount' }],
          flow.bands.map((band) => ({ key: band.key, label: band.label, values: [parseMinor(band.amount)] })),
        );
        return { chart: 'sankey', unit: 'money', table: t };
      }
      case 'budget_analysis': {
        const months = monthRange(from.slice(0, 7), to.slice(0, 7));
        const { months: bm } = await this.d.budget.get(ctx, months.at(-1)!, months.length);
        const t = table(
          [
            { key: 'planned', label: 'planned' },
            { key: 'spent', label: 'spent' },
          ],
          bm.map((m) => ({
            key: m.month,
            label: m.month,
            values: [parseMinor(m.planned), parseMinor(m.spent)],
            total: parseMinor(m.planned) - parseMinor(m.spent),
          })),
        );
        return { chart: 'bar', unit: 'money', table: t };
      }
      case 'age_of_money': {
        const ages = ageOfMoney(await this.facts(ctx, b, null, to), b.look);
        const months = monthRange(from.slice(0, 7), to.slice(0, 7));
        const t = table(
          [{ key: 'days', label: 'days' }],
          months.map((m) => ({ key: m, label: m, values: [ages.get(m) ?? 0n] })),
          true,
        );
        return { chart: 'line', unit: 'days', table: t };
      }
      case 'balance_forecast':
        return { chart: 'area', unit: 'money', table: await this.forecast(ctx, b, body.monthsAhead) };
      case 'crossover': {
        const spec = spending({ groupBy: 'month' });
        const facts = await this.facts(ctx, b, from, to);
        const investIncome = run(
          { ...spec, show: 'income' },
          facts.filter((f) => {
            const key = b.byId.get(f.ledgerAccountId)?.systemKey;
            return key === 'investment_income' || key === 'investment_gain' || key === 'interest_earned';
          }),
          b.look,
        );
        const spent = run(spec, facts, b.look);
        const t = table(
          [
            { key: 'investment_income', label: 'investment_income' },
            { key: 'spending', label: 'spending' },
          ],
          investIncome.rows.map((r, i) => ({
            key: r.key,
            label: r.key,
            values: [r.total, spent.rows[i]?.total ?? 0n],
            total: r.total - (spent.rows[i]?.total ?? 0n),
          })),
        );
        const last = t.rows.at(-1);
        return {
          chart: 'line',
          unit: 'money',
          table: t,
          finding: last
            ? {
                key: last.total >= 0n ? 'crossover_reached' : 'crossover_gap',
                amount: toMinorString(last.total < 0n ? -last.total : last.total),
                changeBasisPoints: null,
                previousFrom: null,
              }
            : null,
        };
      }
      case 'investment_performance': {
        const p = await this.d.investments.portfolio(ctx, 'All');
        const t = table(
          ['cost', 'value', 'unrealised', 'realised'].map((k) => ({ key: k, label: k })),
          p.holdings.map((h) => ({
            key: h.id,
            label: h.name,
            values: [h.cost, h.value, h.unrealised, h.realised].map((v) => parseMinor(v)),
            total: parseMinor(h.value),
          })),
        );
        return { chart: 'bar', unit: 'money', table: t, partial: p.partial };
      }
      case 'debt_payoff':
        return this.debtPayoff(ctx, b, from, to);
      case 'income_steadiness': {
        const months = monthRange(from.slice(0, 7), to.slice(0, 7));
        const streams = new Map<string, { label: string; expected: bigint; received: bigint }>();
        for (const m of months) {
          const month = await this.d.income.getMonth(ctx, m);
          for (const s of month.streams) {
            const row = streams.get(s.id) ?? { label: s.name, expected: 0n, received: 0n };
            row.expected += parseMinor(s.expectedThisMonth);
            row.received += parseMinor(s.receivedThisMonth);
            streams.set(s.id, row);
          }
        }
        const t = table(
          [
            { key: 'expected', label: 'expected' },
            { key: 'received', label: 'received' },
          ],
          [...streams].map(([id, s]) => ({
            key: id,
            label: s.label,
            values: [s.expected, s.received],
            total: s.received,
          })),
        );
        return { chart: 'bar', unit: 'money', table: t };
      }
      case 'formula': {
        if (!body.formula) throw Errors.validation('formula', 'Write a formula, for example income - spending');
        const facts = await this.facts(ctx, b, from, to);
        const income = run(spending({ show: 'income', groupBy: 'month', interval: 'year' }), facts, b.look).total;
        const spent = run(spending({ groupBy: 'month', interval: 'year' }), facts, b.look).total;
        const [worth] = await this.netWorthAt(ctx, b, [minDate(to, b.today)]);
        try {
          const r = evaluate(body.formula, {
            income,
            spending: spent,
            net: income - spent,
            assets: worth!.assets + worth!.unrealised,
            debts: worth!.debts,
            net_worth: worth!.assets - worth!.debts + worth!.unrealised,
          });
          const t = table([{ key: 'value', label: 'value' }], [{ key: 'value', label: 'value', values: [r.value] }]);
          return { chart: 'number', unit: r.unit, table: t, partial: worth!.partial };
        } catch (e) {
          if (e instanceof FormulaError) {
            throw new AppError(
              400,
              'formula_unreadable',
              e.reason === 'unknown_name'
                ? 'Use only income, spending, net, assets, debts and net_worth.'
                : e.reason === 'divide_by_zero'
                  ? 'This divides by zero for these dates.'
                  : "We can't work this out. Check the formula, for example income - spending",
              { field: 'formula' },
            );
          }
          throw e;
        }
      }
      case 'note':
        return { chart: 'note', unit: 'money', table: table([], []) };
    }
  }

  /** Assets, debts, unrealised gains and the month's adjustments and write-offs on each date (TECH-SPEC 6.7). */
  private async netWorthAt(ctx: WorkspaceContext, b: Book, dates: string[]) {
    const last = dates.reduce((a, d) => (d > a ? d : a), '0000-00-00');
    const facts = await this.facts(ctx, b, null, last);
    const vals = await this.d.investments.valuationsOn(ctx, dates);
    return dates.map((date) => {
      const balances = new Map<string, bigint>();
      let adjustments = 0n;
      let writtenOff = 0n;
      const month = date.slice(0, 7);
      for (const f of facts) {
        if (f.date > date) continue;
        const a = b.byId.get(f.ledgerAccountId);
        if (!a) continue;
        if ((a.kind === 'asset' || a.kind === 'liability') && a.systemKey === null) {
          balances.set(a._id, (balances.get(a._id) ?? 0n) + f.amount);
        }
        if (f.date.startsWith(month)) {
          if (a.systemKey === 'adjustments' || a.systemKey === 'revaluation') adjustments -= f.amount;
          if (a.systemKey === 'written_off') writtenOff += f.amount;
        }
      }
      let assets = 0n;
      let debts = 0n;
      const partial = new Set<string>();
      for (const [id, raw] of balances) {
        const a = b.byId.get(id)!;
        const v = b.convert(raw, a.currency, date);
        if (v === null) {
          if (raw !== 0n) partial.add(a.currency);
          continue;
        }
        if (v >= 0n) assets += v;
        else debts -= v;
      }
      let unrealised = 0n;
      for (const { holding, position } of vals.get(date) ?? []) {
        const v = b.convert(position.unrealised, holding.currency, date);
        if (v === null) partial.add(holding.currency);
        else unrealised += v;
      }
      return { date, assets, debts, unrealised, adjustments, writtenOff, partial: [...partial] };
    });
  }

  /** The next months from bills and income streams, with a likely range (DESIGN.md page 19). */
  private async forecast(ctx: WorkspaceContext, b: Book, monthsAhead: number): Promise<Table> {
    const thisMonth = b.today.slice(0, 7);
    const history = [1, 2, 3].map((i) => shiftMonth(thisMonth, -i));
    const facts = await this.facts(ctx, b, monthBounds(history.at(-1)!).from, b.today);
    const spentBy = history.map((m) => run(this.monthSpec(m, 'spending'), facts, b.look).total);
    const avg = divRoundHalfAwayFromZero(
      spentBy.reduce((s, v) => s + v, 0n),
      3n,
    );
    const spread = divRoundHalfAwayFromZero(
      spentBy.reduce((a, v) => (v > a ? v : a), 0n) - spentBy.reduce((a, v) => (v < a ? v : a), spentBy[0] ?? 0n),
      2n,
    );
    const schedules = await this.d.schedules.find(ctx, { status: 'active' });
    let balance = (await this.liquid(ctx, b, b.today, DEFAULT_HEALTH)).cash;
    const rows = [];
    for (let i = 1; i <= monthsAhead; i++) {
      const m = shiftMonth(thisMonth, i);
      let income = 0n;
      let bills = 0n;
      for (const s of schedules) {
        const n = BigInt(occurrencesInMonth(s.startDate, s.recurrence, s.end, m).length);
        const amount = parseMinor(s.amountMinor) * n;
        if (s.kind === 'income') income += amount;
        else if (s.kind === 'bill' || s.kind === 'subscription') bills += amount;
      }
      const other = avg > bills ? avg - bills : 0n;
      balance += income - bills - other;
      const band = spread * BigInt(i);
      rows.push({ key: m, label: m, values: [balance, balance - band, balance + band], total: balance });
    }
    return table(
      ['expected', 'low', 'high'].map((k) => ({ key: k, label: k })),
      rows,
      true,
    );
  }

  private async debtPayoff(ctx: WorkspaceContext, b: Book, from: string, to: string) {
    const months = monthRange(from.slice(0, 7), to.slice(0, 7));
    const facts = await this.facts(ctx, b, null, minDate(to, b.today));
    const owedAt = (date: string) => {
      let owed = 0n;
      for (const f of facts) {
        if (f.date > date) continue;
        const a = b.byId.get(f.ledgerAccountId);
        if (a?.kind === 'liability' && a.systemKey === null) owed -= f.amount;
      }
      return owed;
    };
    const rows = months.map((m) => {
      const owed = owedAt(minDate(monthBounds(m).to, b.today));
      return { key: m, label: m, values: [owed, 0n], total: owed };
    });
    // Project at the average fall of the last three months until nothing is owed (at most five years).
    const recent = rows.slice(-4).map((r) => r.total);
    const fall =
      recent.length > 1 ? divRoundHalfAwayFromZero(recent[0]! - recent.at(-1)!, BigInt(recent.length - 1)) : 0n;
    let owed = rows.at(-1)?.total ?? 0n;
    let month = months.at(-1)!;
    let payoff: string | null = owed === 0n ? month : null;
    if (fall > 0n) {
      for (let i = 0; i < 60 && owed > 0n; i++) {
        month = shiftMonth(month, 1);
        owed = owed > fall ? owed - fall : 0n;
        rows.push({ key: month, label: month, values: [0n, owed], total: owed });
        if (owed === 0n) payoff = month;
      }
    }
    const t = table(
      [
        { key: 'owed', label: 'owed' },
        { key: 'projected', label: 'projected' },
      ],
      rows,
      true,
    );
    return {
      chart: 'area' as const,
      unit: 'money' as const,
      table: t,
      finding: {
        key: payoff ? 'debt_free_by' : 'debt_not_falling',
        amount: null,
        changeBasisPoints: null,
        previousFrom: payoff ? `${payoff}-01` : null,
      },
    };
  }

  private monthSpec(month: string, show: Spec['show']): Spec {
    const { from, to } = monthBounds(month);
    return { show, groupBy: 'month', splitBy: null, interval: 'month', from, to, filters: {} };
  }

  async cashFlow(
    ctx: WorkspaceContext,
    q: { from: string; to: string; accountIds?: string[]; includeTransfers: boolean },
  ): Promise<z.input<typeof CashFlow>> {
    if (q.from > q.to) throw Errors.validation('to', 'Choose an end date after the start date.');
    const b = await this.book(ctx);
    const prev = previousRange(q.from, q.to);
    const bandsFor = async (from: string, to: string) => {
      const facts = await this.facts(ctx, b, from, to);
      const allocations = await this.d.goalAllocations.find(ctx, { date: { $gte: from, $lte: to } });
      const goals = allocations
        .filter((a) => (a.kind ?? 'allocate') === 'allocate')
        .filter((a) => !q.accountIds?.length || q.accountIds.includes(a.fromAccountId ?? ''))
        .reduce((s, a) => s + parseMinor(a.amountMinor), 0n);
      return cashFlowBands(facts, b.look, {
        goalAllocations: goals,
        includeTransfers: q.includeTransfers,
        accountIds: q.accountIds,
      });
    };
    const now = await bandsFor(q.from, q.to);
    const before = await bandsFor(prev.from, prev.to);
    const income = now.filter((x) => x.kind === 'income').reduce((s, x) => s + x.amount, 0n);
    const share = (v: bigint) => (income > 0n ? String(divRoundHalfAwayFromZero(v * 10_000n, income)) : null);
    const labelOf = (band: (typeof now)[number]) =>
      band.categoryId ? (b.categoryNames.get(band.categoryId) ?? '') : band.kind;
    const groupKey = (band: (typeof now)[number]) =>
      band.kind === 'spending' ? `group:${band.groupId ?? NONE}` : band.kind === 'income' ? 'income' : band.kind;
    const groups = new Map<
      string,
      {
        label: string;
        kind: string;
        amount: bigint;
        previous: bigint;
        categories: { categoryId: string; label: string; amount: bigint }[];
      }
    >();
    for (const band of now) {
      const key = groupKey(band);
      const g = groups.get(key) ?? {
        label: band.kind === 'spending' ? (b.groupNames.get(band.groupId ?? '') ?? '') : band.kind,
        kind: band.kind,
        amount: 0n,
        previous: 0n,
        categories: [],
      };
      g.amount += band.amount;
      if (band.categoryId)
        g.categories.push({ categoryId: band.categoryId, label: labelOf(band), amount: band.amount });
      groups.set(key, g);
    }
    for (const band of before) {
      const g = groups.get(groupKey(band));
      if (g) g.previous += band.amount;
    }
    const totalIn = now.filter((x) => x.side === 'in').reduce((s, x) => s + x.amount, 0n);
    const left = now.find((x) => x.kind === 'left_over')?.amount ?? 0n;
    return {
      from: q.from,
      to: q.to,
      bands: now.map((band) => ({
        ...band,
        label: labelOf(band),
        amount: toMinorString(band.amount),
        shareBasisPoints: share(band.amount),
      })),
      tiles: {
        in: toMinorString(totalIn),
        out: toMinorString(totalIn - left),
        savedBasisPoints: share(left),
      },
      groups: [...groups].map(([key, g]) => ({
        key,
        label: g.label,
        kind: g.kind,
        amount: toMinorString(g.amount),
        shareBasisPoints: share(g.amount),
        previous: toMinorString(g.previous),
        change: toMinorString(g.amount - g.previous),
        categories: g.categories
          .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0))
          .map((c) => ({ ...c, amount: toMinorString(c.amount) })),
      })),
    };
  }

  /** Liquid cash on a date, in the workspace currency, and the counted accounts' last activity. */
  private async liquid(ctx: WorkspaceContext, b: Book, date: string, settings: HealthSettingsDoc, facts?: Fact[]) {
    const counted = b.accounts.filter((a) => {
      if (a.archivedAt || a.systemKey || a.categoryId || a.holdingOf || a.personDebt || a.kind !== 'asset')
        return false;
      if (settings.cashAccountIds) return settings.cashAccountIds.includes(a._id);
      return (
        LIQUID_TYPES.has(a.accountType ?? '') ||
        (settings.countInvestments && INVESTMENT_TYPES.has(a.accountType ?? ''))
      );
    });
    const ids = new Set(counted.map((a) => a._id));
    const all = facts ?? (await this.facts(ctx, b, null, date));
    const raw = new Map<string, bigint>();
    const lastSeen = new Map<string, string>();
    for (const f of all) {
      if (f.date > date || !ids.has(f.ledgerAccountId)) continue;
      raw.set(f.ledgerAccountId, (raw.get(f.ledgerAccountId) ?? 0n) + f.amount);
      if ((lastSeen.get(f.ledgerAccountId) ?? '') < f.date) lastSeen.set(f.ledgerAccountId, f.date);
    }
    let cash = 0n;
    for (const a of counted) cash += b.convert(raw.get(a._id) ?? 0n, a.currency, date) ?? 0n;
    if (settings.countInvestments) {
      const [vals] = (await this.d.investments.valuationsOn(ctx, [date])).values();
      for (const { holding, position } of vals ?? []) cash += b.convert(position.value, holding.currency, date) ?? 0n;
    }
    return { cash, counted, lastSeen };
  }

  async healthPage(ctx: WorkspaceContext, month: string): Promise<z.input<typeof HealthPage>> {
    const b = await this.book(ctx);
    const ws = await this.d.workspaces.get(ctx);
    const settings = ws?.healthSettings ?? DEFAULT_HEALTH;
    const facts = await this.facts(ctx, b, null, b.today);
    const firstDate = facts.reduce<string | null>((a, f) => (a === null || f.date < a ? f.date : a), null);
    const occurrences = await this.d.occurrences.find(ctx, {});
    const scheduleKinds = new Map((await this.d.schedules.find(ctx, {})).map((s) => [s._id, s.kind] as const));
    const txDates = new Map<string, string>();
    for (const f of facts) txDates.set(f.eventId, f.date);
    const history = monthRange(shiftMonth(month, -11), month);
    const { months: budgets } = await this.d.budget.get(ctx, month, 15);
    const budgetOf = new Map(budgets.map((m) => [m.month, m]));

    const inputFor = async (m: string): Promise<{ input: HealthInput; asOf: string }> => {
      const current = m === b.today.slice(0, 7);
      const asOf = current ? b.today : minDate(monthBounds(m).to, b.today);
      const last = current ? shiftMonth(m, -1) : m;
      const months = [shiftMonth(last, -2), shiftMonth(last, -1), last];
      const window = { from: monthBounds(months[0]!).from, to: monthBounds(last).to };
      const inWindow = facts.filter((f) => f.date >= window.from && f.date <= window.to);
      const perMonth = months.map((mm) => {
        const { from, to } = monthBounds(mm);
        const mf = inWindow.filter((f) => f.date >= from && f.date <= to);
        let income = 0n;
        let spending = 0n;
        let essential = 0n;
        let hasData = false;
        for (const f of mf) {
          const kind = b.look.kindOf(f.ledgerAccountId);
          if (kind === 'income') income -= f.amount;
          if (kind === 'expense') {
            spending += f.amount;
            if (b.essentialLedgerIds.has(f.ledgerAccountId)) essential += f.amount;
          }
          if (kind === 'income' || kind === 'expense') hasData = true;
        }
        return { month: mm, income, spending, essential, hasData };
      });
      const debtPayments = months.map((mm) => {
        const { from, to } = monthBounds(mm);
        return inWindow
          .filter((f) => f.date >= from && f.date <= to)
          .filter(
            (f) =>
              (f.type === 'loan_repayment' || f.reversedType === 'loan_repayment') && b.look.isCash(f.ledgerAccountId),
          )
          .reduce((s, f) => s - f.amount, 0n);
      });
      // Borrowed in the three months and still owed: never counted as cash (P23-07).
      const borrowed = facts
        .filter((f) => f.date > addDays(asOf, -92) && f.date <= asOf)
        .filter(
          (f) =>
            (f.type === 'loan_proceeds' || f.reversedType === 'loan_proceeds') &&
            b.look.kindOf(f.ledgerAccountId) === 'liability',
        )
        .reduce((s, f) => s - f.amount, 0n);
      const owed = facts
        .filter((f) => f.date <= asOf && b.look.kindOf(f.ledgerAccountId) === 'liability')
        .reduce((s, f) => s - f.amount, 0n);
      const { cash } = await this.liquid(ctx, b, asOf, settings, facts);
      let due = 0;
      let onTime = 0;
      for (const o of occurrences) {
        const kind = scheduleKinds.get(o.scheduleId);
        if ((kind !== 'bill' && kind !== 'subscription') || o.status === 'skipped') continue;
        if (o.date < window.from || o.date > minDate(window.to, asOf)) continue;
        due += 1;
        if (o.status !== 'paid') continue;
        const paidOn =
          (o.matchedTransactionId && txDates.get(o.matchedTransactionId)) ??
          (o.paidAt ? localDateString(o.paidAt, b.timeZone) : null);
        if (paidOn && paidOn <= o.date) onTime += 1;
      }
      const bm = budgetOf.get(last);
      // A category with spending but no plan reads "over plan" on its bar; it has no plan to keep to here.
      const planned = bm?.categories.filter((c) => c.usedBasisPoints !== null) ?? [];
      return {
        asOf,
        input: {
          months: perMonth,
          liquidCash: cash,
          recentBorrowing: borrowed < owed ? (borrowed > 0n ? borrowed : 0n) : owed > 0n ? owed : 0n,
          debtPayments,
          bills: { due, onTime },
          budget: {
            planned: planned.length,
            within: planned.filter((c) => c.state !== 'over_plan').length,
            overspent: planned.filter((c) => c.state === 'over_plan').length,
          },
          historyDays: firstDate ? Math.max(0, Math.round((Date.parse(asOf) - Date.parse(firstDate)) / 86_400_000)) : 0,
          targetMonths: settings.targetMonths,
        },
      };
    };

    const { input, asOf } = await inputFor(month);
    const h = health(input);
    const scores: { month: string; score: number | null }[] = [];
    for (const m of history)
      scores.push({ month: m, score: m === month ? h.score : health((await inputFor(m)).input).score });
    const before = scores.at(-2)?.score ?? null;
    const scored = h.pillars.filter((p) => p.score !== null);
    const strongest = scored.reduce<(typeof scored)[number] | null>(
      (a, p) => (!a || p.score! > a.score! ? p : a),
      null,
    );
    const weakest = scored.reduce<(typeof scored)[number] | null>((a, p) => (!a || p.score! < a.score! ? p : a), null);
    const { lastSeen, counted } = await this.liquid(ctx, b, asOf, settings, facts);
    const staleBefore = addDays(asOf, -30);
    const stale = counted
      .map((a) => lastSeen.get(a._id) ?? null)
      .filter((d): d is string => d !== null && d < staleBefore)
      .sort();
    return {
      month,
      ready: h.ready,
      score: h.score,
      band: h.band,
      change: h.score !== null && before !== null ? h.score - before : null,
      reason: { strongest: strongest?.key ?? null, weakest: weakest?.key ?? null },
      pillars: h.pillars.map((p) => ({
        key: p.key,
        value: p.value === null ? null : String(p.value),
        score: p.score,
        used: Object.fromEntries(Object.entries(p.used).map(([k, v]) => [k, String(v)])),
      })),
      missing: h.missing,
      basedOnDataUpTo: stale[0] ?? null,
      advice: h.advice.map((a) => ({
        pillar: a.pillar,
        link: a.link,
        amount: a.pillar === 'runway' ? toMinorString(a.monthly) : null,
        count: a.pillar === 'bills' ? a.late : a.pillar === 'budget' ? a.overspent : null,
      })),
      history: scores,
      inputs: {
        months: input.months.map((m) => ({
          month: m.month,
          income: toMinorString(m.income),
          spending: toMinorString(m.spending),
          essential: toMinorString(m.essential),
          hasData: m.hasData,
        })),
        liquidCash: toMinorString(input.liquidCash),
        recentBorrowing: toMinorString(input.recentBorrowing),
        debtPayments: input.debtPayments.map(toMinorString),
        bills: input.bills,
        budget: input.budget,
        historyDays: input.historyDays,
        targetMonths: input.targetMonths,
      },
      settings,
    };
  }

  async setHealthSettings(ctx: WorkspaceContext, s: HealthSettingsDoc): Promise<HealthSettingsDoc> {
    if (s.cashAccountIds?.length) {
      const found = await this.d.ledger.accounts.byIds(ctx, s.cashAccountIds);
      if (found.length !== new Set(s.cashAccountIds).size || found.some((a) => a.kind !== 'asset' || a.systemKey)) {
        throw Errors.validation('cashAccountIds', 'Choose your own accounts here.');
      }
    }
    await this.d.workspaces.setHealthSettings(ctx, s);
    await this.d.audit.record(ctx, { action: 'health.settings_updated', after: s });
    return s;
  }

  // Dashboards of report cards (DESIGN.md page 19).

  private defaultCards(kinds: Kind[], range: z.output<typeof ReportCard>['range']): z.output<typeof ReportCard>[] {
    return kinds.map((kind, i) => ({
      id: newId(),
      kind,
      title: null,
      savedReportId: null,
      range,
      interval: 'month',
      chart: null,
      spec: null,
      formula: null,
      text: null,
      layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 4, w: 6, h: 4 },
      hidden: false,
    }));
  }

  async listDashboards(ctx: WorkspaceContext): Promise<{ dashboards: z.input<typeof ReportDashboard>[] }> {
    let docs = await this.d.dashboards.find(ctx, {}, { sort: { sortOrder: 1, createdAt: 1 } });
    if (docs.length === 0) {
      const now = this.d.now();
      const make = (name: string, sortOrder: number, cards: z.output<typeof ReportCard>[]) => ({
        _id: newId(),
        name,
        sortOrder,
        cards,
        operationId: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      await this.d.database.transaction(async (session) => {
        if ((await this.d.dashboards.count(ctx, {}, { session })) > 0) return;
        const made = [
          make(
            'Overview',
            0,
            this.defaultCards(['net_worth', 'income_vs_expenses', 'spending_by_category', 'cash_flow'], 'this_month'),
          ),
          make(
            'Year in review',
            1,
            this.defaultCards(
              ['income_vs_expenses', 'spending_by_category', 'net_worth', 'budget_analysis'],
              'this_year',
            ),
          ),
        ];
        for (const doc of made) await this.d.dashboards.insertOne(ctx, doc, { session });
        await this.d.ledger.feed(
          ctx,
          made.map((m) => ({ collection: 'report_dashboards', docId: m._id, op: 'upsert' as const })),
          session,
        );
      });
      docs = await this.d.dashboards.find(ctx, {}, { sort: { sortOrder: 1, createdAt: 1 } });
    }
    return { dashboards: docs.map(dashboardView) };
  }

  async createDashboard(ctx: WorkspaceContext, body: { id?: string; name: string }, operationId: string) {
    const dup = await this.d.dashboards.findOne(ctx, body.id ? { _id: body.id } : { operationId });
    if (dup) return dashboardView(dup);
    const doc = await this.d.database.transaction(async (session) => {
      const now = this.d.now();
      const count = await this.d.dashboards.count(ctx, {}, { session });
      const created = await this.d.dashboards.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          name: body.name,
          sortOrder: count,
          cards: [],
          operationId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      await this.d.ledger.feed(ctx, [{ collection: 'report_dashboards', docId: created._id, op: 'upsert' }], session);
      return created;
    });
    return dashboardView(doc);
  }

  async updateDashboard(
    ctx: WorkspaceContext,
    id: string,
    body: { baseVersion: number; name?: string; sortOrder?: number; cards?: z.output<typeof ReportCard>[] },
  ) {
    const doc = await this.d.database.transaction(async (session) => {
      const before = await this.d.dashboards.findOne(ctx, { _id: id }, { session });
      if (!before) throw Errors.notFound();
      const set: Partial<ReportDashboardDoc> = { updatedAt: this.d.now() };
      if (body.name !== undefined) set.name = body.name;
      if (body.sortOrder !== undefined) set.sortOrder = body.sortOrder;
      if (body.cards !== undefined) set.cards = body.cards;
      const after = await this.d.dashboards.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        { $set: set, $inc: { version: 1 } },
        { session },
      );
      if (!after)
        throw new AppError(409, 'already_changed', 'This dashboard changed on another device.', {
          current: dashboardView(before),
        });
      await this.d.ledger.feed(ctx, [{ collection: 'report_dashboards', docId: id, op: 'upsert' }], session);
      return after;
    });
    return dashboardView(doc);
  }

  async deleteDashboard(ctx: WorkspaceContext, id: string): Promise<void> {
    await this.d.database.transaction(async (session) => {
      const res = await this.d.dashboards.deleteOne(ctx, { _id: id }, { session });
      if (res.deletedCount === 0) throw Errors.notFound();
      await this.d.ledger.feed(ctx, [{ collection: 'report_dashboards', docId: id, op: 'tombstone' }], session);
    });
  }

  async getDashboard(ctx: WorkspaceContext, id: string) {
    const doc = await this.d.dashboards.findOne(ctx, { _id: id });
    return doc ? dashboardView(doc) : null;
  }

  async listSaved(ctx: WorkspaceContext) {
    return { reports: (await this.d.saved.find(ctx, {}, { sort: { name: 1 } })).map(savedView) };
  }

  async createSaved(
    ctx: WorkspaceContext,
    body: { id?: string; name: string; spec: z.output<typeof BuilderSpec>; dashboardId?: string },
    operationId: string,
  ) {
    const dup = await this.d.saved.findOne(ctx, body.id ? { _id: body.id } : { operationId });
    if (dup) return savedView(dup);
    const doc = await this.d.database.transaction(async (session) => {
      const now = this.d.now();
      const created = await this.d.saved.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          name: body.name,
          spec: body.spec,
          operationId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      const changed = [{ collection: 'saved_reports', docId: created._id, op: 'upsert' as const }];
      if (body.dashboardId) {
        const dash = await this.d.dashboards.findOne(ctx, { _id: body.dashboardId }, { session });
        if (!dash) throw Errors.notFound();
        const y = dash.cards.reduce((m, c) => Math.max(m, c.layout.y + c.layout.h), 0);
        const card: z.output<typeof ReportCard> = {
          ...this.defaultCards(['custom'], 'this_month')[0]!,
          savedReportId: created._id,
          title: body.name,
          chart: body.spec.chart,
          layout: { x: 0, y, w: 6, h: 4 },
        };
        await this.d.dashboards.updateOne(
          ctx,
          { _id: dash._id },
          { $push: { cards: card }, $set: { updatedAt: now }, $inc: { version: 1 } } as never,
          { session },
        );
        changed.push({ collection: 'report_dashboards', docId: dash._id, op: 'upsert' });
      }
      await this.d.ledger.feed(ctx, changed, session);
      return created;
    });
    return savedView(doc);
  }

  async updateSaved(
    ctx: WorkspaceContext,
    id: string,
    body: { baseVersion: number; name?: string; spec?: z.output<typeof BuilderSpec> },
  ) {
    const doc = await this.d.database.transaction(async (session) => {
      const before = await this.d.saved.findOne(ctx, { _id: id }, { session });
      if (!before) throw Errors.notFound();
      const set: Partial<SavedReportDoc> = { updatedAt: this.d.now() };
      if (body.name !== undefined) set.name = body.name;
      if (body.spec !== undefined) set.spec = body.spec;
      const after = await this.d.saved.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        { $set: set, $inc: { version: 1 } },
        { session },
      );
      if (!after)
        throw new AppError(409, 'already_changed', 'This report changed on another device.', {
          current: savedView(before),
        });
      await this.d.ledger.feed(ctx, [{ collection: 'saved_reports', docId: id, op: 'upsert' }], session);
      return after;
    });
    return savedView(doc);
  }

  async deleteSaved(ctx: WorkspaceContext, id: string): Promise<void> {
    await this.d.database.transaction(async (session) => {
      const res = await this.d.saved.deleteOne(ctx, { _id: id }, { session });
      if (res.deletedCount === 0) throw Errors.notFound();
      await this.d.ledger.feed(ctx, [{ collection: 'saved_reports', docId: id, op: 'tombstone' }], session);
    });
  }

  async getSaved(ctx: WorkspaceContext, id: string) {
    const doc = await this.d.saved.findOne(ctx, { _id: id });
    return doc ? savedView(doc) : null;
  }

  /** The Dashboard's Health and Investments cards (P05, Phase 5 items). */
  async dashboardCards(ctx: WorkspaceContext, month: string) {
    const page = await this.healthPage(ctx, month).catch(() => null);
    const p = await this.d.investments.portfolio(ctx, '1M');
    return {
      health: page ? { ready: page.ready, score: page.score, band: page.band, change: page.change } : null,
      investments:
        p.holdings.length === 0
          ? null
          : {
              value: p.value,
              unrealised: p.unrealised,
              change: toMinorString(parseMinor(p.series.at(-1)?.value ?? '0') - parseMinor(p.series[0]?.value ?? '0')),
            },
    };
  }

  static readonly PILLARS = PILLARS;
}

function bucketRange(key: string, interval: Interval): { from: string; to: string } {
  switch (interval) {
    case 'day':
      return { from: key, to: key };
    case 'week':
      return { from: key, to: addDays(key, 6) };
    case 'month':
      return monthBounds(key);
    case 'year':
      return { from: `${key}-01-01`, to: `${key}-12-31` };
  }
}

function factsOf(e: TransactionDoc, b: Book, originals: Map<string, string>): Fact[] {
  const accountIds = e.lines
    .map((l) => l.ledgerAccountId)
    .filter((id) => {
      const a = b.byId.get(id);
      return !!a && (a.kind === 'asset' || a.kind === 'liability') && a.systemKey === null && !a.holdingOf;
    });
  return e.lines.map((l) => ({
    eventId: e._id,
    date: e.date,
    type: e.type,
    ledgerAccountId: l.ledgerAccountId,
    amount: BigInt(l.amountMinor),
    payeeId: e.payeeId,
    tagIds: e.tagIds,
    accountIds,
    reversed: e.status === 'reversed',
    reversedType: e.links.reversalOf ? (originals.get(e.links.reversalOf) ?? null) : null,
  }));
}

const dashboardView = (d: ReportDashboardDoc): z.input<typeof ReportDashboard> => ({
  id: d._id,
  name: d.name,
  sortOrder: d.sortOrder,
  cards: d.cards,
  version: d.version,
});

const savedView = (d: SavedReportDoc): z.input<typeof SavedReport> => ({
  id: d._id,
  name: d.name,
  spec: d.spec,
  version: d.version,
});

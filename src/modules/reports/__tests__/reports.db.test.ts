import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';
import { REPORT_KINDS } from '../reports.contract.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
  t.clock.now = new Date('2026-10-28T12:00:00Z');
});
afterAll(() => t.close());

/** Salary ₦400,000 a month; Food ₦100,000 and Fun ₦50,000 a month from July to September. */
async function world() {
  const w = await newWorkspace(t);
  const s = t.services;
  const bank = await s.accounts.create(
    w.ctx,
    { type: 'bank', name: 'GTBank', openingBalance: '50000000', openingDate: '2026-06-01' } as never,
    uuidv7(),
  );
  const tree = await s.categories.tree(w.ctx);
  const salary = tree.categories.find((c) => c.starterKey === 'other_income')!;
  const foodGroup = await s.categories.createGroup(w.ctx, { name: 'Food', kind: 'expense' });
  const funGroup = await s.categories.createGroup(w.ctx, { name: 'Fun', kind: 'expense' });
  const food = await s.categories.create(w.ctx, { groupId: foodGroup.id, name: 'Groceries' });
  const fun = await s.categories.create(w.ctx, { groupId: funGroup.id, name: 'Outings' });
  const post = (body: Record<string, unknown>) => s.transactions.create(w.ctx, body as never, uuidv7());
  for (const m of ['07', '08', '09']) {
    await post({ type: 'income', accountId: bank.id, categoryId: salary.id, amount: '40000000', date: `2026-${m}-25` });
    await post({ type: 'expense', accountId: bank.id, categoryId: food.id, amount: '10000000', date: `2026-${m}-05` });
    await post({ type: 'expense', accountId: bank.id, categoryId: fun.id, amount: '5000000', date: `2026-${m}-12` });
  }
  await post({ type: 'income', accountId: bank.id, categoryId: salary.id, amount: '40000000', date: '2026-10-25' });
  await post({ type: 'expense', accountId: bank.id, categoryId: food.id, amount: '2000000', date: '2026-10-05' });
  return { ...w, s, bank, salary, food, fun, foodGroup };
}

const run = (s: TestApp['services'], ctx: never, body: Record<string, unknown>) =>
  s.reports.run(ctx, { interval: 'month', compare: false, filters: {}, monthsAhead: 6, ...body } as never);

describe('reports (B5.2)', () => {
  it('spending by category, from period totals, with what it found', async () => {
    const { ctx, s, food, fun } = await world();
    const r = await run(s, ctx as never, { kind: 'spending_by_category', from: '2026-09-01', to: '2026-09-30' });
    expect(r.table.total).toBe('15000000');
    expect(r.table.rows.map((x) => [x.key, x.total])).toEqual([
      [food.id, '10000000'],
      [fun.id, '5000000'],
    ]);
    expect(r.finding).toMatchObject({ key: 'spending_same', changeBasisPoints: '0' });
    expect(r.drill[food.id]).toMatchObject({ categoryIds: [food.id], from: '2026-09-01', to: '2026-09-30' });
  });

  it('income vs expenses: each month and its net', async () => {
    const { ctx, s } = await world();
    const r = await run(s, ctx as never, { kind: 'income_vs_expenses', from: '2026-07-01', to: '2026-09-30' });
    expect(r.table.rows.map((x) => [x.key, ...x.values, x.total])).toEqual([
      ['2026-07', '40000000', '15000000', '25000000'],
      ['2026-08', '40000000', '15000000', '25000000'],
      ['2026-09', '40000000', '15000000', '25000000'],
    ]);
  });

  it('net worth closes at what the accounts hold', async () => {
    const { ctx, s } = await world();
    const r = await run(s, ctx as never, { kind: 'net_worth', from: '2026-07-01', to: '2026-10-31' });
    expect(r.table.rows.at(-1)!.total).toBe('163000000');
    expect((await s.accounts.list(ctx)).netWorth.amount).toBe('163000000');
    expect((await s.budget.dashboard(ctx, '2026-10')).netWorth.amount).toBe('163000000');
  });

  it('the builder groups and splits; a formula works out a number', async () => {
    const { ctx, s } = await world();
    const custom = await run(s, ctx as never, {
      kind: 'custom',
      from: '2026-07-01',
      to: '2026-09-30',
      spec: { show: 'spending', groupBy: 'group', splitBy: 'month', chart: 'bar', filters: {} },
    });
    expect(custom.table.columns.map((c) => c.key)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(custom.table.total).toBe('45000000');
    const f = await run(s, ctx as never, {
      kind: 'formula',
      from: '2026-09-01',
      to: '2026-09-30',
      formula: 'income - spending',
    });
    expect(f).toMatchObject({ unit: 'money', table: { total: '25000000' } });
    await expect(
      run(s, ctx as never, { kind: 'formula', from: '2026-09-01', to: '2026-09-30', formula: 'salary' }),
    ).rejects.toMatchObject({ code: 'formula_unreadable' });
  });

  it('every report type runs', async () => {
    const { ctx, s } = await world();
    for (const kind of REPORT_KINDS) {
      const body: Record<string, unknown> = { kind, from: '2026-07-01', to: '2026-10-31' };
      if (kind === 'formula') body.formula = 'net';
      if (kind === 'custom')
        body.spec = { show: 'income', groupBy: 'month', splitBy: null, chart: 'line', filters: {} };
      const r = await run(s, ctx as never, body);
      expect(r.kind).toBe(kind);
      for (const row of r.table.rows) expect(row.values).toHaveLength(r.table.columns.length);
    }
  });
});

describe('cash flow (B5.3)', () => {
  it('bands add up to income and spending; left over is the rest', async () => {
    const { ctx, s, foodGroup } = await world();
    const c = await s.reports.cashFlow(ctx, { from: '2026-09-01', to: '2026-09-30', includeTransfers: false });
    const sum = (kind: string) => c.bands.filter((b) => b.kind === kind).reduce((x, b) => x + BigInt(b.amount), 0n);
    expect(sum('income')).toBe(40_000_000n);
    expect(sum('spending')).toBe(15_000_000n);
    expect(sum('left_over')).toBe(25_000_000n);
    expect(c.tiles).toEqual({ in: '40000000', out: '15000000', savedBasisPoints: '6250' });
    expect(c.groups.find((g) => g.key === `group:${foodGroup.id}`)).toMatchObject({
      label: 'Food',
      amount: '10000000',
      previous: '10000000',
      change: '0',
    });
  });

  it('borrowed money is a grey source, never income', async () => {
    const { ctx, s, bank } = await world();
    const loan = await s.accounts.create(
      ctx,
      { type: 'loan', name: 'Loan', openingBalance: '0', openingDate: '2026-09-01' } as never,
      uuidv7(),
    );
    await s.transactions.create(
      ctx,
      {
        type: 'loan_proceeds',
        accountId: bank.id,
        loanAccountId: loan.id,
        amount: '100000000',
        date: '2026-09-10',
      } as never,
      uuidv7(),
    );
    const c = await s.reports.cashFlow(ctx, { from: '2026-09-01', to: '2026-09-30', includeTransfers: false });
    expect(c.bands.find((b) => b.kind === 'borrowed')?.amount).toBe('100000000');
    expect(c.bands.filter((b) => b.kind === 'income').reduce((x, b) => x + BigInt(b.amount), 0n)).toBe(40_000_000n);
  });
});

describe('Health (B5.4)', () => {
  it('is ready after two full months, with three pillars', async () => {
    const { ctx, s } = await world();
    const h = await s.reports.healthPage(ctx, '2026-10');
    expect(h).toMatchObject({ ready: true, score: 100, band: 'strong', missing: [] });
    expect(h.pillars.map((p) => [p.key, p.score])).toEqual([
      ['saving', 100],
      ['runway', 100],
      ['debt_load', 100],
      ['bills', null],
      ['budget', null],
    ]);
    // Runway: ₦1,630,000 ÷ ₦100,000 essential (Food) = 16.3 months.
    expect(h.pillars.find((p) => p.key === 'runway')!.value).toBe('1630');
    expect(h.history).toHaveLength(12);
  });

  it('Budget: categories within plan out of those with a plan, last complete month', async () => {
    const { ctx, s, food, fun } = await world();
    await s.budget.assign(ctx, '2026-09', food.id, { assigned: '12000000' } as never);
    await s.budget.assign(ctx, '2026-09', fun.id, { assigned: '4000000' } as never);
    const h = await s.reports.healthPage(ctx, '2026-10');
    expect(h.pillars.find((p) => p.key === 'budget')).toMatchObject({ value: '5000', score: 50 });
    expect(h.advice).toEqual([{ pillar: 'budget', link: 'budget', amount: null, count: 1 }]);
  });

  it('is not shown as if known with too little data (P23-03)', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '50000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const h = await s.reports.healthPage(w.ctx, '2026-10');
    expect(h).toMatchObject({ ready: false, score: null, band: null });
    expect(h.missing).toEqual(['two_months', 'three_pillars']);
  });

  it('borrowed money never raises the score (P23-07)', async () => {
    const { ctx, s, bank } = await world();
    const before = await s.reports.healthPage(ctx, '2026-10');
    const loan = await s.accounts.create(
      ctx,
      { type: 'loan', name: 'Loan', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    await s.transactions.create(
      ctx,
      {
        type: 'loan_proceeds',
        accountId: bank.id,
        loanAccountId: loan.id,
        amount: '500000000',
        date: '2026-10-20',
      } as never,
      uuidv7(),
    );
    const after = await s.reports.healthPage(ctx, '2026-10');
    expect(after.pillars.find((p) => p.key === 'runway')!.value).toBe(
      before.pillars.find((p) => p.key === 'runway')!.value,
    );
    expect(after.score).toBe(before.score);
  });

  it('settings: a 12-month target lowers the runway score', async () => {
    const { ctx, s } = await world();
    await s.reports.setHealthSettings(ctx, { cashAccountIds: null, targetMonths: 12, countInvestments: false });
    const h = await s.reports.healthPage(ctx, '2026-10');
    expect(h.settings.targetMonths).toBe(12);
    expect(h.pillars.find((p) => p.key === 'runway')!.score).toBe(100);
    await s.reports.setHealthSettings(ctx, { cashAccountIds: [], targetMonths: 6, countInvestments: false });
    const none = await s.reports.healthPage(ctx, '2026-10');
    expect(none.pillars.find((p) => p.key === 'runway')!.score).toBe(0);
  });
});

describe('dashboards and saved reports (P19, P21)', () => {
  it('makes Overview and Year in review once, then saves layouts and builder reports', async () => {
    const { ctx, s } = await world();
    const first = await s.reports.listDashboards(ctx);
    expect(first.dashboards.map((d) => d.name)).toEqual(['Overview', 'Year in review']);
    expect((await s.reports.listDashboards(ctx)).dashboards).toHaveLength(2);
    const overview = first.dashboards[0]!;
    const saved = await s.reports.createSaved(
      ctx,
      {
        name: 'Food by month',
        spec: { show: 'spending', groupBy: 'month', splitBy: null, chart: 'bar', filters: {} },
        dashboardId: overview.id,
      },
      uuidv7(),
    );
    const after = (await s.reports.listDashboards(ctx)).dashboards[0]!;
    expect(after.cards.at(-1)).toMatchObject({ kind: 'custom', savedReportId: saved.id, title: 'Food by month' });
    const moved = await s.reports.updateDashboard(ctx, overview.id, {
      baseVersion: after.version,
      cards: after.cards.slice(1) as never,
    });
    expect(moved.cards).toHaveLength(after.cards.length - 1);
    await expect(
      s.reports.updateDashboard(ctx, overview.id, { baseVersion: after.version, name: 'Old' }),
    ).rejects.toMatchObject({ code: 'already_changed' });
  });
});

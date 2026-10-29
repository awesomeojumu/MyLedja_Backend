import { describe, expect, it } from 'vitest';
import type { LedgerKind } from '../../ledger/ledger.types.js';
import {
  ageOfMoney,
  bucketOf,
  bucketsBetween,
  cashFlow,
  chartOf,
  type Fact,
  type Lookup,
  previousRange,
  run,
  type Spec,
} from '../engine.js';

const kinds: Record<string, LedgerKind> = {
  gtbank: 'asset',
  opay: 'asset',
  loan: 'liability',
  tunde: 'asset',
  mtn: 'asset',
  pension: 'asset',
  salary: 'income',
  interest_earned: 'income',
  gain: 'income',
  food: 'expense',
  transport: 'expense',
  interest_paid: 'expense',
  taxes: 'expense',
};
const cash = new Set(['gtbank', 'opay']);
const categories: Record<string, string> = {
  salary: 'cat-salary',
  interest_earned: 'cat-interest',
  gain: 'cat-gain',
  food: 'cat-food',
  transport: 'cat-transport',
  interest_paid: 'cat-charges',
  taxes: 'cat-taxes',
};
const groups: Record<string, string> = { 'cat-food': 'grp-living', 'cat-transport': 'grp-living' };

const look: Lookup = {
  kindOf: (id) => kinds[id] ?? null,
  categoryOf: (id) => categories[id] ?? null,
  groupOf: (c) => groups[c] ?? null,
  label: (_d, key) => key,
  isCash: (id) => cash.has(id),
};

let n = 0;
/** One event's facts from [account, amount] lines. Real accounts are those that are assets or liabilities. */
function event(type: string, date: string, lines: [string, bigint][], extra: Partial<Fact> = {}): Fact[] {
  const id = `e${++n}`;
  const accountIds = lines.map(([a]) => a).filter((a) => kinds[a] === 'asset' || kinds[a] === 'liability');
  return lines.map(([ledgerAccountId, amount]) => ({
    eventId: id,
    date,
    type,
    ledgerAccountId,
    amount,
    payeeId: null,
    tagIds: [],
    accountIds,
    ...extra,
  }));
}

const reversal = (facts: Fact[], date = facts[0]!.date) =>
  event(
    'reversal',
    date,
    facts.map((f) => [f.ledgerAccountId, -f.amount]),
    { reversedType: facts[0]!.type },
  );

const groceries = event('expense', '2026-10-03', [
  ['food', 1_845_000n],
  ['gtbank', -1_845_000n],
]);

const facts: Fact[] = [
  ...event('income', '2026-09-28', [
    ['gtbank', 64_000_000n],
    ['salary', -64_000_000n],
  ]),
  ...event('income', '2026-10-28', [
    ['gtbank', 64_000_000n],
    ['salary', -64_000_000n],
  ]),
  ...groceries,
  ...event(
    'expense',
    '2026-10-05',
    [
      ['transport', 300_000n],
      ['opay', -300_000n],
    ],
    { payeeId: 'bolt', tagIds: ['work'] },
  ),
  ...event('transfer', '2026-10-06', [
    ['opay', 5_000_000n],
    ['gtbank', -5_000_000n],
  ]),
  ...event('loan_proceeds', '2026-10-07', [
    ['gtbank', 50_000_000n],
    ['loan', -50_000_000n],
  ]),
  ...event('loan_repayment', '2026-10-08', [
    ['loan', 5_000_000n],
    ['interest_paid', 1_000_000n],
    ['gtbank', -6_000_000n],
  ]),
  ...event('lend', '2026-10-09', [
    ['tunde', 10_000_000n],
    ['opay', -10_000_000n],
  ]),
  ...event('collect', '2026-10-10', [
    ['opay', 4_200_000n],
    ['tunde', -4_000_000n],
    ['interest_earned', -200_000n],
  ]),
  ...event('investment_buy', '2026-10-11', [
    ['mtn', 10_550_000n],
    ['gtbank', -10_550_000n],
  ]),
  ...event('investment_sell', '2026-10-12', [
    ['gtbank', 4_800_000n],
    ['mtn', -4_220_000n],
    ['gain', -580_000n],
  ]),
  ...event('salary_gross', '2026-10-25', [
    ['gtbank', 62_000_000n],
    ['taxes', 9_600_000n],
    ['pension', 6_400_000n],
    ['salary', -78_000_000n],
  ]),
];

const spec = (s: Partial<Spec>): Spec => ({
  show: 'spending',
  groupBy: 'category',
  splitBy: null,
  interval: 'month',
  from: '2026-10-01',
  to: '2026-10-31',
  filters: {},
  ...s,
});

describe('report engine (B5.2)', () => {
  it("each report's table equals its chart data", () => {
    const t = run(spec({ show: 'income', groupBy: 'month', splitBy: 'category', from: '2026-09-01' }), facts, look);
    const chart = chartOf(t);
    expect(chart.series.map((s) => s.key)).toEqual(t.columns.map((c) => c.key));
    chart.series.forEach((s, i) => expect(s.points.map((p) => p.y)).toEqual(t.rows.map((r) => r.values[i])));
    expect(t.columnTotals.reduce((a, b) => a + b, 0n)).toBe(t.total);
    expect(t.rows.map((r) => r.key)).toEqual(['2026-09', '2026-10']);
  });

  it('spending by category reads the type: transfers, loans, lending and investing are never spending', () => {
    const t = run(spec({}), facts, look);
    expect(Object.fromEntries(t.rows.map((r) => [r.key, r.total]))).toEqual({
      'cat-taxes': 9_600_000n,
      'cat-food': 1_845_000n,
      'cat-charges': 1_000_000n,
      'cat-transport': 300_000n,
    });
    expect(t.total).toBe(12_745_000n);
  });

  it('income counts salary, interest and investment gain, never borrowed money', () => {
    expect(run(spec({ show: 'income' }), facts, look).total).toBe(64_000_000n + 200_000n + 580_000n + 78_000_000n);
  });

  it('groups by group, payee and tag, and filters like Transactions', () => {
    expect(run(spec({ groupBy: 'group' }), facts, look).rows.find((r) => r.key === 'grp-living')?.total).toBe(
      2_145_000n,
    );
    expect(run(spec({ groupBy: 'payee', filters: { payeeIds: ['bolt'] } }), facts, look).rows).toEqual([
      { key: 'bolt', label: 'bolt', values: [300_000n], total: 300_000n },
    ]);
    expect(run(spec({ groupBy: 'tag', filters: { tagIds: ['work'] } }), facts, look).total).toBe(300_000n);
    expect(run(spec({ filters: { accountIds: ['opay'] } }), facts, look).total).toBe(300_000n);
  });

  it('count counts events once, and a reversal takes its event back out', () => {
    expect(run(spec({ show: 'count', groupBy: 'month' }), facts, look).total).toBe(7n);
    const withUndo = [...facts, ...reversal(groceries)];
    expect(run(spec({ show: 'count', groupBy: 'month' }), withUndo, look).total).toBe(6n);
    const undone = run(spec({}), withUndo, look);
    expect(undone.rows.find((r) => r.key === 'cat-food')?.total ?? 0n).toBe(0n);
  });

  it('empty months still show, at zero', () => {
    const t = run(spec({ groupBy: 'month', from: '2026-08-01' }), facts, look);
    expect(t.rows.map((r) => [r.key, r.total])).toEqual([
      ['2026-08', 0n],
      ['2026-09', 0n],
      ['2026-10', 12_745_000n],
    ]);
  });

  it('balance is the running balance at the end of each period', () => {
    const t = run(
      spec({
        show: 'balance',
        groupBy: 'account',
        splitBy: 'month',
        from: '2026-09-01',
        filters: { accountIds: ['gtbank'] },
      }),
      facts,
      look,
    );
    expect(t.rows[0]!.values).toEqual([
      64_000_000n,
      64_000_000n -
        1_845_000n -
        5_000_000n +
        50_000_000n -
        6_000_000n -
        10_550_000n +
        4_800_000n +
        62_000_000n +
        64_000_000n,
    ]);
  });
});

describe('cash flow bands (B5.3)', () => {
  const bands = cashFlow(
    facts.filter((f) => f.date >= '2026-10-01'),
    look,
    { goalAllocations: 8_000_000n, includeTransfers: false },
  );
  const sum = (pick: (b: (typeof bands)[number]) => boolean) => bands.filter(pick).reduce((s, b) => s + b.amount, 0n);
  const amount = (kind: string) => bands.find((b) => b.kind === kind)?.amount ?? 0n;

  it('income bands add up to Income and spending bands to Spent', () => {
    expect(sum((b) => b.kind === 'income')).toBe(run(spec({ show: 'income' }), facts, look).total);
    expect(sum((b) => b.kind === 'spending')).toBe(run(spec({}), facts, look).total);
  });

  it('borrowed, collected and returned money sit apart from income; goals, debts and investments from spending', () => {
    expect(amount('borrowed')).toBe(50_000_000n);
    expect(amount('collected')).toBe(4_000_000n);
    expect(amount('returns')).toBe(4_220_000n);
    expect(amount('debt_payments')).toBe(5_000_000n);
    expect(amount('lent')).toBe(10_000_000n);
    expect(amount('investments')).toBe(10_550_000n + 6_400_000n);
    expect(amount('goals')).toBe(8_000_000n);
    expect(bands.some((b) => b.kind === 'transfers')).toBe(false);
  });

  it('left over is everything in minus everything out', () => {
    expect(sum((b) => b.side === 'in')).toBe(sum((b) => b.side === 'out'));
    expect(amount('left_over')).toBeGreaterThan(0n);
  });

  it('a reversed loan takes its band back out', () => {
    const loan = facts.filter((f) => f.type === 'loan_proceeds');
    const b = cashFlow([...loan, ...reversal(loan)], look, { goalAllocations: 0n, includeTransfers: false });
    expect(b.find((x) => x.kind === 'borrowed')).toBeUndefined();
  });

  it('transfers show only when switched on', () => {
    const b = cashFlow(facts, look, { goalAllocations: 0n, includeTransfers: true });
    expect(b.filter((x) => x.kind === 'transfers').map((x) => [x.side, x.amount])).toEqual([
      ['in', 5_000_000n],
      ['out', 5_000_000n],
    ]);
  });
});

describe('periods', () => {
  it('buckets by day, week (Monday), month and year', () => {
    expect(bucketOf('2026-10-28', 'week')).toBe('2026-10-26');
    expect(bucketOf('2026-10-28', 'year')).toBe('2026');
    expect(bucketsBetween('2026-10-01', '2026-12-15', 'month')).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(bucketsBetween('2026-10-26', '2026-11-08', 'week')).toEqual(['2026-10-26', '2026-11-02']);
  });

  it('the previous period has the same length, just before', () => {
    expect(previousRange('2026-10-01', '2026-10-31')).toEqual({ from: '2026-08-31', to: '2026-09-30' });
  });
});

describe('age of money', () => {
  it('spending takes the oldest naira first; transfers change nothing', () => {
    const ages = ageOfMoney(
      [
        ...event('income', '2026-09-01', [
          ['gtbank', 10_000n],
          ['salary', -10_000n],
        ]),
        ...event('income', '2026-10-01', [
          ['gtbank', 10_000n],
          ['salary', -10_000n],
        ]),
        ...event('transfer', '2026-10-02', [
          ['opay', 5_000n],
          ['gtbank', -5_000n],
        ]),
        // 10,000 from 1 Sep (30 days old) and 5,000 from 1 Oct (10 days old)
        ...event('expense', '2026-10-11', [
          ['food', 15_000n],
          ['gtbank', -15_000n],
        ]),
      ],
      look,
    );
    expect(ages.get('2026-10')).toBe((40n * 10_000n + 10n * 5_000n) / 15_000n);
  });
});

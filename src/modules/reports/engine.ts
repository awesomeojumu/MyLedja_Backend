import type { LedgerKind } from '../ledger/ledger.types.js';

/**
 * The report engine (build plan B5.2, DESIGN.md pages 19 to 21). Every report is one table of rows and
 * columns; the chart draws the same table, so a chart can never show a number its table doesn't (B5.2's
 * test). Reports read the event type, never the sign alone (DESIGN.md 9.2). Pure, so the app's builder
 * preview runs the same code.
 */

export const MEASURES = ['spending', 'income', 'net', 'balance', 'count'] as const;
export type Measure = (typeof MEASURES)[number];

export const DIMENSIONS = ['category', 'group', 'payee', 'account', 'tag', 'month'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type Interval = (typeof INTERVALS)[number];

/** One line of one event, with what the dimensions need. Lines of reversed events and reversals both count. */
export type Fact = {
  eventId: string;
  date: string;
  type: string;
  ledgerAccountId: string;
  /** Positive for a debit (TECH-SPEC 6.1). */
  amount: bigint;
  payeeId: string | null;
  tagIds: readonly string[];
  /** The person's own accounts the event touched. */
  accountIds: readonly string[];
  /** On a reversal: the type of the event it undoes. */
  reversedType?: string | null;
  /** True on an event that a later reversal undid. */
  reversed?: boolean;
};

export type Lookup = {
  kindOf(ledgerAccountId: string): LedgerKind | null;
  categoryOf(ledgerAccountId: string): string | null;
  groupOf(categoryId: string): string | null;
  label(dimension: Dimension, key: string): string;
  /** Bank, cash, wallet, savings and cards: where money is spent from. Not holdings or people's debts. */
  isCash(ledgerAccountId: string): boolean;
};

export type Filters = {
  accountIds?: readonly string[];
  categoryIds?: readonly string[];
  payeeIds?: readonly string[];
  tagIds?: readonly string[];
  types?: readonly string[];
};

export type Spec = {
  show: Measure;
  groupBy: Dimension;
  splitBy: Dimension | null;
  interval: Interval;
  from: string;
  to: string;
  filters: Filters;
};

export type Column = { key: string; label: string };
export type Row = { key: string; label: string; values: bigint[]; total: bigint };
export type Table = { columns: Column[]; rows: Row[]; columnTotals: bigint[]; total: bigint };

const NONE = 'none';

/** The bucket a date falls in. Weeks start on Monday and are named by that Monday. */
export function bucketOf(date: string, interval: Interval): string {
  switch (interval) {
    case 'day':
      return date;
    case 'month':
      return date.slice(0, 7);
    case 'year':
      return date.slice(0, 4);
    case 'week': {
      const d = new Date(`${date}T00:00:00Z`);
      const back = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - back);
      return d.toISOString().slice(0, 10);
    }
  }
}

/** Every bucket from `from` to `to`, so empty periods still show (a month with no spending is ₦0.00). */
export function bucketsBetween(from: string, to: string, interval: Interval): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let last = '';
  while (d <= end) {
    const b = bucketOf(d.toISOString().slice(0, 10), interval);
    if (b !== last) out.push(b);
    last = b;
    if (interval === 'day' || interval === 'week') d.setUTCDate(d.getUTCDate() + (interval === 'day' ? 1 : 7));
    else if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + 1, 1);
    else d.setUTCFullYear(d.getUTCFullYear() + 1, 0, 1);
  }
  return out;
}

/** What a fact adds to the measure, or null when it doesn't count. */
function measureOf(show: Measure, f: Fact, look: Lookup): bigint | null {
  const kind = look.kindOf(f.ledgerAccountId);
  switch (show) {
    case 'spending':
      return kind === 'expense' ? f.amount : null;
    case 'income':
      return kind === 'income' ? -f.amount : null;
    case 'net':
      return kind === 'income' || kind === 'expense' ? -f.amount : null;
    case 'count':
      // A reversal takes its event back out of the count, as period_totals does.
      return kind === 'income' || kind === 'expense' ? (f.type === 'reversal' ? -1n : 1n) : null;
    case 'balance':
      return kind === 'asset' || kind === 'liability' ? f.amount : null;
  }
}

function keysOf(dim: Dimension, f: Fact, spec: Spec, look: Lookup): string[] {
  switch (dim) {
    case 'category':
      return [look.categoryOf(f.ledgerAccountId) ?? NONE];
    case 'group': {
      const cat = look.categoryOf(f.ledgerAccountId);
      return [(cat && look.groupOf(cat)) ?? NONE];
    }
    case 'payee':
      return [f.payeeId ?? NONE];
    case 'account':
      return spec.show === 'balance' ? [f.ledgerAccountId] : [f.accountIds[0] ?? NONE];
    case 'tag':
      return f.tagIds.length ? [...f.tagIds] : [NONE];
    case 'month':
      return [bucketOf(f.date, spec.interval)];
  }
}

function passes(f: Fact, filters: Filters, look: Lookup): boolean {
  if (filters.types?.length && !filters.types.includes(f.type)) return false;
  if (filters.accountIds?.length && !f.accountIds.some((a) => filters.accountIds!.includes(a))) return false;
  if (filters.categoryIds?.length) {
    const cat = look.categoryOf(f.ledgerAccountId);
    if (!cat || !filters.categoryIds.includes(cat)) return false;
  }
  if (filters.payeeIds?.length && (!f.payeeId || !filters.payeeIds.includes(f.payeeId))) return false;
  if (filters.tagIds?.length && !f.tagIds.some((t) => filters.tagIds!.includes(t))) return false;
  return true;
}

/**
 * Runs a builder spec over facts. `balance` is the running balance at the end of each period, so its facts
 * must start from the beginning of history; the others count only facts dated in the range.
 */
export function run(spec: Spec, facts: readonly Fact[], look: Lookup): Table {
  const cells = new Map<string, Map<string, bigint>>();
  const counted = new Map<string, Set<string>>();
  const rowKeys = new Set<string>();
  const colKeys = new Set<string>();
  const timeRows = spec.groupBy === 'month';
  const timeCols = spec.splitBy === 'month';
  const buckets = bucketsBetween(spec.from, spec.to, spec.interval);
  if (timeRows) buckets.forEach((b) => rowKeys.add(b));
  if (timeCols) buckets.forEach((b) => colKeys.add(b));
  const add = (r: string, c: string, v: bigint) => {
    const row = cells.get(r) ?? new Map<string, bigint>();
    row.set(c, (row.get(c) ?? 0n) + v);
    cells.set(r, row);
  };

  if (spec.show === 'balance') return balanceTable(spec, facts, look, buckets);

  for (const f of facts) {
    if (f.date < spec.from || f.date > spec.to || !passes(f, spec.filters, look)) continue;
    const v = measureOf(spec.show, f, look);
    if (v === null) continue;
    for (const r of keysOf(spec.groupBy, f, spec, look)) {
      for (const c of spec.splitBy ? keysOf(spec.splitBy, f, spec, look) : ['total']) {
        rowKeys.add(r);
        colKeys.add(c);
        if (spec.show === 'count') {
          const k = `${r}|${c}`;
          const seen = counted.get(k) ?? new Set<string>();
          if (seen.has(f.eventId)) continue;
          seen.add(f.eventId);
          counted.set(k, seen);
        }
        add(r, c, v);
      }
    }
  }
  return tableOf(spec, cells, rowKeys, colKeys, look);
}

function balanceTable(spec: Spec, facts: readonly Fact[], look: Lookup, buckets: string[]): Table {
  // Rows are accounts (or time); the value is the balance at the end of each period.
  const accountKeys = new Set<string>();
  const sorted = facts
    .filter((f) => f.date <= spec.to && measureOf('balance', f, look) !== null)
    .filter((f) => !spec.filters.accountIds?.length || spec.filters.accountIds.includes(f.ledgerAccountId))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const f of sorted) accountKeys.add(f.ledgerAccountId);
  const ends = buckets.map((b) => endOfBucket(b, spec.interval, spec.to));
  const at = new Map<string, bigint[]>();
  for (const a of accountKeys)
    at.set(
      a,
      ends.map(() => 0n),
    );
  for (const f of sorted) {
    const kind = look.kindOf(f.ledgerAccountId);
    const shown = kind === 'liability' ? -f.amount : f.amount;
    const series = at.get(f.ledgerAccountId)!;
    ends.forEach((end, i) => {
      if (f.date <= end) series[i]! += shown;
    });
  }
  const cells = new Map<string, Map<string, bigint>>();
  const rowKeys = new Set<string>();
  const colKeys = new Set<string>();
  const byTime = spec.groupBy === 'month';
  for (const [a, series] of at) {
    buckets.forEach((b, i) => {
      const r = byTime ? b : a;
      const c = byTime ? a : b;
      rowKeys.add(r);
      colKeys.add(c);
      const row = cells.get(r) ?? new Map<string, bigint>();
      row.set(c, (row.get(c) ?? 0n) + series[i]!);
      cells.set(r, row);
    });
  }
  return tableOf(
    { ...spec, groupBy: byTime ? 'month' : 'account', splitBy: byTime ? 'account' : 'month' },
    cells,
    rowKeys,
    colKeys,
    look,
  );
}

function endOfBucket(bucket: string, interval: Interval, cap: string): string {
  let end: string;
  if (interval === 'day') end = bucket;
  else if (interval === 'week') {
    const d = new Date(`${bucket}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    end = d.toISOString().slice(0, 10);
  } else if (interval === 'month') {
    const [y, m] = bucket.split('-').map(Number) as [number, number];
    end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  } else end = `${bucket}-12-31`;
  return end > cap ? cap : end;
}

function tableOf(
  spec: Pick<Spec, 'groupBy' | 'splitBy'>,
  cells: Map<string, Map<string, bigint>>,
  rowKeys: Set<string>,
  colKeys: Set<string>,
  look: Lookup,
): Table {
  const cols = [...colKeys];
  if (spec.splitBy === 'month') cols.sort();
  const columns = cols.map((key) => ({
    key,
    label: spec.splitBy ? look.label(spec.splitBy, key) : 'total',
  }));
  const rows = [...rowKeys].map((key) => {
    const values = cols.map((c) => cells.get(key)?.get(c) ?? 0n);
    return {
      key,
      label: look.label(spec.groupBy, key),
      values,
      total: values.reduce((s, v) => s + v, 0n),
    };
  });
  if (spec.groupBy === 'month') rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.label.localeCompare(b.label)));
  const columnTotals = cols.map((_, i) => rows.reduce((s, r) => s + r.values[i]!, 0n));
  return { columns, rows, columnTotals, total: columnTotals.reduce((s, v) => s + v, 0n) };
}

/** The chart's data: one series per column, one point per row. Exactly the table's numbers. */
export function chartOf(t: Table): { series: { key: string; label: string; points: { x: string; y: bigint }[] }[] } {
  return {
    series: t.columns.map((c, i) => ({
      key: c.key,
      label: c.label,
      points: t.rows.map((r) => ({ x: r.key, y: r.values[i]! })),
    })),
  };
}

/** The same range shifted back by its own length, for "compare to previous period". */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
  const pTo = new Date(a);
  pTo.setUTCDate(pTo.getUTCDate() - 1);
  const pFrom = new Date(pTo);
  pFrom.setUTCDate(pFrom.getUTCDate() - (days - 1));
  return { from: pFrom.toISOString().slice(0, 10), to: pTo.toISOString().slice(0, 10) };
}

/** Change in basis points from `before` to `now`, or null when there was nothing before. */
export function changeBasisPoints(now: bigint, before: bigint): bigint | null {
  if (before === 0n) return null;
  const diff = (now - before) * 10_000n;
  const q = diff / (before < 0n ? -before : before);
  return q;
}

export type CashFlowBand = {
  key: string;
  side: 'in' | 'out';
  /** income: a category earned; borrowed, collected, returns: money in that isn't income (grey on the left);
   * spending: a category spent; goals, debt_payments, lent, investments: money out that isn't spending;
   * left_over: what's left (gold); transfers: only when switched on. */
  kind:
    | 'income'
    | 'borrowed'
    | 'collected'
    | 'returns'
    | 'transfers'
    | 'spending'
    | 'goals'
    | 'debt_payments'
    | 'lent'
    | 'investments'
    | 'left_over'
    | 'shortfall';
  categoryId: string | null;
  groupId: string | null;
  amount: bigint;
};

/**
 * Cash flow bands (DESIGN.md 9.2's last column, page 22). Income bands add up to Income and spending bands
 * to Spent (B5.3's test). Facts must be the range's events; `goalAllocations` are E18 earmarks in the range.
 */
export function cashFlow(
  facts: readonly Fact[],
  look: Lookup,
  opts: { goalAllocations: bigint; includeTransfers: boolean; accountIds?: readonly string[] },
): CashFlowBand[] {
  const byCategory = new Map<string, { kind: 'income' | 'spending'; amount: bigint }>();
  const other = new Map<CashFlowBand['kind'], bigint>();
  const bump = (k: CashFlowBand['kind'], v: bigint) => other.set(k, (other.get(k) ?? 0n) + v);
  const events = new Map<string, Fact[]>();
  for (const f of facts) {
    if (opts.accountIds?.length && !f.accountIds.some((a) => opts.accountIds!.includes(a))) continue;
    const kind = look.kindOf(f.ledgerAccountId);
    if (kind === 'income' || kind === 'expense') {
      const cat = look.categoryOf(f.ledgerAccountId) ?? `ledger:${f.ledgerAccountId}`;
      const row = byCategory.get(cat) ?? { kind: kind === 'income' ? 'income' : 'spending', amount: 0n };
      row.amount += kind === 'income' ? -f.amount : f.amount;
      byCategory.set(cat, row);
    }
    const list = events.get(f.eventId) ?? [];
    list.push(f);
    events.set(f.eventId, list);
  }
  // Money that moves without being earned or spent, by what happened (DESIGN.md 9.2). A reversal's lines
  // are its original's with the signs flipped, so read by the original's type they take the band back out.
  for (const lines of events.values()) {
    const type = lines[0]!.type;
    const sign = type === 'reversal' ? -1n : 1n;
    const of = (pick: (f: Fact) => boolean) => lines.filter(pick).reduce((s, f) => s + f.amount, 0n);
    const kindIs = (k: LedgerKind) => (f: Fact) => look.kindOf(f.ledgerAccountId) === k;
    const cash = (f: Fact) => look.kindOf(f.ledgerAccountId) === 'asset' && look.isCash(f.ledgerAccountId);
    const nonCashAsset = (f: Fact) => look.kindOf(f.ledgerAccountId) === 'asset' && !look.isCash(f.ledgerAccountId);
    const t = type === 'reversal' ? (lines[0]!.reversedType ?? type) : type;
    switch (t) {
      case 'loan_proceeds':
        bump('borrowed', -of(kindIs('liability')));
        break;
      case 'loan_repayment':
        bump('debt_payments', of(kindIs('liability')));
        break;
      case 'lend':
        bump('lent', of(nonCashAsset));
        break;
      case 'collect':
        bump('collected', -of(nonCashAsset));
        break;
      case 'investment_buy':
        bump('investments', of(nonCashAsset));
        break;
      case 'investment_sell':
        bump('returns', -of(nonCashAsset));
        break;
      case 'salary_gross':
        // Pension and NHF are still your money: they go to investments, not spending.
        bump('investments', of(nonCashAsset));
        break;
      case 'transfer':
        // Both sides are the same size; a reversal's positive side is its original's negative one.
        if (opts.includeTransfers) bump('transfers', sign * of((f) => cash(f) && f.amount > 0n));
        break;
    }
  }
  if (opts.goalAllocations > 0n) bump('goals', opts.goalAllocations);

  const bands: CashFlowBand[] = [];
  for (const [categoryId, row] of byCategory) {
    if (row.amount === 0n) continue;
    const real = categoryId.startsWith('ledger:') ? null : categoryId;
    bands.push({
      key: `${row.kind}:${categoryId}`,
      side: row.kind === 'income' ? 'in' : 'out',
      kind: row.kind,
      categoryId: real,
      groupId: real ? look.groupOf(real) : null,
      amount: row.amount,
    });
  }
  const ins: CashFlowBand['kind'][] = ['borrowed', 'collected', 'returns', 'transfers'];
  const outs: CashFlowBand['kind'][] = ['goals', 'debt_payments', 'lent', 'investments', 'transfers'];
  for (const k of ins) {
    const v = other.get(k) ?? 0n;
    if (v > 0n) bands.push({ key: `in:${k}`, side: 'in', kind: k, categoryId: null, groupId: null, amount: v });
  }
  for (const k of outs) {
    const v = other.get(k) ?? 0n;
    if (v > 0n) bands.push({ key: `out:${k}`, side: 'out', kind: k, categoryId: null, groupId: null, amount: v });
  }
  const totalIn = bands.filter((b) => b.side === 'in').reduce((s, b) => s + b.amount, 0n);
  const totalOut = bands.filter((b) => b.side === 'out').reduce((s, b) => s + b.amount, 0n);
  const rest = totalIn - totalOut;
  if (rest > 0n)
    bands.push({ key: 'out:left_over', side: 'out', kind: 'left_over', categoryId: null, groupId: null, amount: rest });
  if (rest < 0n)
    bands.push({ key: 'in:shortfall', side: 'in', kind: 'shortfall', categoryId: null, groupId: null, amount: -rest });
  return bands;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) =>
  BigInt(Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY));

/**
 * Age of money (DESIGN.md page 19): how many days old your naira is when spent. Money arriving in cash
 * accounts queues up oldest first; spending takes from the front, and each month's figure is the average
 * age of what was spent in it, weighted by amount. Moves between your own accounts change nothing; other
 * money leaving (lending, investing, loan principal) takes from the queue without counting as spending.
 */
export function ageOfMoney(facts: readonly Fact[], look: Lookup): Map<string, bigint> {
  const events = new Map<string, Fact[]>();
  for (const f of facts) {
    if (f.reversed || f.type === 'reversal') continue;
    const list = events.get(f.eventId) ?? [];
    list.push(f);
    events.set(f.eventId, list);
  }
  const ordered = [...events.values()].sort((a, b) =>
    a[0]!.date === b[0]!.date ? a[0]!.eventId.localeCompare(b[0]!.eventId) : a[0]!.date.localeCompare(b[0]!.date),
  );
  const queue: { date: string; left: bigint }[] = [];
  const weighted = new Map<string, { days: bigint; amount: bigint }>();
  const take = (amount: bigint, date: string, record: boolean) => {
    let need = amount;
    while (need > 0n && queue.length) {
      const head = queue[0]!;
      const n = head.left < need ? head.left : need;
      if (record) {
        const m = date.slice(0, 7);
        const w = weighted.get(m) ?? { days: 0n, amount: 0n };
        w.days += daysBetween(head.date, date) * n;
        w.amount += n;
        weighted.set(m, w);
      }
      head.left -= n;
      need -= n;
      if (head.left === 0n) queue.shift();
    }
  };
  for (const lines of ordered) {
    const { type, date } = lines[0]!;
    if (type === 'transfer') continue;
    const cash = lines.filter((f) => look.kindOf(f.ledgerAccountId) === 'asset' && look.isCash(f.ledgerAccountId));
    const cashIn = cash.filter((f) => f.amount > 0n).reduce((s, f) => s + f.amount, 0n);
    const cashOut = -cash.filter((f) => f.amount < 0n).reduce((s, f) => s + f.amount, 0n);
    if (cashIn > 0n) queue.push({ date, left: cashIn });
    if (cashOut === 0n) continue;
    const spent = lines
      .filter((f) => look.kindOf(f.ledgerAccountId) === 'expense' && f.amount > 0n)
      .reduce((s, f) => s + f.amount, 0n);
    const counted = spent < cashOut ? spent : cashOut;
    take(counted, date, true);
    take(cashOut - counted, date, false);
  }
  const out = new Map<string, bigint>();
  for (const [m, w] of weighted) if (w.amount > 0n) out.set(m, w.days / w.amount);
  return out;
}

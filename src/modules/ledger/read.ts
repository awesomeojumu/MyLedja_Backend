import type { AccountRef, Line } from './ledger.types.js';

/** One row of `period_totals`: an account's debits and credits (both positive) in a month. */
export type PeriodTotal = { ledgerAccountId: string; month: string; debitsMinor: bigint; creditsMinor: bigint };

export const monthOf = (date: string) => date.slice(0, 7);

/** Period totals from posted events' lines, the way `postEvent` keeps them. */
export function periodTotals(events: readonly { date: string; lines: readonly Line[] }[]): PeriodTotal[] {
  const rows = new Map<string, PeriodTotal>();
  for (const e of events) {
    for (const l of e.lines) {
      const key = `${l.ledgerAccountId}|${monthOf(e.date)}`;
      const row = rows.get(key) ?? {
        ledgerAccountId: l.ledgerAccountId,
        month: monthOf(e.date),
        debitsMinor: 0n,
        creditsMinor: 0n,
      };
      if (l.amountMinor > 0n) row.debitsMinor += l.amountMinor;
      else row.creditsMinor -= l.amountMinor;
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

/** Balance of each account: the sum of its lines (TECH-SPEC 6.1). Assets are positive; liabilities negative. */
export function balances(events: readonly { lines: readonly Line[] }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const e of events)
    for (const l of e.lines) out.set(l.ledgerAccountId, (out.get(l.ledgerAccountId) ?? 0n) + l.amountMinor);
  return out;
}

/** What a person sees: an asset's balance, or for a liability what they owe as a positive figure. */
export const shownBalance = (kind: AccountRef['kind'], balance: bigint) => (kind === 'liability' ? -balance : balance);

export type MonthFigures = {
  /** Credits minus debits to income accounts (TECH-SPEC 6.7). */
  income: bigint;
  /** Debits minus credits (refunds and reversals) to expense accounts. */
  spent: bigint;
  /** Debits to loss accounts: Written off and Investment loss. Never spending. */
  losses: bigint;
  incomeByAccount: Map<string, bigint>;
  spentByAccount: Map<string, bigint>;
};

/** The month's Income, Spent and Losses from period totals. `include` limits income to budgetable accounts. */
export function monthFigures(
  totals: readonly PeriodTotal[],
  month: string,
  accountOf: (id: string) => Pick<AccountRef, 'kind'> | null,
): MonthFigures {
  const f: MonthFigures = { income: 0n, spent: 0n, losses: 0n, incomeByAccount: new Map(), spentByAccount: new Map() };
  for (const t of totals) {
    if (t.month !== month) continue;
    const kind = accountOf(t.ledgerAccountId)?.kind;
    const net = t.debitsMinor - t.creditsMinor;
    if (kind === 'income') {
      f.income -= net;
      f.incomeByAccount.set(t.ledgerAccountId, (f.incomeByAccount.get(t.ledgerAccountId) ?? 0n) - net);
    } else if (kind === 'expense') {
      f.spent += net;
      f.spentByAccount.set(t.ledgerAccountId, (f.spentByAccount.get(t.ledgerAccountId) ?? 0n) + net);
    } else if (kind === 'loss') {
      f.losses += net;
    }
  }
  return f;
}

/**
 * Net worth in the workspace currency: everything you have minus everything you owe (TECH-SPEC 6.7).
 * Balances in other currencies need a rate; without one they're left out and `partial` names them.
 */
export function netWorth(
  balanceOf: ReadonlyMap<string, bigint>,
  accounts: readonly Pick<AccountRef, 'id' | 'kind' | 'currency' | 'systemKey'>[],
  currency: string,
  convert: (amount: bigint, from: string) => bigint | null = () => null,
): { amount: bigint; partial: string[] } {
  let amount = 0n;
  const partial = new Set<string>();
  for (const a of accounts) {
    if ((a.kind !== 'asset' && a.kind !== 'liability') || a.systemKey !== null) continue;
    const b = balanceOf.get(a.id) ?? 0n;
    if (b === 0n) continue;
    if (a.currency === currency) amount += b;
    else {
      const converted = convert(b, a.currency);
      if (converted === null) partial.add(a.currency);
      else amount += converted;
    }
  }
  return { amount, partial: [...partial].sort() };
}

export type BudgetCategoryMonth = {
  carried: bigint;
  assigned: bigint;
  activity: bigint;
  available: bigint;
  /** used % in basis points of (assigned + carried), or null when nothing is planned. */
  usedBasisPoints: bigint | null;
  state: 'within_plan' | 'near_limit' | 'over_plan' | 'no_plan';
};

export type BudgetMonth = {
  month: string;
  categories: Map<string, BudgetCategoryMonth>;
  /** Envelope only: what's still to be given a job. Null in tracking style. */
  leftToPlan: bigint | null;
  /** Envelope: overspending carried from the month before, taken from this month's left to plan. */
  overspentFromLastMonth: bigint;
};

export type BudgetInput = {
  style: 'envelope' | 'tracking';
  /** Ascending, consecutive months from the first month with a plan. */
  months: readonly string[];
  categoryIds: readonly string[];
  assigned(categoryId: string, month: string): bigint;
  /** Net spending: expense lines minus refunds dated in the month. E19 goal spend is excluded. */
  activity(categoryId: string, month: string): bigint;
  /** Income lines in budgetable categories, received in the month. */
  budgetableIncome(month: string): bigint;
  /** E18 earmarks made in the month (TECH-SPEC 6.6 left_to_plan). Spends from goals do not count. */
  goalAllocations?(month: string): bigint;
  /** Tracking style: categories whose carry-over switch is on. */
  carriesOver?(categoryId: string): boolean;
};

function barState(activity: bigint, planned: bigint): Pick<BudgetCategoryMonth, 'usedBasisPoints' | 'state'> {
  if (planned <= 0n) return { usedBasisPoints: null, state: activity > 0n ? 'over_plan' : 'no_plan' };
  const used = (activity * 10_000n) / planned;
  return {
    usedBasisPoints: used,
    state: used >= 10_000n ? 'over_plan' : used >= 8_000n ? 'near_limit' : 'within_plan',
  };
}

/**
 * Both budget styles (TECH-SPEC 6.6). Envelope: available = carried + assigned − activity; an overspent
 * category starts next month at 0 and the overspending comes out of next month's left to plan. Tracking:
 * remaining = limit − activity, with nothing carried unless the category's carry-over is on.
 */
export function budgetMonths(input: BudgetInput): BudgetMonth[] {
  const out: BudgetMonth[] = [];
  const carried = new Map<string, bigint>();
  let leftToPlan = 0n;
  let overspent = 0n;
  for (const month of input.months) {
    const categories = new Map<string, BudgetCategoryMonth>();
    let assignedTotal = 0n;
    let overspentNow = 0n;
    for (const id of input.categoryIds) {
      const assigned = input.assigned(id, month);
      const activity = input.activity(id, month);
      const carry = input.style === 'envelope' || input.carriesOver?.(id) ? (carried.get(id) ?? 0n) : 0n;
      const available = carry + assigned - activity;
      assignedTotal += assigned;
      categories.set(id, { carried: carry, assigned, activity, available, ...barState(activity, assigned + carry) });
      if (available >= 0n) carried.set(id, available);
      else {
        carried.set(id, 0n);
        overspentNow -= available;
      }
    }
    const overspentFromLastMonth = input.style === 'envelope' ? overspent : 0n;
    if (input.style === 'envelope') {
      leftToPlan =
        input.budgetableIncome(month) + leftToPlan - assignedTotal - overspent - (input.goalAllocations?.(month) ?? 0n);
      overspent = overspentNow;
    }
    out.push({
      month,
      categories,
      leftToPlan: input.style === 'envelope' ? leftToPlan : null,
      overspentFromLastMonth,
    });
  }
  return out;
}

/** The months from `first` to `last` inclusive, as YYYY-MM. */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number) as [number, number];
  const [ly, lm] = last.split('-').map(Number) as [number, number];
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

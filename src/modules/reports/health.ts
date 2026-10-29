import { divRoundHalfAwayFromZero } from '../../common/money/money.js';

/**
 * Financial health (TECH-SPEC 6.10, DESIGN.md page 23). Pure, so the app runs the same formulas and the
 * stress test offline. Ratios are basis points (1% = 100) and runway is hundredths of a month, all bigint.
 */

export const PILLARS = ['saving', 'runway', 'debt_load', 'bills', 'budget'] as const;
export type PillarKey = (typeof PILLARS)[number];

/** Weights, re-shared among the pillars that have data (6.10). */
export const WEIGHTS: Record<PillarKey, number> = { saving: 25, runway: 25, debt_load: 20, bills: 15, budget: 15 };

export type HealthInput = {
  /** The last three complete months, oldest first. */
  months: { month: string; income: bigint; spending: bigint; essential: bigint; hasData: boolean }[];
  /** Accounts counted as cash, today. */
  liquidCash: bigint;
  /** Money borrowed in the last three months that's still owed: never counted as cash (P23-07). */
  recentBorrowing: bigint;
  /** Debt payments (principal and interest) in each of the three months. */
  debtPayments: bigint[];
  /** Bills due in the three months, and how many were paid by their due date. */
  bills: { due: number; onTime: number };
  /** Spending categories with a plan last complete month, and how many stayed within it. */
  budget: { planned: number; within: number; overspent: number };
  /** Days since the first transaction. */
  historyDays: number;
  /** Emergency target in months (3, 6 or 12). */
  targetMonths: number;
};

export type Pillar = {
  key: PillarKey;
  /** Saving, debt load, bills and budget: basis points. Runway: hundredths of a month. Null without data. */
  value: bigint | null;
  score: number | null;
  /** The numbers the formula used, for the explainer (P23-02). */
  used: Record<string, bigint>;
};

export type Health = {
  ready: boolean;
  score: number | null;
  band: 'strong' | 'okay' | 'needs_attention' | null;
  pillars: Pillar[];
  /** What's missing while the score isn't ready (P23-03). */
  missing: ('two_months' | 'three_pillars')[];
  advice: Advice[];
};

export type Advice =
  | { pillar: 'saving'; link: 'budget' }
  | { pillar: 'runway'; link: 'goals'; monthly: bigint }
  | { pillar: 'debt_load'; link: 'debts' }
  | { pillar: 'bills'; link: 'plan'; late: number }
  | { pillar: 'budget'; link: 'budget'; overspent: number };

const clamp = (n: bigint, lo: bigint, hi: bigint) => (n < lo ? lo : n > hi ? hi : n);
const pct = (num: bigint, den: bigint) => divRoundHalfAwayFromZero(num * 10_000n, den);
const score = (n: bigint) => Number(clamp(n, 0n, 100n));

function median(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : divRoundHalfAwayFromZero(s[mid - 1]! + s[mid]!, 2n);
}

/** Saving: (income − spending) ÷ income over the three months. 0% or less is 0; 20% or more is 100. */
export function savingPillar(input: HealthInput): Pillar {
  const months = input.months.filter((m) => m.hasData);
  const income = months.reduce((s, m) => s + m.income, 0n);
  const spending = months.reduce((s, m) => s + m.spending, 0n);
  const used = { income, spending };
  if (months.length < 2 || (income === 0n && spending === 0n)) return { key: 'saving', value: null, score: null, used };
  if (income <= 0n) return { key: 'saving', value: -10_000n, score: 0, used };
  const rate = pct(income - spending, income);
  return { key: 'saving', value: rate, score: score(divRoundHalfAwayFromZero(rate, 20n)), used };
}

/** Runway: cash ÷ the median monthly essential spending. 0 months is 0; the target or more is 100. */
export function runwayPillar(input: HealthInput): Pillar {
  const months = input.months.filter((m) => m.hasData);
  const net = input.liquidCash - input.recentBorrowing;
  const cash = net > 0n ? net : 0n;
  const essential = median(months.map((m) => m.essential));
  const used = { cash, essential, borrowed: input.recentBorrowing, target: BigInt(input.targetMonths) };
  if (months.length < 2) return { key: 'runway', value: null, score: null, used };
  if (essential <= 0n) return { key: 'runway', value: null, score: cash > 0n ? 100 : null, used };
  const hundredths = divRoundHalfAwayFromZero(cash * 100n, essential);
  const target = BigInt(input.targetMonths) * 100n;
  return { key: 'runway', value: hundredths, score: score(divRoundHalfAwayFromZero(hundredths * 100n, target)), used };
}

/** Debt load: debt payments ÷ average monthly income. 50% or more is 0; 10% or less is 100. */
export function debtPillar(input: HealthInput): Pillar {
  const months = input.months.filter((m) => m.hasData);
  const n = BigInt(Math.max(1, months.length));
  const income = divRoundHalfAwayFromZero(
    months.reduce((s, m) => s + m.income, 0n),
    n,
  );
  const payments = divRoundHalfAwayFromZero(
    input.debtPayments.reduce((s, p) => s + p, 0n),
    BigInt(Math.max(1, input.debtPayments.length)),
  );
  const used = { payments, income };
  if (months.length < 2) return { key: 'debt_load', value: null, score: null, used };
  if (payments === 0n) return { key: 'debt_load', value: 0n, score: 100, used };
  if (income <= 0n) return { key: 'debt_load', value: null, score: 0, used };
  const ratio = pct(payments, income);
  return {
    key: 'debt_load',
    value: ratio,
    score: score(divRoundHalfAwayFromZero((5_000n - ratio) * 100n, 4_000n)),
    used,
  };
}

/** Bills on time: bills paid by their due date ÷ bills due. */
export function billsPillar(input: HealthInput): Pillar {
  const used = { due: BigInt(input.bills.due), onTime: BigInt(input.bills.onTime) };
  if (input.bills.due === 0 || input.months.filter((m) => m.hasData).length < 2) {
    return { key: 'bills', value: null, score: null, used };
  }
  const ratio = pct(BigInt(input.bills.onTime), BigInt(input.bills.due));
  return { key: 'bills', value: ratio, score: score(divRoundHalfAwayFromZero(ratio, 100n)), used };
}

/** Budget: categories within plan ÷ categories with a plan, last complete month. */
export function budgetPillar(input: HealthInput): Pillar {
  const used = { planned: BigInt(input.budget.planned), within: BigInt(input.budget.within) };
  if (input.budget.planned === 0) return { key: 'budget', value: null, score: null, used };
  const ratio = pct(BigInt(input.budget.within), BigInt(input.budget.planned));
  return { key: 'budget', value: ratio, score: score(divRoundHalfAwayFromZero(ratio, 100n)), used };
}

export const bandOf = (s: number): Health['band'] => (s >= 80 ? 'strong' : s >= 60 ? 'okay' : 'needs_attention');

/** The score and what to do next. Advice is chosen by rules from the lowest pillars (6.10). */
export function health(input: HealthInput): Health {
  const pillars = [
    savingPillar(input),
    runwayPillar(input),
    debtPillar(input),
    billsPillar(input),
    budgetPillar(input),
  ];
  const scored = pillars.filter((p) => p.score !== null);
  const missing: Health['missing'] = [];
  if (input.historyDays < 60) missing.push('two_months');
  if (scored.length < 3) missing.push('three_pillars');
  const ready = missing.length === 0;
  let value: number | null = null;
  if (ready) {
    const weight = scored.reduce((s, p) => s + WEIGHTS[p.key], 0);
    const total = scored.reduce((s, p) => s + WEIGHTS[p.key] * p.score!, 0);
    value = Number(divRoundHalfAwayFromZero(BigInt(total), BigInt(weight)));
  }
  const advice: Advice[] = [];
  for (const p of [...scored].sort((a, b) => a.score! - b.score! || PILLARS.indexOf(a.key) - PILLARS.indexOf(b.key))) {
    if (advice.length === 3 || p.score! >= 80) break;
    advice.push(adviceFor(p, input));
  }
  return { ready, score: value, band: value === null ? null : bandOf(value), pillars, missing, advice };
}

function adviceFor(p: Pillar, input: HealthInput): Advice {
  switch (p.key) {
    case 'saving':
      return { pillar: 'saving', link: 'budget' };
    case 'runway': {
      const need = BigInt(input.targetMonths) * p.used.essential! - p.used.cash!;
      // What a month would close the gap within a year, rounded up.
      return { pillar: 'runway', link: 'goals', monthly: need > 0n ? (need + 11n) / 12n : 0n };
    }
    case 'debt_load':
      return { pillar: 'debt_load', link: 'debts' };
    case 'bills':
      return { pillar: 'bills', link: 'plan', late: input.bills.due - input.bills.onTime };
    case 'budget':
      return { pillar: 'budget', link: 'budget', overspent: input.budget.overspent };
  }
}

/**
 * The stress test (P23-06): income drops by a share and a surprise cost leaves the cash. Nothing is saved.
 * `incomeDrop` is basis points (30% = 3000).
 */
export function stress(input: HealthInput, incomeDrop: bigint, surpriseCost: bigint) {
  const keep = 10_000n - clamp(incomeDrop, 0n, 10_000n);
  const after: HealthInput = {
    ...input,
    liquidCash: input.liquidCash - surpriseCost,
    months: input.months.map((m) => ({ ...m, income: divRoundHalfAwayFromZero(m.income * keep, 10_000n) })),
  };
  const before = health(input);
  const then = health(after);
  return {
    runway: { before: runwayPillar(input).value, after: runwayPillar(after).value },
    score: { before: before.score, after: then.score },
  };
}

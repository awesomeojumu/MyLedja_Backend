import { describe, expect, it } from 'vitest';
import {
  billsPillar,
  budgetPillar,
  debtPillar,
  health,
  type HealthInput,
  runwayPillar,
  savingPillar,
  stress,
} from '../health.js';

const month = (m: string, income: bigint, spending: bigint, essential = spending) => ({
  month: m,
  income,
  spending,
  essential,
  hasData: true,
});

const base: HealthInput = {
  months: [
    month('2026-07', 64_000_000n, 48_000_000n, 30_000_000n),
    month('2026-08', 64_000_000n, 48_000_000n, 32_000_000n),
    month('2026-09', 64_000_000n, 46_000_000n, 31_000_000n),
  ],
  liquidCash: 99_200_000n,
  recentBorrowing: 0n,
  debtPayments: [3_840_000n, 3_840_000n, 3_840_000n],
  bills: { due: 12, onTime: 11 },
  budget: { planned: 11, within: 9, overspent: 2 },
  historyDays: 120,
  targetMonths: 6,
};

describe('Health pillars (TECH-SPEC 6.10)', () => {
  it('Saving: (income − spending) ÷ income, 20% or more scores 100', () => {
    const p = savingPillar(base);
    // (192m − 142m) ÷ 192m = 26.04%
    expect(p.value).toBe(2_604n);
    expect(p.score).toBe(100);
    expect(savingPillar({ ...base, months: base.months.map((m) => ({ ...m, spending: m.income })) }).score).toBe(0);
    const tenPercent = base.months.map((m) => ({ ...m, spending: (m.income * 9n) / 10n }));
    expect(savingPillar({ ...base, months: tenPercent }).score).toBe(50);
  });

  it('Runway: cash ÷ median essential spending against the target', () => {
    const p = runwayPillar(base);
    // 992,000 ÷ 310,000 = 3.2 months; 3.2 ÷ 6 = 53
    expect(p.value).toBe(320n);
    expect(p.score).toBe(53);
  });

  it('Runway uses the median, so one odd month does not distort it', () => {
    const odd = {
      ...base,
      months: [base.months[0]!, { ...base.months[1]!, essential: 900_000_000n }, base.months[2]!],
    };
    expect(runwayPillar(odd).value).toBe(runwayPillar({ ...odd, months: [...odd.months] }).value);
    expect(runwayPillar(odd).used.essential).toBe(31_000_000n);
  });

  it('Debt load: payments ÷ average income; 10% or less scores 100, 50% or more 0', () => {
    expect(debtPillar(base)).toMatchObject({ value: 600n, score: 100 });
    expect(debtPillar({ ...base, debtPayments: [32_000_000n] }).score).toBe(0);
    expect(debtPillar({ ...base, debtPayments: [19_200_000n] })).toMatchObject({ value: 3_000n, score: 50 });
  });

  it('Bills on time and Budget are percentages', () => {
    expect(billsPillar(base)).toMatchObject({ value: 9_167n, score: 92 });
    expect(budgetPillar(base)).toMatchObject({ value: 8_182n, score: 82 });
  });

  it('the score is the weighted average, with weights shared among pillars that have data', () => {
    const h = health(base);
    // (25×100 + 25×53 + 20×100 + 15×92 + 15×82) ÷ 100 = 84.35
    expect(h).toMatchObject({ ready: true, score: 84, band: 'strong' });
    const noBills = health({ ...base, bills: { due: 0, onTime: 0 } });
    // (25×100 + 25×53 + 20×100 + 15×82) ÷ 85 = 83.0
    expect(noBills.score).toBe(83);
  });
});

describe('not enough data (P23-03)', () => {
  it('a pillar needs two complete months', () => {
    const one = {
      ...base,
      months: [{ ...base.months[0]!, hasData: false }, { ...base.months[1]!, hasData: false }, base.months[2]!],
    };
    expect(savingPillar(one).score).toBeNull();
    expect(runwayPillar(one).score).toBeNull();
  });

  it('the score is hidden with under 60 days of history or fewer than three pillars', () => {
    expect(health({ ...base, historyDays: 45 })).toMatchObject({ ready: false, score: null, missing: ['two_months'] });
    const thin = health({
      ...base,
      months: base.months.map((m) => ({ ...m, hasData: false })),
      bills: { due: 0, onTime: 0 },
    });
    expect(thin).toMatchObject({ ready: false, score: null });
    expect(thin.missing).toContain('three_pillars');
  });
});

describe('borrowed money never raises the score (P23-07)', () => {
  it('borrowing ₦500,000 leaves every pillar and the score as they were', () => {
    const borrowed = { ...base, liquidCash: base.liquidCash + 50_000_000n, recentBorrowing: 50_000_000n };
    expect(health(borrowed).score).toBe(health(base).score);
    expect(runwayPillar(borrowed).value).toBe(runwayPillar(base).value);
  });
});

describe('advice and stress test', () => {
  it('advice comes from the lowest pillars, at most three, each with its page', () => {
    const h = health(base);
    expect(h.advice).toEqual([{ pillar: 'runway', link: 'goals', monthly: 7_233_334n }]);
    const weak = health({ ...base, bills: { due: 10, onTime: 5 }, budget: { planned: 10, within: 4, overspent: 6 } });
    expect(weak.advice.map((a) => a.pillar)).toEqual(['budget', 'bills', 'runway']);
  });

  it('a 30% income drop and a ₦200,000 surprise cost lower runway and score', () => {
    const s = stress(base, 3_000n, 20_000_000n);
    expect(s.runway).toEqual({ before: 320n, after: 255n });
    expect(s.score.after!).toBeLessThan(s.score.before!);
  });
});

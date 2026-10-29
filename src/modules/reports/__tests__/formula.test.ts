import { describe, expect, it } from 'vitest';
import { evaluate, FormulaError } from '../formula.js';

const vars = {
  income: 73_000_000n,
  spending: 54_020_000n,
  net: 18_980_000n,
  assets: 120_000_000n,
  debts: 45_000_000n,
  net_worth: 75_000_000n,
};

describe('formula cards', () => {
  it('works out amounts', () => {
    expect(evaluate('income - spending', vars)).toEqual({ unit: 'money', value: 18_980_000n });
    expect(evaluate('(income - spending) / 2', vars)).toEqual({ unit: 'money', value: 9_490_000n });
    expect(evaluate('spending × 1.5', vars)).toEqual({ unit: 'money', value: 81_030_000n });
  });

  it('a plain number beside money in + or − is naira', () => {
    expect(evaluate('income - 5000', vars)).toEqual({ unit: 'money', value: 72_500_000n });
  });

  it('money ÷ money is a ratio in basis points', () => {
    expect(evaluate('spending / income', vars)).toEqual({ unit: 'basis_points', value: 7_400n });
    expect(evaluate('1 - spending / income', vars)).toEqual({ unit: 'basis_points', value: 2_600n });
  });

  it('refuses what has no meaning', () => {
    const reason = (src: string) => {
      try {
        evaluate(src, vars);
        return null;
      } catch (e) {
        return (e as FormulaError).reason;
      }
    };
    expect(reason('income * spending')).toBe('units');
    expect(reason('2 / income')).toBe('units');
    expect(reason('income / 0')).toBe('divide_by_zero');
    expect(reason('salary')).toBe('unknown_name');
    expect(reason('income +')).toBe('syntax');
    expect(reason('(income')).toBe('syntax');
    expect(reason('income ^ 2')).toBe('syntax');
  });
});

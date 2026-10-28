import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocate,
  convert,
  divRoundHalfAwayFromZero,
  divRoundHalfEven,
  exponentOf,
  formatAmount,
  formatNaira,
  instalments,
  MoneyError,
  parseMajor,
  parseMinor,
  percentOf,
  toMinorString,
} from '../money.js';

const refuses = (fn: () => unknown, code: string) => {
  expect(fn).toThrowError(MoneyError);
  try {
    fn();
  } catch (e) {
    expect((e as MoneyError).code).toBe(code);
  }
};

describe('minor-unit strings (TECH-SPEC 6.5)', () => {
  it('round-trips', () => {
    expect(parseMinor('1845000')).toBe(1845000n);
    expect(parseMinor('-600')).toBe(-600n);
    expect(parseMinor('0')).toBe(0n);
    expect(toMinorString(-1845000n)).toBe('-1845000');
  });

  it('refuses floats, leading zeros and junk', () => {
    for (const v of ['18.45', '01', '', '1e5', '-0', ' 1', 'abc']) refuses(() => parseMinor(v), 'amount_unreadable');
  });
});

describe('parseMajor', () => {
  it('reads what people type', () => {
    expect(parseMajor('18450')).toBe(1845000n);
    expect(parseMajor('18,450.00')).toBe(1845000n);
    expect(parseMajor('₦1,284,560.5')).toBe(128456050n);
    expect(parseMajor(' 0.01 ')).toBe(1n);
    expect(parseMajor('-25000')).toBe(-2500000n);
    expect(parseMajor('−25000')).toBe(-2500000n);
    expect(parseMajor('500', 'JPY')).toBe(500n);
  });

  it('refuses "1,2,3", too many decimals and empty input', () => {
    for (const v of ['1,2,3', '12.345', '', '.5', '1,23', '12a', '1.', '₦'])
      refuses(() => parseMajor(v), 'amount_unreadable');
    refuses(() => parseMajor('1.5', 'JPY'), 'amount_unreadable');
  });

  it('refuses an unknown currency', () => {
    refuses(() => parseMajor('1', 'XXX'), 'currency_unknown');
    refuses(() => exponentOf('XXX'), 'currency_unknown');
  });
});

describe('formatting (DESIGN.md 2.6)', () => {
  it('shows naira with kobo and commas', () => {
    expect(formatNaira(128456050n)).toBe('₦1,284,560.50');
    expect(formatNaira(0n)).toBe('₦0.00');
    expect(formatNaira(5n)).toBe('₦0.05');
    expect(formatNaira(-1845000n)).toBe('−₦18,450.00');
    expect(formatAmount(1234n, 'JPY', '¥')).toBe('¥1,234');
  });
});

describe('rounding', () => {
  it('rounds half away from zero', () => {
    expect(divRoundHalfAwayFromZero(5n, 2n)).toBe(3n);
    expect(divRoundHalfAwayFromZero(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfAwayFromZero(4n, 3n)).toBe(1n);
    expect(divRoundHalfAwayFromZero(-4n, 3n)).toBe(-1n);
    expect(divRoundHalfAwayFromZero(5n, -2n)).toBe(-3n);
    expect(divRoundHalfAwayFromZero(6n, 3n)).toBe(2n);
  });

  it('rounds half to even', () => {
    expect(divRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divRoundHalfEven(7n, 2n)).toBe(4n);
    expect(divRoundHalfEven(-5n, 2n)).toBe(-2n);
    expect(divRoundHalfEven(-7n, 2n)).toBe(-4n);
    expect(divRoundHalfEven(7n, 3n)).toBe(2n);
    expect(divRoundHalfEven(8n, 3n)).toBe(3n);
    expect(divRoundHalfEven(5n, -2n)).toBe(-2n);
  });

  it('refuses division by zero', () => {
    refuses(() => divRoundHalfAwayFromZero(1n, 0n), 'parts_invalid');
    refuses(() => divRoundHalfEven(1n, 0n), 'parts_invalid');
  });

  it('case 24: 8% pension on ₦800,000.01 is ₦64,000.00, and the parts add up to the gross', () => {
    const gross = 80000001n;
    const pension = percentOf(gross, 800n);
    expect(pension).toBe(6400000n);
    const [p, rest] = allocate(gross, [800n, 9200n]);
    expect(p).toBe(6400000n);
    expect(p! + rest!).toBe(gross);
  });

  it('₦100.00 split three ways adds up exactly, the leftover going to the largest part', () => {
    const parts = allocate(10000n, [1n, 1n, 1n]);
    expect(parts).toEqual([3334n, 3333n, 3333n]);
    expect(allocate(10000n, [1n, 2n, 1n])).toEqual([2500n, 5000n, 2500n]);
    expect(allocate(100n, [1n, 1n, 4n])).toEqual([17n, 17n, 66n]);
  });

  it('refuses invalid weights', () => {
    refuses(() => allocate(100n, []), 'parts_invalid');
    refuses(() => allocate(100n, [0n, 0n]), 'parts_invalid');
    refuses(() => allocate(100n, [1n, -1n]), 'parts_invalid');
  });

  it('instalments: the last absorbs the difference', () => {
    expect(instalments(10000n, 3)).toEqual([3333n, 3333n, 3334n]);
    expect(instalments(20000n, 3)).toEqual([6667n, 6667n, 6666n]);
    expect(instalments(500n, 1)).toEqual([500n]);
    refuses(() => instalments(100n, 0), 'parts_invalid');
    refuses(() => instalments(100n, 1.5), 'parts_invalid');
  });

  it('property: allocate and instalments always add up to the total', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.array(fc.bigInt({ min: 1n, max: 10_000n }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 60 }),
        (total, weights, n) => {
          expect(allocate(total, weights).reduce((a, b) => a + b, 0n)).toBe(total);
          expect(instalments(total, n).reduce((a, b) => a + b, 0n)).toBe(total);
        },
      ),
    );
  });
});

describe('convert (TECH-SPEC 6.5)', () => {
  it('case 25: $120.00 at ₦1,550.00 is ₦186,000.00', () => {
    expect(convert(12000n, 'USD', 'NGN', '1550')).toBe(18600000n);
  });

  it('rounds half to even on fractional rates and across exponents', () => {
    expect(convert(1n, 'USD', 'NGN', '0.5')).toBe(0n);
    expect(convert(3n, 'USD', 'NGN', '0.5')).toBe(2n);
    expect(convert(100n, 'JPY', 'NGN', '10.25')).toBe(102500n);
    expect(convert(102500n, 'NGN', 'JPY', '0.0097560976')).toBe(10n);
  });

  it('refuses an unreadable rate', () => {
    for (const r of ['', '-1', '1.12345678901', 'x', '01'])
      refuses(() => convert(1n, 'USD', 'NGN', r), 'rate_unreadable');
  });
});

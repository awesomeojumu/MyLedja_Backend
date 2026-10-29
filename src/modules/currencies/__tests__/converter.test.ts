import { describe, expect, it } from 'vitest';
import { converterOf } from '../currencies.service.js';

describe('converterOf (TECH-SPEC 6.5, 6.7, case 25)', () => {
  const convert = converterOf(
    [
      { currency: 'USD', date: '2026-10-01', rate: '1500' },
      { currency: 'USD', date: '2026-10-20', rate: '1550' },
      { currency: 'GBP', date: '2026-10-01', rate: '2000.5' },
    ],
    'NGN',
  );

  it('uses the latest rate on or before the date', () => {
    expect(convert(12000n, 'USD', '2026-10-28')).toBe(18_600_000n);
    expect(convert(12000n, 'USD', '2026-10-19')).toBe(18_000_000n);
  });

  it('gives null before the first rate, or for a currency with none', () => {
    expect(convert(12000n, 'USD', '2026-09-30')).toBeNull();
    expect(convert(12000n, 'EUR', '2026-10-28')).toBeNull();
  });

  it('leaves the home currency alone and rounds half to even', () => {
    expect(convert(123n, 'NGN', '2000-01-01')).toBe(123n);
    // £0.01 at 2000.5 is ₦20.005: half to even gives 2000 kobo.
    expect(convert(1n, 'GBP', '2026-10-28')).toBe(2000n);
  });
});

import { describe, expect, it } from 'vitest';
import { dayInMonth, occurrencesInMonth } from '../recurrence.js';

describe('schedule recurrence (TECH-SPEC 6.4)', () => {
  it('uses the last day when day 31 falls in February', () => {
    expect(dayInMonth(2026, 2, 31)).toBe(28);
    const dates = occurrencesInMonth(
      '2026-01-31',
      { every: 1, unit: 'month', dayOfMonth: 31, weekday: null },
      { kind: 'never' },
      '2026-02',
    );
    expect(dates).toEqual(['2026-02-28']);
  });

  it('day 0 means last day of month', () => {
    const dates = occurrencesInMonth(
      '2026-01-31',
      { every: 1, unit: 'month', dayOfMonth: 0, weekday: null },
      { kind: 'never' },
      '2026-04',
    );
    expect(dates).toEqual(['2026-04-30']);
  });
});

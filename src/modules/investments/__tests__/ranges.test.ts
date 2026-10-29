import { describe, expect, it } from 'vitest';
import { rangeStart, seriesDates } from '../investments.service.js';

describe('value line points (DESIGN.md pages 17 and 18)', () => {
  it('1M and 3M are weekly, ending today', () => {
    const d = seriesDates('1M', '2026-10-28', null);
    expect(d.at(-1)).toBe('2026-10-28');
    expect(d[0]).toBe('2026-09-30');
    expect(d).toHaveLength(5);
    expect(seriesDates('3M', '2026-10-28', null)).toHaveLength(14);
  });

  it('1Y is month ends, ending today', () => {
    const d = seriesDates('1Y', '2026-10-28', null);
    expect(d.at(-1)).toBe('2026-10-28');
    expect(d.at(-2)).toBe('2026-09-30');
    expect(d[0]).toBe('2025-10-31');
  });

  it('All starts at the first event', () => {
    expect(rangeStart('All', '2026-10-28', '2026-08-15')).toBe('2026-08-15');
    expect(seriesDates('All', '2026-10-28', '2026-08-15')).toEqual(['2026-08-31', '2026-09-30', '2026-10-28']);
    expect(seriesDates('All', '2026-10-28', null)).toEqual(['2026-10-28']);
  });
});

import { describe, expect, it } from 'vitest';
import { applyRules, type RuleInput } from '../rules.engine.js';

const row: RuleInput = {
  payeeName: 'BOLT',
  description: 'BOLT RIDE LAGOS',
  amountMinor: 350_000n,
  accountId: 'a1',
  categoryId: '',
  notes: '',
  date: '2026-10-12',
};
const rule = (over: Partial<Parameters<typeof applyRules>[0][number]>) => ({
  enabled: true,
  stage: 'normal' as const,
  order: 0,
  matchMode: 'all' as const,
  conditions: [{ field: 'payee' as const, op: 'contains' as const, value: 'bolt' }],
  actions: [{ kind: 'setCategory' as const, value: 'cat-transport' }],
  matchedCount: 0,
  ...over,
});

describe('rules engine (B4.5)', () => {
  it('applies a matching rule', () => {
    expect(applyRules([rule({})], row)).toEqual({ categoryId: 'cat-transport' });
  });

  it('ignores disabled rules and rules with no conditions', () => {
    expect(applyRules([rule({ enabled: false }), rule({ conditions: [] })], row)).toEqual({});
  });

  it('runs first, then normal, then last; later rules win', () => {
    const rules = [
      rule({ stage: 'last', actions: [{ kind: 'setCategory', value: 'cat-last' }] }),
      rule({ stage: 'first', actions: [{ kind: 'setCategory', value: 'cat-first' }] }),
    ];
    expect(applyRules(rules, row).categoryId).toBe('cat-last');
  });

  it('compares amounts in kobo and matches any or all', () => {
    const big = { field: 'amount' as const, op: 'greaterThan' as const, value: '10,000' };
    expect(applyRules([rule({ conditions: [big] })], row)).toEqual({});
    expect(
      applyRules(
        [rule({ matchMode: 'any', conditions: [big, { field: 'description', op: 'contains', value: 'ride' }] })],
        row,
      ).categoryId,
    ).toBe('cat-transport');
  });
});

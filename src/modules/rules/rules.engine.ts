import type { z } from 'zod';
import type { RuleBody, RuleCondition } from './rules.contract.js';

type Rule = z.output<typeof RuleBody>;

/** What a rule can see about a transaction or an imported row. Amount is the size of the movement, in kobo. */
export type RuleInput = {
  payeeName: string;
  description: string;
  amountMinor: bigint;
  accountId: string;
  categoryId: string;
  notes: string;
  date: string;
  /** Money in/out (PU-48). Derived from the signed import amount when present. */
  direction?: 'in' | 'out';
};
export type RuleChange = {
  categoryId?: string;
  payeeName?: string;
  notes?: string;
  /** Tag names to add (encoded into notes on the device; import path may append). */
  tags?: string[];
};

/** "18,450" or "18450.50" in a condition, into kobo. */
function limitOf(value: string): bigint | null {
  const s = value.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
}

function field(input: RuleInput, f: z.output<typeof RuleCondition>['field']): string {
  switch (f) {
    case 'payee':
      return input.payeeName;
    case 'description':
      return input.description;
    case 'amount':
      return input.amountMinor.toString();
    case 'account':
      return input.accountId;
    case 'category':
      return input.categoryId;
    case 'notes':
      return input.notes;
    case 'date':
      return input.date;
    case 'money':
      return input.direction ?? '';
  }
}

/** The same matching as the app's rule engine, so a preview on the phone equals what the server applies. */
export function conditionMatches(input: RuleInput, c: z.output<typeof RuleCondition>): boolean {
  const raw = field(input, c.field);
  const needle = c.value.trim();
  if (c.op === 'isEmpty') {
    return c.field === 'category' ? !input.categoryId : !raw.trim();
  }
  if (c.op === 'isIn') {
    return c.field === 'money' ? input.direction === 'in' : false;
  }
  if (c.op === 'isOut') {
    return c.field === 'money' ? input.direction === 'out' : false;
  }
  if (!needle) return true;
  switch (c.op) {
    case 'contains':
      return raw.toLowerCase().includes(needle.toLowerCase());
    case 'startsWith':
      return raw.toLowerCase().startsWith(needle.toLowerCase());
    case 'equals':
      return c.field === 'account' || c.field === 'category'
        ? raw === needle
        : raw.toLowerCase() === needle.toLowerCase();
    case 'notEquals':
      return c.field === 'account' || c.field === 'category'
        ? raw !== needle
        : raw.toLowerCase() !== needle.toLowerCase();
    case 'isOneOf':
      return needle
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .includes(raw.toLowerCase());
    case 'lessThan': {
      const limit = limitOf(needle);
      return limit !== null && input.amountMinor < limit;
    }
    case 'greaterThan': {
      const limit = limitOf(needle);
      return limit !== null && input.amountMinor > limit;
    }
    case 'between': {
      const parts = needle.split(/[|,]/).map((s) => limitOf(s.trim()));
      const a = parts[0];
      const b = parts[1];
      return a != null && b != null && input.amountMinor >= a && input.amountMinor <= b;
    }
    case 'before':
      return input.date < needle;
    case 'after':
      return input.date > needle;
    case 'dayOfMonth':
      return input.date.slice(8, 10) === needle.padStart(2, '0');
    default:
      return false;
  }
}

const rank = { first: 0, normal: 1, last: 2 } as const;

/** Every enabled rule in order (first, normal, last); later rules override what earlier ones set. */
export function applyRules(rules: Rule[], input: RuleInput): RuleChange {
  const change: RuleChange = {};
  const ordered = [...rules]
    .filter((r) => r.enabled && r.conditions.length)
    .sort((a, b) => rank[a.stage] - rank[b.stage] || a.order - b.order);
  for (const rule of ordered) {
    const hits = rule.conditions.map((c) => conditionMatches(input, c));
    if (!(rule.matchMode === 'any' ? hits.some(Boolean) : hits.every(Boolean))) continue;
    for (const a of rule.actions) {
      if (a.kind === 'setCategory') change.categoryId = a.value;
      if (a.kind === 'renamePayee') change.payeeName = a.value.trim();
      if (a.kind === 'addNote') change.notes = [change.notes, a.value.trim()].filter(Boolean).join('. ');
      if (a.kind === 'addTag' && a.value.trim()) {
        change.tags = [
          ...(change.tags ?? []),
          ...a.value
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        ];
      }
    }
  }
  return change;
}

import { exponentOf, parseMinor } from '../../common/money/money.js';
import { LedgerErrors } from './ledger.errors.js';
import type { EventInput } from './ledger.inputs.js';
import type { AccountRef, EventType, Line, SystemKey } from './ledger.types.js';

/** What the builders may look up. Every lookup is synchronous: the service loads what's needed first. */
export interface Resolver {
  /** A real account (asset or liability), or null if the workspace has none with this id. */
  account(id: string): AccountRef | null;
  /** The ledger account of a category, or null. */
  category(categoryId: string): AccountRef | null;
  system(key: SystemKey): AccountRef;
  /** The event a refund points at, with the refunds already made against it. */
  original(id: string): { type: EventType; status: string; lines: Line[]; refunded: bigint } | null;
}

export type Built = {
  type: EventType;
  lines: Line[];
  /** E7: the rate, units of the first currency per one unit of the second, to 10 decimal places. */
  fxRate?: string;
  refundOf?: string;
};

/** True for a person's own accounts (banks, cards, loans and so on), as opposed to categories and system accounts. */
const isReal = (a: AccountRef) => (a.kind === 'asset' || a.kind === 'liability') && a.systemKey === null;

function real(r: Resolver, id: string, field: string): AccountRef {
  const a = r.account(id);
  if (!a) throw LedgerErrors.accountMissing(field);
  if (!isReal(a)) throw LedgerErrors.wrongAccountKind(field);
  if (a.archived) throw LedgerErrors.archived(field);
  return a;
}

function category(r: Resolver, id: string, want: 'income' | 'expense', field = 'categoryId'): AccountRef {
  const a = r.category(id);
  if (!a) throw LedgerErrors.categoryMissing(field);
  if (a.kind !== want) throw LedgerErrors.wrongCategoryKind(field, want);
  return a;
}

const line = (a: AccountRef, amountMinor: bigint, currency = a.currency): Line => ({
  ledgerAccountId: a.id,
  amountMinor,
  currency,
  ...(a.categoryId ? { categoryId: a.categoryId } : {}),
});

/**
 * Turns a person's input into balanced lines, one rule per event type (TECH-SPEC 6.2). Pure: the
 * same input and accounts always give the same lines, so the app can run the same rules offline.
 */
export function buildEvent(input: EventInput, r: Resolver): Built {
  switch (input.type) {
    case 'income':
      return buildIncome(input, r);
    case 'expense':
      return buildExpense(input, r);
    case 'transfer':
      return buildTransfer(input, r);
    case 'opening_balance':
      return buildOpeningBalance(input, r);
    case 'balance_adjustment':
      return buildAdjustment(input, r);
    case 'refund':
      return buildRefund(input, r);
  }
}

/** E1: Dr account · Cr income:category. */
function buildIncome(input: Extract<EventInput, { type: 'income' }>, r: Resolver): Built {
  const acc = real(r, input.accountId, 'accountId');
  const cat = category(r, input.categoryId, 'income');
  const amount = parseMinor(input.amount);
  return { type: 'income', lines: [line(acc, amount), line(cat, -amount, acc.currency)] };
}

/** E2, E3, E5 and E12: Dr expense:category (one per part) · Cr account. */
function buildExpense(input: Extract<EventInput, { type: 'expense' }>, r: Resolver): Built {
  const acc = real(r, input.accountId, 'accountId');
  const total = parseMinor(input.amount);
  if ((input.categoryId === undefined) === (input.splits === undefined)) throw LedgerErrors.categoryAndSplits();
  const parts = input.splits
    ? input.splits.map((p, i) => ({
        cat: category(r, p.categoryId, 'expense', `splits.${i}.categoryId`),
        amount: parseMinor(p.amount),
      }))
    : [{ cat: category(r, input.categoryId!, 'expense'), amount: total }];
  const sum = parts.reduce((s, p) => s + p.amount, 0n);
  if (sum !== total) throw LedgerErrors.splitTotal(total, sum, acc.currency);
  return {
    type: 'expense',
    lines: [...parts.map((p) => line(p.cat, p.amount, acc.currency)), line(acc, -total)],
  };
}

/** E4 and E6: Dr to · Cr from. E7 (two currencies): each side balances through fx-clearing. */
function buildTransfer(input: Extract<EventInput, { type: 'transfer' }>, r: Resolver): Built {
  const from = real(r, input.fromAccountId, 'fromAccountId');
  const to = real(r, input.toAccountId, 'toAccountId');
  if (from.id === to.id) throw LedgerErrors.sameAccount();
  const amount = parseMinor(input.amount);
  if (from.currency === to.currency) {
    if (input.toAmount !== undefined) throw LedgerErrors.toAmountUnexpected();
    return { type: 'transfer', lines: [line(to, amount), line(from, -amount)] };
  }
  if (input.toAmount === undefined) throw LedgerErrors.toAmountNeeded();
  const arrived = parseMinor(input.toAmount);
  const fx = r.system('fx_clearing');
  return {
    type: 'transfer',
    lines: [line(fx, amount, from.currency), line(from, -amount), line(to, arrived), line(fx, -arrived, to.currency)],
    fxRate: rateOf(amount, from.currency, arrived, to.currency),
  };
}

/** E8: an asset is Dr account · Cr Opening balances; a liability the other way round. Never income. */
function buildOpeningBalance(input: Extract<EventInput, { type: 'opening_balance' }>, r: Resolver): Built {
  const acc = real(r, input.accountId, 'accountId');
  const shown = parseMinor(input.amount);
  const debit = acc.kind === 'asset' ? shown : -shown;
  const eq = r.system('opening_balances');
  return { type: 'opening_balance', lines: [line(acc, debit), line(eq, -debit, acc.currency)] };
}

/** E9 (reconcile, to Adjustments) and E10 (value update, to Revaluation). Never income or spending. */
function buildAdjustment(input: Extract<EventInput, { type: 'balance_adjustment' }>, r: Resolver): Built {
  const acc = real(r, input.accountId, 'accountId');
  const shown = parseMinor(input.amount);
  const debit = acc.kind === 'asset' ? shown : -shown;
  const eq = r.system(input.reason === 'reconcile' ? 'adjustments' : 'revaluation');
  return { type: 'balance_adjustment', lines: [line(acc, debit), line(eq, -debit, acc.currency)] };
}

/** E11: Dr account · Cr the purchase's expense category. All refunds together can't pass the purchase. */
function buildRefund(input: Extract<EventInput, { type: 'refund' }>, r: Resolver): Built {
  const acc = real(r, input.accountId, 'accountId');
  const orig = r.original(input.refundOf);
  if (!orig || orig.type !== 'expense' || orig.status !== 'posted') throw LedgerErrors.notRefundable();
  const expenseLines = orig.lines.filter(
    (l) => l.amountMinor > 0n && r.category(l.categoryId ?? '')?.kind === 'expense',
  );
  const target = input.categoryId ? expenseLines.find((l) => l.categoryId === input.categoryId) : expenseLines[0];
  if (!target) throw LedgerErrors.refundCategory();
  const cat = r.category(target.categoryId!)!;
  if (cat.currency !== acc.currency || target.currency !== acc.currency)
    throw LedgerErrors.currencyMismatch('accountId');
  const cost = expenseLines.reduce((s, l) => s + l.amountMinor, 0n);
  const amount = parseMinor(input.amount);
  if (orig.refunded + amount > cost) throw LedgerErrors.refundTooBig(cost - orig.refunded, acc.currency);
  return { type: 'refund', lines: [line(acc, amount), line(cat, -amount, acc.currency)], refundOf: input.refundOf };
}

/** E25: the original's lines with every sign flipped. */
export function buildReversal(lines: readonly Line[]): Line[] {
  return lines.map((l) => ({ ...l, amountMinor: -l.amountMinor }));
}

const RATE_PLACES = 10;

/** X ÷ Y in major units, to 10 decimal places, rounded half away from zero (TECH-SPEC 6.5). */
export function rateOf(fromMinor: bigint, fromCurrency: string, toMinor: bigint, toCurrency: string): string {
  const scale = 10n ** BigInt(RATE_PLACES);
  const num = fromMinor * 10n ** BigInt(exponentOf(toCurrency)) * scale;
  const den = toMinor * 10n ** BigInt(exponentOf(fromCurrency));
  const q = (num * 2n + den) / (den * 2n);
  const s = q.toString().padStart(RATE_PLACES + 1, '0');
  return `${s.slice(0, -RATE_PLACES)}.${s.slice(-RATE_PLACES)}`.replace(/\.?0+$/, '');
}

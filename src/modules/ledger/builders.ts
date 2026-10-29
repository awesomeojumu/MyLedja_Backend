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

const isCash = (a: AccountRef) => isReal(a) && !a.personDebt;

function receivable(r: Resolver, id: string, field: string): AccountRef {
  const a = r.account(id);
  if (!a || a.personDebt !== 'receivable') throw LedgerErrors.wrongAccountKind(field);
  if (a.archived) throw LedgerErrors.archived(field);
  return a;
}

function loanLiability(r: Resolver, id: string, field: string): AccountRef {
  const a = r.account(id);
  if (!a || a.kind !== 'liability') throw LedgerErrors.wrongAccountKind(field);
  if (a.personDebt && a.personDebt !== 'payable') throw LedgerErrors.wrongAccountKind(field);
  if (a.archived) throw LedgerErrors.archived(field);
  return a;
}

function real(r: Resolver, id: string, field: string): AccountRef {
  const a = r.account(id);
  if (!a) throw LedgerErrors.accountMissing(field);
  if (!isCash(a)) throw LedgerErrors.wrongAccountKind(field);
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
    case 'loan_proceeds':
      return buildLoanProceeds(input, r);
    case 'loan_repayment':
      return buildLoanRepayment(input, r);
    case 'lend':
      return buildLend(input, r);
    case 'collect':
      return buildCollect(input, r);
    case 'write_off':
      return buildWriteOff(input, r);
    case 'salary_gross':
      return buildSalaryGross(input, r);
    case 'investment_buy':
      return buildInvestmentBuy(input, r);
    case 'investment_sell':
      return buildInvestmentSell(input, r);
  }
}

/** Cost = units × price + fees, rounded half away from zero to the minor unit (TECH-SPEC 6.5). */
export function costOfPurchase(units: string, pricePerUnit: string, fees: string): bigint {
  const price = parseMinor(pricePerUnit);
  const fee = parseMinor(fees || '0');
  const [whole, frac = ''] = units.split('.') as [string, string | undefined];
  const scale = 10n ** BigInt(frac.length);
  const unitMinor = BigInt(whole + frac.padEnd(frac.length, '0') || '0');
  // units * price with fractional units: (unitMinor * price) / scale, half away from zero.
  const num = unitMinor * price;
  const half = scale / 2n;
  const rounded = num >= 0n ? (num + half) / scale : -((-num + half) / scale);
  return rounded + fee;
}

/** Proceeds after fees = units × price − fees (not below zero). */
export function proceedsOfSale(units: string, pricePerUnit: string, fees: string): bigint {
  const gross = costOfPurchase(units, pricePerUnit, '0');
  const fee = parseMinor(fees || '0');
  return gross > fee ? gross - fee : 0n;
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

/** E13: Dr cash · Cr loan liability. */
function buildLoanProceeds(input: Extract<EventInput, { type: 'loan_proceeds' }>, r: Resolver): Built {
  const cash = real(r, input.accountId, 'accountId');
  const loan = loanLiability(r, input.loanAccountId, 'loanAccountId');
  const amount = parseMinor(input.amount);
  if (cash.currency !== loan.currency) throw LedgerErrors.currencyMismatch('loanAccountId');
  return { type: 'loan_proceeds', lines: [line(cash, amount), line(loan, -amount, cash.currency)] };
}

/** E14: Dr loan (principal) · Dr interest expense · Cr cash. */
function buildLoanRepayment(input: Extract<EventInput, { type: 'loan_repayment' }>, r: Resolver): Built {
  const loan = loanLiability(r, input.loanAccountId, 'loanAccountId');
  const cash = real(r, input.accountId, 'accountId');
  const principal = parseMinor(input.principal);
  const interest = parseMinor(input.interest ?? '0');
  if (cash.currency !== loan.currency) throw LedgerErrors.currencyMismatch('loanAccountId');
  const interestExpense = r.system('interest_and_charges');
  const total = principal + interest;
  return {
    type: 'loan_repayment',
    lines: [
      line(loan, principal, cash.currency),
      ...(interest > 0n ? [line(interestExpense, interest, cash.currency)] : []),
      line(cash, -total),
    ],
  };
}

/** E15: Dr receivable · Cr cash. */
function buildLend(input: Extract<EventInput, { type: 'lend' }>, r: Resolver): Built {
  const recv = receivable(r, input.receivableAccountId, 'receivableAccountId');
  const cash = real(r, input.accountId, 'accountId');
  const amount = parseMinor(input.amount);
  if (recv.currency !== cash.currency) throw LedgerErrors.currencyMismatch('receivableAccountId');
  return { type: 'lend', lines: [line(recv, amount), line(cash, -amount, cash.currency)] };
}

/** E16: Dr cash · Cr receivable (principal) · Cr interest income. */
function buildCollect(input: Extract<EventInput, { type: 'collect' }>, r: Resolver): Built {
  const recv = receivable(r, input.receivableAccountId, 'receivableAccountId');
  const cash = real(r, input.accountId, 'accountId');
  const principal = parseMinor(input.principal);
  const interest = parseMinor(input.interest ?? '0');
  if (recv.currency !== cash.currency) throw LedgerErrors.currencyMismatch('receivableAccountId');
  const interestIncome = r.system('interest_earned');
  const total = principal + interest;
  return {
    type: 'collect',
    lines: [
      line(cash, total),
      line(recv, -principal, cash.currency),
      ...(interest > 0n ? [line(interestIncome, -interest, cash.currency)] : []),
    ],
  };
}

/** E17: Dr written off · Cr receivable. */
function buildWriteOff(input: Extract<EventInput, { type: 'write_off' }>, r: Resolver): Built {
  const recv = receivable(r, input.receivableAccountId, 'receivableAccountId');
  const amount = parseMinor(input.amount);
  const loss = r.system('written_off');
  return { type: 'write_off', lines: [line(loss, amount, recv.currency), line(recv, -amount, recv.currency)] };
}

/** E20: Dr holding · Cr cash. Cost = units × price + fees. Never spending. */
function buildInvestmentBuy(input: Extract<EventInput, { type: 'investment_buy' }>, r: Resolver): Built {
  const holding = real(r, input.holdingAccountId, 'holdingAccountId');
  const cash = real(r, input.cashAccountId, 'cashAccountId');
  if (holding.currency !== cash.currency) throw LedgerErrors.currencyMismatch('holdingAccountId');
  if (holding.id === cash.id) throw LedgerErrors.sameAccount();
  const cost = costOfPurchase(input.units, input.pricePerUnit, input.fees ?? '0');
  if (cost <= 0n) throw LedgerErrors.wrongAccountKind('units');
  return { type: 'investment_buy', lines: [line(holding, cost), line(cash, -cost)] };
}

/** E21: Dr cash (proceeds) · Cr holding (cost of lots) · Cr gain or Dr loss. */
function buildInvestmentSell(input: Extract<EventInput, { type: 'investment_sell' }>, r: Resolver): Built {
  const holding = real(r, input.holdingAccountId, 'holdingAccountId');
  const cash = real(r, input.cashAccountId, 'cashAccountId');
  if (holding.currency !== cash.currency) throw LedgerErrors.currencyMismatch('holdingAccountId');
  if (holding.id === cash.id) throw LedgerErrors.sameAccount();
  const proceeds = proceedsOfSale(input.units, input.pricePerUnit, input.fees ?? '0');
  const cost = parseMinor(input.costOfLots);
  if (cost <= 0n) throw LedgerErrors.wrongAccountKind('costOfLots');
  const lines: Line[] = [line(cash, proceeds), line(holding, -cost)];
  const diff = proceeds - cost;
  if (diff > 0n) lines.push(line(r.system('investment_gain'), -diff, cash.currency));
  else if (diff < 0n) lines.push(line(r.system('investment_loss'), -diff, cash.currency));
  return { type: 'investment_sell', lines };
}

/** E24: gross salary with PAYE, pension and NHF. */
function buildSalaryGross(input: Extract<EventInput, { type: 'salary_gross' }>, r: Resolver): Built {
  const cash = real(r, input.accountId, 'accountId');
  const income = category(r, input.categoryId, 'income');
  const gross = parseMinor(input.gross);
  const takeHome = parseMinor(input.takeHome);
  const paye = parseMinor(input.paye);
  const pension = parseMinor(input.pension);
  const nhf = parseMinor(input.nhf);
  const pensionAcc = r.account(input.pensionAccountId);
  const nhfAcc = r.account(input.nhfAccountId);
  if (!pensionAcc || pensionAcc.kind !== 'asset' || pensionAcc.personDebt) {
    throw LedgerErrors.wrongAccountKind('pensionAccountId');
  }
  if (!nhfAcc || nhfAcc.kind !== 'asset' || nhfAcc.personDebt) throw LedgerErrors.wrongAccountKind('nhfAccountId');
  const taxes = r.system('taxes');
  const parts = takeHome + paye + pension + nhf;
  if (parts !== gross) throw LedgerErrors.splitTotal(gross, parts, cash.currency);
  return {
    type: 'salary_gross',
    lines: [
      line(cash, takeHome),
      line(taxes, paye, cash.currency),
      line(pensionAcc, pension, cash.currency),
      line(nhfAcc, nhf, cash.currency),
      line(income, -gross, cash.currency),
    ],
  };
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

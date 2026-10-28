import { LedgerErrors } from './ledger.errors.js';
import type { AccountRef, EventType, Line } from './ledger.types.js';

export class IntegrityError extends Error {
  constructor(
    readonly check: number,
    detail: string,
  ) {
    super(`integrity check ${check} failed: ${detail}`);
    this.name = 'IntegrityError';
  }
}

const isReal = (a: AccountRef) => (a.kind === 'asset' || a.kind === 'liability') && a.systemKey === null;
const isCash = (a: AccountRef) => isReal(a) && !a.personDebt;

/**
 * The checks of TECH-SPEC 6.11 that need only the event and its accounts (1, 2, 3, 5 and 7).
 * Refund limits (4), repeated operationIds (6) and double corrections (8) need the database and run in
 * `postEvent`. A builder should never produce lines that fail here; if one does, nothing is saved.
 */
export function checkLines(
  type: EventType,
  lines: readonly Line[],
  accountOf: (id: string) => AccountRef | null,
): void {
  if (lines.length < 2) throw new IntegrityError(1, 'an event needs at least two lines');
  const sums = new Map<string, bigint>();
  for (const l of lines) {
    if (l.amountMinor === 0n) throw new IntegrityError(1, 'a line has no amount');
    sums.set(l.currency, (sums.get(l.currency) ?? 0n) + l.amountMinor);
  }
  for (const [currency, sum] of sums) if (sum !== 0n) throw new IntegrityError(1, `${currency} lines add up to ${sum}`);

  const accounts = lines.map((l) => {
    const a = accountOf(l.ledgerAccountId);
    if (!a) throw new IntegrityError(2, `account ${l.ledgerAccountId} is not in this workspace`);
    if (a.currency !== l.currency && a.systemKey !== 'fx_clearing') {
      throw LedgerErrors.currencyMismatch('amount');
    }
    return a;
  });

  const reals = accounts.filter(isReal);
  const realIds = new Set(reals.map((a) => a.id));
  const byKind = (kind: AccountRef['kind']) =>
    lines.filter((_, i) => accounts[i]!.kind === kind && !isReal(accounts[i]!));

  switch (type) {
    case 'income': {
      const inc = byKind('income');
      if (reals.length !== 1 || inc.length !== 1 || inc[0]!.amountMinor >= 0n)
        throw new IntegrityError(3, 'income needs one account and one income credit');
      return;
    }
    case 'expense': {
      const exp = byKind('expense');
      if (reals.length !== 1 || exp.length === 0 || exp.some((l) => l.amountMinor <= 0n))
        throw new IntegrityError(3, 'an expense needs one account and expense debits');
      const credit = lines.find((_, i) => isReal(accounts[i]!))!;
      const parts = exp.reduce((s, l) => s + l.amountMinor, 0n);
      if (parts !== -credit.amountMinor) throw new IntegrityError(5, 'split parts do not add up to the total');
      return;
    }
    case 'transfer': {
      const others = accounts.filter((a) => !isReal(a));
      if (realIds.size !== 2 || reals.length !== 2) throw new IntegrityError(7, 'a transfer has exactly two accounts');
      if (others.some((a) => a.systemKey !== 'fx_clearing') || (others.length !== 0 && others.length !== 2))
        throw new IntegrityError(7, 'only the exchange clearing pair may join a transfer');
      return;
    }
    case 'opening_balance':
    case 'balance_adjustment': {
      const allowed = type === 'opening_balance' ? ['opening_balances'] : ['adjustments', 'revaluation'];
      const eq = accounts.filter((a) => a.kind === 'equity');
      if (reals.length !== 1 || lines.length !== 2 || eq.length !== 1 || !allowed.includes(eq[0]!.systemKey ?? ''))
        throw new IntegrityError(3, `${type} needs one account and its equity line`);
      return;
    }
    case 'refund': {
      const exp = byKind('expense');
      if (reals.length !== 1 || exp.length !== 1 || exp[0]!.amountMinor >= 0n)
        throw new IntegrityError(3, 'a refund needs one account and one expense credit');
      return;
    }
    case 'loan_proceeds': {
      const assets = lines.filter((_, i) => accounts[i]!.kind === 'asset' && !accounts[i]!.personDebt);
      const loans = lines.filter(
        (_, i) =>
          accounts[i]!.kind === 'liability' && (accounts[i]!.personDebt === 'payable' || !accounts[i]!.personDebt),
      );
      if (assets.length !== 1 || loans.length !== 1) throw new IntegrityError(3, 'loan proceeds needs cash and a loan');
      return;
    }
    case 'loan_repayment': {
      const banks = lines.filter((_, i) => accounts[i]!.kind === 'asset' && isCash(accounts[i]!));
      if (banks.length !== 1) throw new IntegrityError(3, 'loan repayment needs one cash account');
      return;
    }
    case 'lend': {
      const cash = lines.filter((_, i) => isCash(accounts[i]!));
      const recv = lines.filter((_, i) => accounts[i]!.personDebt === 'receivable');
      if (cash.length !== 1 || recv.length !== 1) throw new IntegrityError(3, 'lend needs cash and a receivable');
      return;
    }
    case 'collect': {
      const cash = lines.filter((_, i) => isCash(accounts[i]!));
      const recv = lines.filter((_, i) => accounts[i]!.personDebt === 'receivable');
      if (cash.length !== 1 || recv.length !== 1) throw new IntegrityError(3, 'collect needs cash and a receivable');
      return;
    }
    case 'write_off': {
      const recv = lines.filter((_, i) => accounts[i]!.personDebt === 'receivable');
      const loss = lines.filter((_, i) => accounts[i]!.systemKey === 'written_off');
      if (recv.length !== 1 || loss.length !== 1) throw new IntegrityError(3, 'write-off needs receivable and loss');
      return;
    }
    case 'salary_gross': {
      const inc = byKind('income');
      if (inc.length !== 1 || inc[0]!.amountMinor >= 0n)
        throw new IntegrityError(3, 'salary gross needs one income credit');
      return;
    }
    case 'reversal':
      return;
  }
}

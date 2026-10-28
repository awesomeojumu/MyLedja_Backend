import { toMinorString } from '../../common/money/money.js';
import type { EventInput } from './ledger.inputs.js';
import type { TransactionDoc } from './ledger.repository.js';
import type { AccountRef } from './ledger.types.js';

const isReal = (a: AccountRef | null | undefined) =>
  !!a && (a.kind === 'asset' || a.kind === 'liability') && a.systemKey === null;

/**
 * The input that would build this event again, so a correction can change one field (a category, an
 * account) and keep the rest. Returns null for types that can't be rebuilt this way (reversals).
 */
export function inputOf(e: TransactionDoc, accountOf: (id: string) => AccountRef | null): EventInput | null {
  const common = {
    date: e.date,
    payeeId: e.payeeId,
    notes: e.notes,
    tagIds: e.tagIds,
  };
  const real = e.lines.filter((l) => isReal(accountOf(l.ledgerAccountId)));
  const cats = e.lines.filter((l) => !isReal(accountOf(l.ledgerAccountId)) && l.categoryId);
  switch (e.type) {
    case 'income':
      return {
        type: 'income',
        accountId: real[0]!.ledgerAccountId,
        categoryId: cats[0]!.categoryId!,
        amount: toMinorString(real[0]!.amountMinor),
        ...common,
      };
    case 'expense': {
      const total = -real[0]!.amountMinor;
      return cats.length === 1
        ? {
            type: 'expense',
            accountId: real[0]!.ledgerAccountId,
            categoryId: cats[0]!.categoryId!,
            amount: toMinorString(total),
            ...common,
          }
        : {
            type: 'expense',
            accountId: real[0]!.ledgerAccountId,
            amount: toMinorString(total),
            splits: cats.map((l) => ({ categoryId: l.categoryId!, amount: toMinorString(l.amountMinor) })),
            ...common,
          };
    }
    case 'refund':
      return {
        type: 'refund',
        refundOf: e.links.refundOf!,
        accountId: real[0]!.ledgerAccountId,
        categoryId: cats[0]!.categoryId!,
        amount: toMinorString(real[0]!.amountMinor),
        ...common,
      };
    case 'transfer': {
      const from = real.find((l) => l.amountMinor < 0n)!;
      const to = real.find((l) => l.amountMinor > 0n)!;
      return {
        type: 'transfer',
        fromAccountId: from.ledgerAccountId,
        toAccountId: to.ledgerAccountId,
        amount: toMinorString(-from.amountMinor),
        ...(from.currency !== to.currency ? { toAmount: toMinorString(to.amountMinor) } : {}),
        ...common,
      };
    }
    case 'opening_balance':
    case 'balance_adjustment': {
      const a = accountOf(real[0]!.ledgerAccountId)!;
      const shown = a.kind === 'liability' ? -real[0]!.amountMinor : real[0]!.amountMinor;
      if (e.type === 'opening_balance')
        return { type: 'opening_balance', accountId: a.id, amount: toMinorString(shown), ...common };
      const eq = e.lines.find((l) => accountOf(l.ledgerAccountId)?.kind === 'equity');
      const reason = accountOf(eq!.ledgerAccountId)?.systemKey === 'revaluation' ? 'revaluation' : 'reconcile';
      return { type: 'balance_adjustment', reason, accountId: a.id, amount: toMinorString(shown), ...common };
    }
    case 'reversal':
      return null;
    case 'loan_proceeds':
    case 'loan_repayment':
    case 'lend':
    case 'collect':
    case 'write_off':
    case 'salary_gross':
      return null;
  }
}

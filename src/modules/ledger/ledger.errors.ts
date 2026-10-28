import { AppError } from '../../common/errors/errors.js';
import { formatAmount } from '../../common/money/money.js';

const SYMBOLS: Record<string, string> = { NGN: '₦', USD: '$', GBP: '£', EUR: '€' };

export const money = (amount: bigint, currency: string) => formatAmount(amount, currency, SYMBOLS[currency] ?? '');

/** Every refusal the ledger can give (TECH-SPEC 6.11). Messages follow DESIGN.md 2.12. */
export const LedgerErrors = {
  accountMissing: (field = 'accountId') =>
    new AppError(400, 'account_not_found', "We couldn't find this account. It may have been removed.", { field }),
  categoryMissing: (field = 'categoryId') =>
    new AppError(400, 'category_not_found', "We couldn't find this category. It may have been removed.", { field }),
  wrongAccountKind: (field: string) =>
    new AppError(400, 'wrong_account', 'Choose one of your accounts here.', { field }),
  wrongCategoryKind: (field: string, want: 'income' | 'expense') =>
    new AppError(
      400,
      'wrong_category',
      want === 'income' ? 'Choose an income category.' : 'Choose a spending category.',
      { field },
    ),
  archived: (field: string) =>
    new AppError(400, 'account_archived', 'This account is archived. Restore it to add transactions.', { field }),
  currencyMismatch: (field: string) =>
    new AppError(400, 'currency_mismatch', "This amount's currency doesn't match the account.", { field }),
  categoryAndSplits: () =>
    new AppError(400, 'invalid_input', 'Choose a category, or split it into parts.', { field: 'categoryId' }),
  splitTotal: (total: bigint, parts: bigint, currency: string) =>
    new AppError(
      400,
      'split_total',
      `The parts add up to ${money(parts, currency)}, not ${money(total, currency)}. Change a part so they match.`,
      { field: 'splits' },
    ),
  sameAccount: () => new AppError(400, 'same_account', 'Choose two different accounts.', { field: 'toAccountId' }),
  toAmountNeeded: () =>
    new AppError(400, 'to_amount_needed', 'Enter how much arrived in the other currency.', { field: 'toAmount' }),
  toAmountUnexpected: () =>
    new AppError(400, 'invalid_input', 'Both accounts use the same currency, so leave out the amount that arrived.', {
      field: 'toAmount',
    }),
  notRefundable: () => new AppError(400, 'not_refundable', 'Only a purchase can be refunded.', { field: 'refundOf' }),
  refundCategory: () =>
    new AppError(400, 'refund_category', "Choose one of the purchase's categories.", { field: 'categoryId' }),
  refundTooBig: (cost: bigint, currency: string) =>
    new AppError(400, 'refund_too_big', `This refund is more than the purchase (${money(cost, currency)}).`, {
      field: 'amount',
    }),
  unbalanced: () =>
    new AppError(500, 'ledger_unbalanced', "We couldn't save this. Check your connection and try again."),
  alreadyChanged: (current?: unknown) =>
    new AppError(409, 'already_changed', 'This transaction was already changed on another device.', {
      ...(current === undefined ? {} : { current }),
    }),
  notCorrectable: () => new AppError(409, 'not_correctable', "This can't be changed. It undoes another transaction."),
  notFoundEvent: () => new AppError(404, 'not_found', "We couldn't find this transaction. It may have been removed."),
  hasRefunds: () =>
    new AppError(409, 'has_refunds', 'This purchase has refunds. Delete them first, then change the purchase.'),
  locked: () => new AppError(409, 'reconciled', 'This transaction is reconciled. Unlock it first to change it.'),
};

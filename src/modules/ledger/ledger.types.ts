/** The six kinds of ledger account (TECH-SPEC 6.1). */
export const LEDGER_KINDS = ['asset', 'liability', 'income', 'expense', 'equity', 'loss'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Each workspace's system accounts (build plan B1.1). Seeded once per workspace; never shown as a category. */
export const SYSTEM_ACCOUNTS = {
  opening_balances: { kind: 'equity', name: 'Opening balances' },
  adjustments: { kind: 'equity', name: 'Adjustments' },
  revaluation: { kind: 'equity', name: 'Revaluation' },
  fx_clearing: { kind: 'equity', name: 'Exchange clearing' },
  interest_earned: { kind: 'income', name: 'Interest earned' },
  investment_income: { kind: 'income', name: 'Investment income' },
  investment_gain: { kind: 'income', name: 'Investment gain' },
  interest_and_charges: { kind: 'expense', name: 'Interest and charges' },
  fees: { kind: 'expense', name: 'Fees' },
  taxes: { kind: 'expense', name: 'Taxes' },
  written_off: { kind: 'loss', name: 'Written off' },
  investment_loss: { kind: 'loss', name: 'Investment loss' },
} as const satisfies Record<string, { kind: LedgerKind; name: string }>;
export type SystemKey = keyof typeof SYSTEM_ACCOUNTS;
export const SYSTEM_KEYS = Object.keys(SYSTEM_ACCOUNTS) as SystemKey[];

/** Phase 1 event types (E1 to E12 and E25). Phase 2 adds E13–E17 and E24; Phase 5 adds E20 and E21. */
export const EVENT_TYPES = [
  'income',
  'expense',
  'transfer',
  'opening_balance',
  'balance_adjustment',
  'refund',
  'loan_proceeds',
  'loan_repayment',
  'lend',
  'collect',
  'write_off',
  'salary_gross',
  'investment_buy',
  'investment_sell',
  'reversal',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Line = {
  ledgerAccountId: string;
  /** Positive for a debit, negative for a credit (TECH-SPEC 6.1). */
  amountMinor: bigint;
  currency: string;
  categoryId?: string | null;
};

/** What a builder needs to know about an account. */
export type AccountRef = {
  id: string;
  kind: LedgerKind;
  currency: string;
  systemKey: SystemKey | null;
  categoryId: string | null;
  archived: boolean;
  /** Person-debt ledger (R receivable, P payable). Not a bank, card or product loan account. */
  personDebt?: 'receivable' | 'payable' | null;
  /** A holding (TECH-SPEC 6.1: each holding is an asset at cost). Never a cash account. */
  holding?: boolean;
};

export type EventLinks = {
  transferOf?: string | null;
  refundOf?: string | null;
  reversalOf?: string | null;
  reversedBy?: string | null;
  correctionOf?: string | null;
  /** E19: expense taken from a goal earmark (TECH-SPEC 6.2 / 6.6). */
  goalId?: string | null;
  debtId?: string | null;
  scheduleId?: string | null;
  holdingId?: string | null;
};

export type EventStatus = 'posted' | 'reversed';

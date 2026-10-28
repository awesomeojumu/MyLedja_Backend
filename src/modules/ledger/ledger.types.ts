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

/** Phase 1 event types (E1 to E12 and E25). Later phases add loan, debt and investment types. */
export const EVENT_TYPES = [
  'income',
  'expense',
  'transfer',
  'opening_balance',
  'balance_adjustment',
  'refund',
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
};

export type EventLinks = {
  transferOf?: string | null;
  refundOf?: string | null;
  reversalOf?: string | null;
  reversedBy?: string | null;
  correctionOf?: string | null;
};

export type EventStatus = 'posted' | 'reversed';

import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, LocalDate, MinorAmount, PageQuery, Uuid } from '../../common/http/schemas.js';
import { Transaction } from '../transactions/transactions.contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const DEBT_DIRECTIONS = ['they_owe_me', 'i_owe_them'] as const;

export const InterestTerms = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('fixed'), amount: MinorAmount.meta({ description: 'Per period, in minor units.' }) }),
  z.object({
    kind: z.literal('percent'),
    rateBasisPoints: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .meta({ description: 'Percent per month × 100, e.g. 200 = 2%.' }),
  }),
]);

export const InstalmentSchedule = z
  .object({
    count: z.number().int().min(1).max(600),
    amount: MinorAmount.meta({
      description: 'Each instalment except the last, which absorbs rounding (TECH-SPEC 6.5).',
    }),
    firstDate: LocalDate,
    everyMonths: z.number().int().min(1).max(12).default(1),
  })
  .meta({ id: 'DebtInstalmentSchedule' });

export const Debt = z
  .object({
    id: z.string(),
    direction: z.enum(DEBT_DIRECTIONS),
    personName: z.string(),
    payeeId: z.string().meta({ description: 'Linked payee with bank aliases (TECH-SPEC 6.15).' }),
    ledgerAccountId: z.string().meta({ description: 'R (they owe me) or P (I owe them) account.' }),
    principal: MinorAmount.meta({ description: 'Original amount lent or borrowed.' }),
    outstanding: MinorAmount.meta({ description: 'Still owed; zero when settled.' }),
    interest: InterestTerms,
    dueDate: LocalDate.nullable(),
    instalments: InstalmentSchedule.nullable(),
    accountId: z.string().meta({ description: 'Cash account used at lend/borrow.' }),
    openedOn: LocalDate,
    status: z.enum(['open', 'settled', 'written_off']),
    notes: z.string().nullable(),
    nextInstalmentDate: LocalDate.nullable(),
    nextInstalmentAmount: MinorAmount.nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Debt' });

export const DebtPaymentSplit = z
  .object({
    principal: MinorAmount,
    interest: MinorAmount.meta({ description: 'Posts to Interest earned or Interest and charges (TECH-SPEC 6.9).' }),
  })
  .meta({ id: 'DebtPaymentSplit' });

export const DebtSummary = z
  .object({
    owedToYou: MinorAmount,
    youOwe: MinorAmount,
    net: MinorAmount,
  })
  .meta({ id: 'DebtSummary' });

export const MoneyBackSuggestion = z
  .object({
    id: z.string(),
    debtId: z.string(),
    direction: z.enum(['incoming', 'outgoing']),
    transactionId: Uuid.nullable().meta({ description: 'Set when reviewing an existing or imported transaction.' }),
    draft: z
      .object({
        date: LocalDate,
        amount: MinorAmount,
        accountId: Uuid,
        payeeId: Uuid.nullable(),
      })
      .nullable()
      .meta({ description: 'Set when suggesting before a transaction is saved.' }),
    personName: z.string(),
    outstanding: MinorAmount,
    suggestedSplit: DebtPaymentSplit.nullable(),
    reason: z.enum(['payee_match', 'instalment_amount', 'both']),
  })
  .meta({ id: 'MoneyBackSuggestion' });

export const DebtParams = WorkspaceParams.extend({ debtId: Uuid });
export const SuggestionParams = WorkspaceParams.extend({ suggestionId: Uuid });

const tag = 'Debts';
const base = '/v1/workspaces/:workspaceId/debts';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

const lendBorrowBody = z.object({
  id: Uuid.optional(),
  personName: z.string().trim().min(1).max(80),
  payeeId: Uuid.optional().meta({ description: 'Created or matched from personName when omitted.' }),
  amount: MinorAmount,
  accountId: Uuid,
  date: LocalDate,
  interest: InterestTerms.default({ kind: 'none' }),
  dueDate: LocalDate.nullable().optional(),
  instalments: InstalmentSchedule.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const debtRoutes = {
  list: defineRoute({
    name: 'listDebts',
    method: 'GET',
    path: base,
    tag,
    summary: 'People debts with summary totals',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({
      filter: z.enum(['all', 'they_owe_me', 'i_owe_them', 'settled']).default('all'),
      ...PageQuery,
    }),
    status: 200,
    response: z
      .object({ summary: DebtSummary, items: z.array(Debt), nextCursor: z.string().nullable() })
      .meta({ id: 'DebtPage' }),
    errors: [400, 401, 404],
  }),
  get: defineRoute({
    name: 'getDebt',
    method: 'GET',
    path: `${base}/:debtId`,
    tag,
    summary: 'One debt with payment history',
    access: viewer,
    params: DebtParams,
    status: 200,
    response: z
      .object({
        debt: Debt,
        payments: z.array(
          z.object({
            transactionId: z.string(),
            date: LocalDate,
            amount: MinorAmount,
            split: DebtPaymentSplit,
          }),
        ),
      })
      .meta({ id: 'DebtDetail' }),
    errors: [400, 401, 404],
  }),
  lend: defineRoute({
    name: 'lendMoney',
    method: 'POST',
    path: `${base}/lend`,
    tag,
    summary: 'Record money you lent (E15)',
    description: 'Lent money is not spending (case 9).',
    access: editor,
    params: WorkspaceParams,
    body: lendBorrowBody.meta({ id: 'LendBody' }),
    status: 201,
    response: Debt,
    errors: [400, 401, 403, 404, 409],
  }),
  borrow: defineRoute({
    name: 'borrowMoney',
    method: 'POST',
    path: `${base}/borrow`,
    tag,
    summary: 'Record money you borrowed (E13)',
    description: 'Borrowed money is not income (case 7).',
    access: editor,
    params: WorkspaceParams,
    body: lendBorrowBody.meta({ id: 'BorrowBody' }),
    status: 201,
    response: Debt,
    errors: [400, 401, 403, 404, 409],
  }),
  update: defineRoute({
    name: 'updateDebt',
    method: 'PATCH',
    path: `${base}/:debtId`,
    tag,
    summary: 'Edit notes, interest or due date on an open debt',
    access: editor,
    params: DebtParams,
    body: z
      .object({
        baseVersion: BaseVersion,
        notes: z.string().max(2000).nullable().optional(),
        interest: InterestTerms.optional(),
        dueDate: LocalDate.nullable().optional(),
        instalments: InstalmentSchedule.nullable().optional(),
      })
      .meta({ id: 'UpdateDebtBody' }),
    status: 200,
    response: Debt,
    errors: [400, 401, 403, 404, 409],
  }),
  recordPayment: defineRoute({
    name: 'recordDebtPayment',
    method: 'POST',
    path: `${base}/:debtId/payments`,
    tag,
    summary: 'Record money back or a repayment (E16 or E14)',
    description: 'Split editable before save; interest is income or spending only (cases 8 and 10).',
    access: editor,
    params: DebtParams,
    body: z
      .object({
        date: LocalDate,
        accountId: Uuid,
        amount: MinorAmount,
        split: DebtPaymentSplit.optional().meta({ description: 'Default from interest due when omitted.' }),
        overpayment: z.enum(['gift', 'credit']).optional().meta({
          description: 'TECH-SPEC 6.9: when principal exceeds outstanding, gift (income/expense) or keep as credit.',
        }),
      })
      .meta({ id: 'RecordDebtPaymentBody' }),
    status: 201,
    response: z.object({ debt: Debt, transaction: Transaction }).meta({ id: 'RecordDebtPaymentResult' }),
    errors: [400, 401, 403, 404, 409],
  }),
  setSchedule: defineRoute({
    name: 'setDebtInstalmentSchedule',
    method: 'PUT',
    path: `${base}/:debtId/schedule`,
    tag,
    summary: 'Instalment plan for a debt',
    access: editor,
    params: DebtParams,
    body: z.object({ baseVersion: BaseVersion, instalments: InstalmentSchedule }).meta({ id: 'SetDebtScheduleBody' }),
    status: 200,
    response: Debt,
    errors: [400, 401, 403, 404, 409],
  }),
  writeOff: defineRoute({
    name: 'writeOffDebt',
    method: 'POST',
    path: `${base}/:debtId/write-off`,
    tag,
    summary: 'Write off what they owe you (E17)',
    access: editor,
    params: DebtParams,
    body: z
      .object({
        baseVersion: BaseVersion,
        date: LocalDate,
        reason: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .meta({ description: 'Why the debt is written off (TECH-SPEC 6.9 / E17).' }),
      })
      .meta({ id: 'WriteOffDebtBody' }),
    status: 200,
    response: z.object({ debt: Debt, transaction: Transaction }).meta({ id: 'WriteOffDebtResult' }),
    errors: [400, 401, 403, 404, 409],
  }),
  settle: defineRoute({
    name: 'settleDebt',
    method: 'POST',
    path: `${base}/:debtId/settle`,
    tag,
    summary: 'Mark a zero-balance debt settled',
    access: editor,
    params: DebtParams,
    body: z.object({ baseVersion: BaseVersion }),
    status: 200,
    response: Debt,
    errors: [400, 401, 403, 404, 409],
  }),
  moneyBackSuggestions: defineRoute({
    name: 'listMoneyBackSuggestions',
    method: 'GET',
    path: `${base}/money-back-suggestions`,
    tag,
    summary: 'Suggest money back for payee or instalment matches (TECH-SPEC 6.15)',
    description: 'Never posts without confirmMoneyBack or an explicit income choice.',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({
      transactionId: Uuid.optional(),
      importRowId: Uuid.optional(),
      accountId: Uuid.optional(),
      payeeId: Uuid.optional(),
      amount: MinorAmount.optional(),
      date: LocalDate.optional(),
    }),
    status: 200,
    response: z.object({ suggestions: z.array(MoneyBackSuggestion) }).meta({ id: 'MoneyBackSuggestions' }),
    errors: [400, 401, 404],
  }),
  confirmMoneyBack: defineRoute({
    name: 'confirmMoneyBack',
    method: 'POST',
    path: `${base}/money-back-suggestions/:suggestionId/confirm`,
    tag,
    summary: 'Record as money back (E16) or treat as income (E1)',
    access: editor,
    params: SuggestionParams,
    body: z
      .object({
        choice: z.enum(['money_back', 'income']),
        split: DebtPaymentSplit.optional(),
        categoryId: Uuid.optional().meta({ description: 'Required when choice is income for an expense category.' }),
      })
      .meta({ id: 'ConfirmMoneyBackBody' }),
    status: 200,
    response: z.object({ debt: Debt.nullable(), transaction: Transaction }).meta({ id: 'ConfirmMoneyBackResult' }),
    errors: [400, 401, 403, 404, 409],
  }),
};

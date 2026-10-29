import { z } from 'zod';
import { LocalDate, Uuid } from '../../common/http/schemas.js';

const AMOUNT_ERROR = 'Enter an amount in naira, for example 25000';

/** A positive amount of whole minor units, as a string. */
export const PositiveMinor = z
  .string({ error: AMOUNT_ERROR })
  .regex(/^[1-9]\d{0,17}$/, { error: 'Enter an amount above ₦0.00' })
  .meta({ description: 'Whole minor units (kobo) above zero, as a string: "1845000" is ₦18,450.00.' });

/** A signed amount of whole minor units that isn't zero. */
export const SignedMinor = z
  .string({ error: AMOUNT_ERROR })
  .regex(/^-?[1-9]\d{0,17}$/, { error: 'Enter an amount other than ₦0.00' })
  .meta({ description: 'Whole minor units as a string; negative lowers the balance.' });

const common = {
  date: LocalDate,
  payeeId: Uuid.nullable().optional(),
  notes: z.string().trim().max(500, { error: 'Use 500 characters or fewer' }).nullable().optional(),
  tagIds: z.array(Uuid).max(20).optional(),
};

export const IncomeInput = z
  .object({ type: z.literal('income'), accountId: Uuid, categoryId: Uuid, amount: PositiveMinor, ...common })
  .meta({ id: 'IncomeInput', description: 'E1: money in, counted as income in its category.' });

export const SplitPart = z.object({ categoryId: Uuid, amount: PositiveMinor });

export const ExpenseInput = z
  .object({
    type: z.literal('expense'),
    accountId: Uuid.meta({ description: 'A bank, cash or wallet account (E2), or a card (E3, E5).' }),
    amount: PositiveMinor.meta({ description: 'The total. With splits, the parts must add up to it exactly.' }),
    categoryId: Uuid.optional().meta({ description: 'One category. Leave out when sending splits.' }),
    splits: z
      .array(SplitPart)
      .min(2, { error: 'Split into at least two parts' })
      .max(20)
      .optional()
      .meta({ description: 'E12: two or more parts, each with its category.' }),
    goalId: Uuid.optional().meta({
      description: 'E19: spending from a goal earmark. Budget activity ignores this expense (TECH-SPEC 6.6).',
    }),
    ...common,
  })
  .meta({ id: 'ExpenseInput', description: 'E2, E3, E5 and E12: spending, counted in the month it happens.' });

export const TransferInput = z
  .object({
    type: z.literal('transfer'),
    fromAccountId: Uuid,
    toAccountId: Uuid,
    amount: PositiveMinor.meta({ description: 'What left the first account, in its currency.' }),
    toAmount: PositiveMinor.optional().meta({
      description: "E7 only: what arrived, in the second account's currency. Required when the currencies differ.",
    }),
    ...common,
  })
  .meta({
    id: 'TransferInput',
    description: 'E4, E6 and E7: money between your own accounts, including paying a card. Never income or spending.',
  });

export const OpeningBalanceInput = z
  .object({
    type: z.literal('opening_balance'),
    accountId: Uuid,
    amount: z
      .string({ error: AMOUNT_ERROR })
      .regex(/^-?(0|[1-9]\d{0,17})$/, { error: AMOUNT_ERROR })
      .meta({ description: 'What you have, or for a card or loan what you owe, as a positive figure.' }),
    ...common,
  })
  .meta({ id: 'OpeningBalanceInput', description: 'E8: where an account started. Never income.' });

export const BalanceAdjustmentInput = z
  .object({
    type: z.literal('balance_adjustment'),
    accountId: Uuid,
    amount: SignedMinor.meta({
      description: 'The change to the balance as shown: positive raises what you have or what you owe.',
    }),
    reason: z.enum(['reconcile', 'revaluation']).meta({
      description: '"reconcile" (E9, to equity:Adjustments) or "revaluation" (E10, to equity:Revaluation).',
    }),
    ...common,
  })
  .meta({ id: 'BalanceAdjustmentInput', description: 'E9 and E10. Never income or spending.' });

export const RefundInput = z
  .object({
    type: z.literal('refund'),
    refundOf: Uuid.meta({ description: 'The purchase being refunded.' }),
    accountId: Uuid.meta({ description: 'Where the money came back to.' }),
    amount: PositiveMinor,
    categoryId: Uuid.optional().meta({
      description: "Which of a split purchase's categories it comes back to. Defaults to the purchase's first one.",
    }),
    ...common,
  })
  .meta({
    id: 'RefundInput',
    description: "E11: a seller giving money back. Lowers the purchase category's spending in the refund's month.",
  });

export const LoanProceedsInput = z
  .object({
    type: z.literal('loan_proceeds'),
    accountId: Uuid.meta({ description: 'Cash account that received the loan.' }),
    loanAccountId: Uuid.meta({ description: 'Bank or person loan liability account.' }),
    amount: PositiveMinor,
    ...common,
  })
  .meta({ id: 'LoanProceedsInput', description: 'E13: borrowed money is not income (case 7).' });

export const LoanRepaymentInput = z
  .object({
    type: z.literal('loan_repayment'),
    loanAccountId: Uuid,
    accountId: Uuid,
    principal: PositiveMinor,
    interest: z
      .string({ error: AMOUNT_ERROR })
      .regex(/^(0|[1-9]\d{0,17})$/, { error: AMOUNT_ERROR })
      .default('0')
      .meta({ description: 'Interest portion; counts as spending (case 8).' }),
    ...common,
  })
  .meta({ id: 'LoanRepaymentInput', description: 'E14: principal reduces the loan; interest is spending.' });

export const LendInput = z
  .object({
    type: z.literal('lend'),
    receivableAccountId: Uuid.meta({ description: '"They owe me" asset account.' }),
    accountId: Uuid.meta({ description: 'Cash that left your pocket.' }),
    amount: PositiveMinor,
    ...common,
  })
  .meta({ id: 'LendInput', description: 'E15: lending is not spending (case 9).' });

export const CollectInput = z
  .object({
    type: z.literal('collect'),
    receivableAccountId: Uuid,
    accountId: Uuid,
    principal: PositiveMinor,
    interest: z
      .string({ error: AMOUNT_ERROR })
      .regex(/^(0|[1-9]\d{0,17})$/, { error: AMOUNT_ERROR })
      .default('0')
      .meta({ description: 'Interest counts as income (case 10).' }),
    ...common,
  })
  .meta({ id: 'CollectInput', description: 'E16: money back from a person; principal is not income.' });

export const WriteOffInput = z
  .object({
    type: z.literal('write_off'),
    receivableAccountId: Uuid,
    amount: PositiveMinor,
    ...common,
  })
  .meta({ id: 'WriteOffInput', description: 'E17: written off receivable (case 11).' });

export const SalaryGrossInput = z
  .object({
    type: z.literal('salary_gross'),
    accountId: Uuid.meta({ description: 'Take-home to this account.' }),
    categoryId: Uuid.meta({ description: 'Salary income category (gross credit).' }),
    gross: PositiveMinor,
    takeHome: PositiveMinor,
    paye: PositiveMinor.meta({ description: 'PAYE to Taxes expense.' }),
    pensionAccountId: Uuid,
    pension: PositiveMinor,
    nhfAccountId: Uuid,
    nhf: PositiveMinor,
    ...common,
  })
  .meta({ id: 'SalaryGrossInput', description: 'E24: gross salary with statutory deductions (case 18).' });

const UNITS_ERROR = 'Enter the number of units, for example 500 or 12.5';

/** Units held, up to 6 decimal places, as a string. */
export const Units = z
  .string({ error: UNITS_ERROR })
  .regex(/^(0|[1-9]\d{0,14})(?:\.\d{1,6})?$/, { error: UNITS_ERROR })
  .refine((v) => /[1-9]/.test(v), { error: 'Enter more than 0 units' })
  .meta({ description: 'Units as a decimal string with up to 6 places: "500", "12.5".' });

const Fees = z
  .string({ error: AMOUNT_ERROR })
  .regex(/^(0|[1-9]\d{0,17})$/, { error: AMOUNT_ERROR })
  .default('0')
  .meta({ description: 'Broker and other fees in minor units. Part of the cost of a buy; taken from a sale.' });

export const InvestmentBuyInput = z
  .object({
    type: z.literal('investment_buy'),
    holdingId: Uuid,
    accountId: Uuid.meta({ description: 'Where the money came from.' }),
    units: Units,
    price: PositiveMinor.meta({ description: 'Price per unit in minor units.' }),
    fees: Fees,
    ...common,
  })
  .meta({
    id: 'InvestmentBuyInput',
    description: 'E20: Dr holding (units × price + fees) · Cr cash. Not spending (case 15).',
  });

export const InvestmentSellInput = z
  .object({
    type: z.literal('investment_sell'),
    holdingId: Uuid,
    accountId: Uuid.meta({ description: 'Where the proceeds went.' }),
    units: Units,
    price: PositiveMinor.meta({ description: 'Price per unit in minor units.' }),
    fees: Fees,
    lots: z
      .array(z.object({ lotId: Uuid, units: Units }))
      .min(1)
      .max(200)
      .optional()
      .meta({ description: 'Chosen lots. Leave out to sell the oldest first (TECH-SPEC 6.8).' }),
    ...common,
  })
  .meta({
    id: 'InvestmentSellInput',
    description:
      'E21: Dr cash (proceeds after fees) · Cr holding (cost of lots sold) · gain to income or loss (case 17).',
  });

export const DividendInput = z
  .object({
    type: z.literal('dividend'),
    holdingId: Uuid,
    amount: PositiveMinor,
    accountId: Uuid.nullable().optional().meta({ description: 'Paid into this account. Leave out when reinvested.' }),
    reinvestedUnits: Units.optional().meta({ description: 'Reinvested: the units bought with it (a new lot).' }),
    ...common,
  })
  .meta({
    id: 'DividendInput',
    description: 'E22: Dr cash, or Dr holding when reinvested · Cr income:Investment income. Posted as type income.',
  });

export const EventInput = z
  .discriminatedUnion('type', [
    IncomeInput,
    ExpenseInput,
    TransferInput,
    OpeningBalanceInput,
    BalanceAdjustmentInput,
    RefundInput,
    LoanProceedsInput,
    LoanRepaymentInput,
    LendInput,
    CollectInput,
    WriteOffInput,
    SalaryGrossInput,
    InvestmentBuyInput,
    InvestmentSellInput,
    DividendInput,
  ])
  .meta({ id: 'EventInput' });

export type EventInput = z.output<typeof EventInput>;

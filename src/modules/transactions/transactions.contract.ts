import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, LocalDate, MinorAmount, PageQuery, Uuid } from '../../common/http/schemas.js';
import { EventInput } from '../ledger/ledger.inputs.js';
import { EVENT_TYPES } from '../ledger/ledger.types.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const TransactionLine = z
  .object({
    ledgerAccountId: z.string(),
    accountId: z.string().nullable().meta({ description: 'Set when the line is on one of your accounts.' }),
    categoryId: z.string().nullable().meta({ description: 'Set when the line is on a category.' }),
    amount: MinorAmount.meta({ description: 'Positive is a debit, negative a credit (TECH-SPEC 6.1).' }),
    currency: z.string(),
  })
  .meta({ id: 'TransactionLine' });

export const Transaction = z
  .object({
    id: z.string(),
    type: z.enum(EVENT_TYPES),
    status: z.enum(['posted', 'reversed']),
    date: z.string(),
    amount: MinorAmount.meta({
      description: 'The headline amount: money out is negative, money in positive, a transfer its size.',
    }),
    accountIds: z.array(z.string()).meta({ description: 'Your accounts it touches; a transfer lists from, then to.' }),
    categoryIds: z.array(z.string()),
    payeeId: z.string().nullable(),
    notes: z.string().nullable(),
    tagIds: z.array(z.string()),
    receiptFileIds: z.array(z.string()),
    lines: z.array(TransactionLine),
    links: z.object({
      refundOf: z.string().nullable(),
      reversalOf: z.string().nullable(),
      reversedBy: z.string().nullable(),
      correctionOf: z.string().nullable(),
    }),
    fxRate: z.string().nullable(),
    edited: z.boolean().meta({ description: 'True when this replaced an earlier version ("Edited").' }),
    reconciled: z.boolean().meta({ description: 'Locked by a finished reconcile (🔒).' }),
    clearedAccountIds: z.array(z.string()),
    importId: z.string().nullable(),
    runningBalance: MinorAmount.nullable().meta({ description: 'Only when the list is filtered to one account.' }),
    recordedAt: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'Transaction' });

export const TransactionPage = z
  .object({ items: z.array(Transaction), nextCursor: z.string().nullable() })
  .meta({ id: 'TransactionPage' });

export const TransactionDetail = z
  .object({
    transaction: Transaction,
    history: z.array(Transaction).meta({ description: 'Earlier versions and their reversals, oldest first.' }),
    refunds: z.array(Transaction),
    refundable: MinorAmount.meta({ description: 'What can still be refunded (purchases only).' }),
  })
  .meta({ id: 'TransactionDetail' });

const csv = (inner: z.ZodType) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(inner).max(50));

export const TransactionQuery = z.object({
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  accountId: csv(Uuid).optional(),
  categoryId: csv(Uuid).optional(),
  payeeId: csv(Uuid).optional(),
  tagId: csv(Uuid).optional(),
  type: csv(z.enum(EVENT_TYPES)).optional(),
  status: z
    .enum(['live', 'all'])
    .default('live')
    .meta({ description: '"live" hides reversals and replaced versions.' }),
  minAmount: MinorAmount.optional().meta({ description: 'On the size of the headline amount.' }),
  maxAmount: MinorAmount.optional(),
  q: z.string().trim().max(100).optional().meta({ description: 'Payee, note, category name or amount.' }),
  uncategorized: z.enum(['true', 'false']).optional(),
  ...PageQuery,
});

export const TransactionParams = WorkspaceParams.extend({ transactionId: Uuid });

export const CreateTransactionBody = EventInput;

export const CorrectBody = z.object({ baseVersion: BaseVersion, input: EventInput });
export const Corrected = z.object({ transaction: Transaction, reversal: Transaction }).meta({ id: 'Corrected' });

export const ReverseBody = z.object({ baseVersion: BaseVersion });

export const UpdateTransactionBody = z.object({
  baseVersion: BaseVersion,
  notes: z.string().trim().max(500).nullable().optional(),
  tagIds: z.array(Uuid).max(20).optional(),
  payeeId: Uuid.nullable().optional(),
  receiptFileIds: z.array(z.string().max(100)).max(10).optional(),
});

export const BulkBody = z.object({
  transactionIds: z.array(Uuid).min(1).max(200),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('categorize'), categoryId: Uuid }),
    z.object({ kind: z.literal('add_tag'), tagId: Uuid }),
    z.object({ kind: z.literal('remove_tag'), tagId: Uuid }),
    z.object({ kind: z.literal('set_payee'), payeeId: Uuid.nullable() }),
    z.object({ kind: z.literal('delete') }),
  ]),
});

export const BulkResult = z
  .object({
    results: z.array(
      z.object({
        transactionId: z.string(),
        status: z.enum(['changed', 'unchanged', 'refused']),
        transaction: Transaction.nullable(),
        error: z.object({ code: z.string(), message: z.string() }).nullable(),
      }),
    ),
  })
  .meta({ id: 'BulkResult' });

export const TransferSuggestion = z
  .object({ out: Transaction, in: Transaction, amount: MinorAmount, daysApart: z.number().int() })
  .meta({ id: 'TransferSuggestion' });

export const LinkTransferBody = z.object({ outId: Uuid, inId: Uuid });

const tag = 'Transactions';
const base = '/v1/workspaces/:workspaceId/transactions';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const transactionRoutes = {
  list: defineRoute({
    name: 'listTransactions',
    method: 'GET',
    path: base,
    tag,
    summary: 'Transactions, newest first, with filters and a cursor',
    description: 'Ordered by date then id, newest first, so pages stay stable while new ones arrive.',
    access: viewer,
    params: WorkspaceParams,
    query: TransactionQuery,
    status: 200,
    response: TransactionPage,
    errors: [400, 401, 404],
  }),
  get: defineRoute({
    name: 'getTransaction',
    method: 'GET',
    path: `${base}/:transactionId`,
    tag,
    summary: 'One transaction with its history and refunds',
    access: viewer,
    params: TransactionParams,
    status: 200,
    response: TransactionDetail,
    errors: [400, 401, 404],
  }),
  create: defineRoute({
    name: 'createTransaction',
    method: 'POST',
    path: base,
    tag,
    summary: 'Record a transaction (income, expense, split, transfer, refund, opening balance, adjustment)',
    description: 'The X-Operation-Id makes it run once; sending it again returns the first transaction (case 22).',
    access: editor,
    params: WorkspaceParams,
    body: CreateTransactionBody,
    status: 201,
    response: Transaction,
    errors: [400, 401, 403, 404, 409],
  }),
  update: defineRoute({
    name: 'updateTransaction',
    method: 'PATCH',
    path: `${base}/:transactionId`,
    tag,
    summary: 'Change notes, tags, payee or receipts in place',
    access: editor,
    params: TransactionParams,
    body: UpdateTransactionBody,
    status: 200,
    response: Transaction,
    errors: [400, 401, 403, 404, 409],
  }),
  correct: defineRoute({
    name: 'correctTransaction',
    method: 'POST',
    path: `${base}/:transactionId/correct`,
    tag,
    summary: 'Change amount, date, account or category (a reversal plus the new version)',
    description:
      '409 `already_changed` (with `current`) when another device changed it first; 409 `reconciled` when locked.',
    access: editor,
    params: TransactionParams,
    body: CorrectBody,
    status: 200,
    response: Corrected,
    errors: [400, 401, 403, 404, 409],
  }),
  reverse: defineRoute({
    name: 'deleteTransaction',
    method: 'POST',
    path: `${base}/:transactionId/reverse`,
    tag,
    summary: 'Delete (a reversal; history is kept)',
    access: editor,
    params: TransactionParams,
    body: ReverseBody,
    status: 200,
    response: Transaction,
    errors: [400, 401, 403, 404, 409],
  }),
  unlock: defineRoute({
    name: 'unlockTransaction',
    method: 'POST',
    path: `${base}/:transactionId/unlock`,
    tag,
    summary: 'Unlock a reconciled transaction so it can change',
    access: editor,
    params: TransactionParams,
    body: z.object({ confirm: z.literal(true, { error: 'Confirm to unlock' }) }),
    status: 200,
    response: Transaction,
    errors: [400, 401, 403, 404],
  }),
  bulk: defineRoute({
    name: 'bulkEditTransactions',
    method: 'POST',
    path: `${base}/bulk`,
    tag,
    summary: 'Categorize, tag, set payee or delete many at once',
    description: 'Categorizing saves each as a correction. Each transaction answers on its own.',
    access: editor,
    params: WorkspaceParams,
    body: BulkBody,
    status: 200,
    response: BulkResult,
    errors: [400, 401, 403, 404],
  }),
  transferSuggestions: defineRoute({
    name: 'listTransferSuggestions',
    method: 'GET',
    path: `${base}/transfer-suggestions`,
    tag,
    summary: 'Pairs that look like a transfer between your accounts',
    description: 'Money out of one account and the same amount into another within 3 days, neither already a transfer.',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: z.object({ suggestions: z.array(TransferSuggestion) }).meta({ id: 'TransferSuggestions' }),
    errors: [400, 401, 404],
  }),
  linkTransfer: defineRoute({
    name: 'linkTransfer',
    method: 'POST',
    path: `${base}/link-transfer`,
    tag,
    summary: 'Link two transactions as one transfer',
    description: 'Reverses both and posts one transfer, dated like the money out.',
    access: editor,
    params: WorkspaceParams,
    body: LinkTransferBody,
    status: 200,
    response: Transaction,
    errors: [400, 401, 403, 404, 409],
  }),
  dismissTransfer: defineRoute({
    name: 'dismissTransferSuggestion',
    method: 'POST',
    path: `${base}/transfer-suggestions/dismiss`,
    tag,
    summary: '"Not a transfer"',
    access: editor,
    params: WorkspaceParams,
    body: LinkTransferBody,
    status: 204,
    response: null,
    errors: [400, 401, 403, 404],
  }),
};

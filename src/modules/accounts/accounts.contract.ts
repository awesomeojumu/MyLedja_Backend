import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, LocalDate, MinorAmount, Uuid } from '../../common/http/schemas.js';
import { ACCOUNT_TYPES } from '../ledger/ledger.repository.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const ACCOUNT_GROUPS = ['cash_bank', 'cards_credit', 'investments', 'property', 'loans', 'other'] as const;

export const AccountParams = WorkspaceParams.extend({ accountId: Uuid });

export const Account = z
  .object({
    id: z.string(),
    type: z.enum(ACCOUNT_TYPES),
    group: z.enum(ACCOUNT_GROUPS).meta({ description: 'The Accounts page group (DESIGN.md page 8).' }),
    kind: z.enum(['asset', 'liability']),
    name: z.string(),
    institution: z.string().nullable().meta({ description: 'An Institution id from GET /v1/institutions.' }),
    last4: z.string().nullable(),
    currency: z.string(),
    onBudget: z.boolean().meta({ description: '"Count in budget". Off shows the "Tracking" tag.' }),
    archived: z.boolean(),
    closedWithBalance: z.boolean(),
    sortOrder: z.number().int(),
    balance: MinorAmount.meta({ description: 'As shown: what you have, or for a card or loan what you owe.' }),
    clearedBalance: MinorAmount,
    unclearedBalance: MinorAmount,
    lastReconciledAt: z.string().nullable().meta({ description: 'Date of the last finished reconcile.' }),
    importMapping: z
      .record(z.string(), z.unknown())
      .nullable()
      .meta({ description: 'The last CSV column mapping (P09-05).' }),
    version: z.number().int(),
  })
  .meta({ id: 'Account' });

export const NetWorth = z
  .object({
    amount: MinorAmount,
    assets: MinorAmount,
    owed: MinorAmount.meta({ description: 'What you owe on cards and loans, as a positive figure.' }),
    partial: z.array(z.string()).meta({ description: 'Currencies left out for want of a rate ("Partial").' }),
  })
  .meta({ id: 'NetWorth' });

export const AccountList = z.object({ accounts: z.array(Account), netWorth: NetWorth }).meta({ id: 'AccountList' });

const Last4 = z
  .string()
  .regex(/^\d{4}$/, { error: 'Enter only the last 4 digits' })
  .nullable()
  .meta({ description: 'Optional. MyLedja never stores a full account number.' });

export const CreateAccountBody = z.object({
  id: Uuid.optional().meta({ description: 'A UUID v7 made on the device, so it can be used offline before it syncs.' }),
  type: z.enum(ACCOUNT_TYPES, { error: 'Choose a type' }),
  name: z.string().trim().min(1, { error: 'Add a name for this account' }).max(100),
  institution: z.string().max(60).nullable().optional(),
  last4: Last4.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .meta({ description: "Defaults to the workspace's." }),
  onBudget: z.boolean().optional(),
  openingBalance: MinorAmount.default('0').meta({
    description: 'E8. What you have, or for a card or loan what you owe, as a positive figure. Never income.',
  }),
  openingDate: LocalDate,
});

export const UpdateAccountBody = z.object({
  baseVersion: BaseVersion,
  name: z.string().trim().min(1, { error: 'Add a name for this account' }).max(100).optional(),
  institution: z.string().max(60).nullable().optional(),
  last4: Last4.optional(),
  onBudget: z.boolean().optional(),
});

export const ArchiveBody = z.object({
  baseVersion: BaseVersion,
  moveBalanceTo: Uuid.nullable().meta({
    description: 'Move the balance to this account first (a transfer), or null to archive as "closed with balance".',
  }),
  date: LocalDate,
});

export const UpdateValueBody = z.object({
  value: MinorAmount.meta({ description: 'The new value, as shown.' }),
  date: LocalDate,
  notes: z.string().trim().max(500).nullable().optional(),
});

export const ReorderBody = z.object({ accountIds: z.array(Uuid).min(1).max(500) });

const tag = 'Accounts';
const base = '/v1/workspaces/:workspaceId/accounts';

export const accountRoutes = {
  list: defineRoute({
    name: 'listAccounts',
    method: 'GET',
    path: base,
    tag,
    summary: 'Every account, with net worth',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: WorkspaceParams,
    status: 200,
    response: AccountList,
    errors: [400, 401, 404],
  }),
  create: defineRoute({
    name: 'createAccount',
    method: 'POST',
    path: base,
    tag,
    summary: 'Add an account with its opening balance',
    access: { kind: 'workspace', minRole: 'editor' },
    params: WorkspaceParams,
    body: CreateAccountBody,
    status: 201,
    response: Account,
    errors: [400, 401, 403, 404, 409],
  }),
  get: defineRoute({
    name: 'getAccount',
    method: 'GET',
    path: `${base}/:accountId`,
    tag,
    summary: 'One account',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: AccountParams,
    status: 200,
    response: Account,
    errors: [400, 401, 404],
  }),
  update: defineRoute({
    name: 'updateAccount',
    method: 'PATCH',
    path: `${base}/:accountId`,
    tag,
    summary: 'Rename an account or change its details',
    access: { kind: 'workspace', minRole: 'editor' },
    params: AccountParams,
    body: UpdateAccountBody,
    status: 200,
    response: Account,
    errors: [400, 401, 403, 404, 409],
  }),
  archive: defineRoute({
    name: 'archiveAccount',
    method: 'POST',
    path: `${base}/:accountId/archive`,
    tag,
    summary: 'Archive an account, moving its balance first if asked',
    access: { kind: 'workspace', minRole: 'editor' },
    params: AccountParams,
    body: ArchiveBody,
    status: 200,
    response: Account,
    errors: [400, 401, 403, 404, 409],
  }),
  restore: defineRoute({
    name: 'restoreAccount',
    method: 'POST',
    path: `${base}/:accountId/restore`,
    tag,
    summary: 'Bring back an archived account (Undo)',
    access: { kind: 'workspace', minRole: 'editor' },
    params: AccountParams,
    status: 200,
    response: Account,
    errors: [400, 401, 403, 404],
  }),
  updateValue: defineRoute({
    name: 'updateAccountValue',
    method: 'POST',
    path: `${base}/:accountId/value`,
    tag,
    summary: 'Record a new value (E10), never as income',
    access: { kind: 'workspace', minRole: 'editor' },
    params: AccountParams,
    body: UpdateValueBody,
    status: 200,
    response: Account,
    errors: [400, 401, 403, 404, 409],
  }),
  reorder: defineRoute({
    name: 'reorderAccounts',
    method: 'PUT',
    path: `${base}/order`,
    tag,
    summary: 'Save the custom order',
    access: { kind: 'workspace', minRole: 'editor' },
    params: WorkspaceParams,
    body: ReorderBody,
    status: 200,
    response: AccountList,
    errors: [400, 401, 403, 404],
  }),
};

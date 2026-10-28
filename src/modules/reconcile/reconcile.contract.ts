import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { LocalDate, MinorAmount, Uuid } from '../../common/http/schemas.js';
import { AccountParams } from '../accounts/accounts.contract.js';
import { Transaction } from '../transactions/transactions.contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const Reconciliation = z
  .object({
    id: z.string(),
    accountId: z.string(),
    status: z.enum(['in_progress', 'finished', 'cancelled']),
    statementDate: z.string(),
    statementBalance: MinorAmount.meta({ description: 'What the bank said, kept apart from the calculated one.' }),
    cleared: MinorAmount.meta({ description: 'Cleared in MyLedja, as shown.' }),
    difference: MinorAmount.meta({ description: 'Statement − cleared. "Balanced" at 0.' }),
    tickedIds: z.array(z.string()),
    adjustmentId: z.string().nullable(),
    finishedAt: z.string().nullable(),
    finishedBy: z.string().nullable(),
    unlocked: z.array(z.object({ transactionId: z.string(), at: z.string(), by: z.string().nullable() })),
    version: z.number().int(),
  })
  .meta({ id: 'Reconciliation' });

export const ReconcileView = z
  .object({
    reconciliation: Reconciliation,
    candidates: z.array(Transaction).meta({ description: 'Uncleared and recently cleared, up to the statement date.' }),
  })
  .meta({ id: 'ReconcileView' });

export const ReconcileParams = WorkspaceParams.extend({ reconciliationId: Uuid });

const tag = 'Reconcile';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;
const one = '/v1/workspaces/:workspaceId/reconciliations/:reconciliationId';

export const reconcileRoutes = {
  start: defineRoute({
    name: 'startReconcile',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/accounts/:accountId/reconciliations',
    tag,
    summary: 'Start reconciling an account against a statement',
    description: 'Only one can be in progress per account; starting another returns it.',
    access: editor,
    params: AccountParams,
    body: z.object({ id: Uuid.optional(), statementDate: LocalDate, statementBalance: MinorAmount }),
    status: 201,
    response: ReconcileView,
    errors: [400, 401, 403, 404],
  }),
  history: defineRoute({
    name: 'listReconciliations',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/accounts/:accountId/reconciliations',
    tag,
    summary: 'Reconcile history',
    access: viewer,
    params: AccountParams,
    status: 200,
    response: z.object({ reconciliations: z.array(Reconciliation) }).meta({ id: 'ReconcileHistory' }),
    errors: [400, 401, 404],
  }),
  get: defineRoute({
    name: 'getReconcile',
    method: 'GET',
    path: one,
    tag,
    summary: 'A reconcile in progress, with its candidates',
    access: viewer,
    params: ReconcileParams,
    status: 200,
    response: ReconcileView,
    errors: [400, 401, 404],
  }),
  tick: defineRoute({
    name: 'tickReconcile',
    method: 'POST',
    path: `${one}/tick`,
    tag,
    summary: 'Tick or untick transactions as cleared',
    access: editor,
    params: ReconcileParams,
    body: z.object({ transactionIds: z.array(Uuid).min(1).max(500), cleared: z.boolean() }),
    status: 200,
    response: ReconcileView,
    errors: [400, 401, 403, 404, 409],
  }),
  finish: defineRoute({
    name: 'finishReconcile',
    method: 'POST',
    path: `${one}/finish`,
    tag,
    summary: 'Finish: lock the ticked transactions',
    description:
      'At a difference of 0, or with `adjust: true`, which posts an adjustment (E9) for exactly the difference; it is not income or spending. Otherwise 409 `not_balanced`.',
    access: editor,
    params: ReconcileParams,
    body: z.object({ adjust: z.boolean().default(false) }),
    status: 200,
    response: ReconcileView,
    errors: [400, 401, 403, 404, 409],
  }),
  cancel: defineRoute({
    name: 'cancelReconcile',
    method: 'POST',
    path: `${one}/cancel`,
    tag,
    summary: 'Leave without finishing',
    description: 'Ticks stay as cleared; nothing is locked.',
    access: editor,
    params: ReconcileParams,
    status: 200,
    response: Reconciliation,
    errors: [400, 401, 403, 404, 409],
  }),
};

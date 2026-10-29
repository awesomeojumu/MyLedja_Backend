import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { ErrorBody } from '../../common/errors/errors.js';
import { Uuid } from '../../common/http/schemas.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

/** The operations a device can queue offline (TECH-SPEC 9). Each payload is the body of the matching route. */
export const OPERATION_TYPES = [
  'transaction.create',
  'transaction.correct',
  'transaction.reverse',
  'transaction.update',
  'account.create',
  'account.update',
  'category.create',
  'category.update',
  'category.delete',
  'category.undo_delete',
  'category_group.create',
  'payee.create',
  'payee.update',
  'tag.create',
  'budget.assign',
  'budget.template.save',
  'schedule.create',
  'schedule.update',
  'goal.create',
  'goal.update',
  'goal.allocate',
  'goal.spend',
  'debt.lend',
  'debt.borrow',
  'debt.payment',
  'debt.write_off',
  'income.stream.create',
  'income.stream.update',
  'rule.upsert',
  'rule.delete',
  'holding.create',
  'holding.update',
  'holding.prices',
  'holding.archive',
  'holding.price.delete',
  'exchange_rate.set',
  'exchange_rate.delete',
  'report_dashboard.create',
  'report_dashboard.update',
  'report_dashboard.delete',
  'saved_report.create',
  'saved_report.update',
  'saved_report.delete',
] as const;

export const CURRENT_SCHEMA_VERSION = 1;

export const Operation = z
  .object({
    operationId: Uuid,
    type: z.enum(OPERATION_TYPES),
    targetId: Uuid.nullable().optional().meta({
      description:
        'The record a correct, reverse or update acts on; for budget.assign, the category. Month goes in the payload.',
    }),
    payload: z.record(z.string(), z.unknown()).meta({
      description: "The body of the matching route: transaction.create takes createTransaction's body, and so on.",
    }),
    baseVersion: z.number().int().nullable().optional(),
    transactionIds: z.array(Uuid).max(4).optional().meta({
      description:
        'Ids the device made for the transactions this operation posts, in posting order (a correction: reversal, then new).',
    }),
    createdAt: z.iso.datetime(),
    schemaVersion: z.number().int().meta({ description: 'The current and the previous version are accepted.' }),
  })
  .meta({ id: 'Operation' });

export const OperationResult = z
  .object({
    operationId: z.string(),
    status: z.enum(['applied', 'duplicate', 'conflict', 'rejected']),
    result: z.unknown().nullable().meta({ description: 'applied and duplicate: what the matching route returns.' }),
    current: z.unknown().nullable().meta({ description: "conflict: the server's version." }),
    error: ErrorBody.nullable().meta({ description: 'conflict and rejected: why.' }),
  })
  .meta({ id: 'OperationResult' });

export const Change = z
  .object({
    seq: z.string().meta({ description: 'A 64-bit number as a string.' }),
    collection: z.string(),
    id: z.string(),
    op: z.enum(['upsert', 'tombstone']),
    doc: z
      .unknown()
      .nullable()
      .meta({ description: 'The record in the same shape its GET route returns; null for tombstones.' }),
  })
  .meta({ id: 'Change' });

const tag = 'Sync';

export const syncRoutes = {
  push: defineRoute({
    name: 'sendOperations',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/sync/operations',
    tag,
    summary: 'Send queued operations, in order (up to 50)',
    description:
      "Each operation runs once by its operationId and answers on its own; a rejected one doesn't stop the rest. The request's own X-Operation-Id covers only the batch.",
    access: { kind: 'workspace', minRole: 'editor' },
    params: WorkspaceParams,
    body: z.object({
      deviceId: z.string().min(1).max(100),
      operations: z.array(Operation).min(1).max(50, { error: 'Send up to 50 operations at a time' }),
    }),
    status: 200,
    response: z.object({ results: z.array(OperationResult), seq: z.string() }).meta({ id: 'SyncPushResult' }),
    errors: [400, 401, 403, 404],
  }),
  pull: defineRoute({
    name: 'getChanges',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/sync/changes',
    tag,
    summary: 'Changes since a seq, tombstones included',
    description:
      'Page until `hasMore` is false. `reset: true` means the device is too far behind (tombstones are kept 180 days): send the outbox, discard the local copy and download again from `since=0`.',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: WorkspaceParams,
    query: z.object({
      since: z
        .string()
        .regex(/^\d{1,19}$/)
        .default('0'),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
    status: 200,
    response: z
      .object({ changes: z.array(Change), nextSince: z.string(), hasMore: z.boolean(), reset: z.boolean() })
      .meta({ id: 'ChangePage' }),
    errors: [400, 401, 404],
  }),
};

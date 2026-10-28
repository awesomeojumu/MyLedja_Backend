import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { Uuid } from '../../common/http/schemas.js';
import { StatementImport } from '../imports/imports.contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const BankLink = z
  .object({
    id: z.string(),
    accountId: z.string(),
    provider: z.literal('mono'),
    institution: z.string(),
    last4: z.string().nullable(),
    status: z.enum(['active', 'needs_reauth', 'disconnected']),
    lastSyncedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'BankLink' });

const LinkParams = WorkspaceParams.extend({ linkId: Uuid });
const tag = 'Bank connections';
const base = '/v1/workspaces/:workspaceId/banking';

export const bankingRoutes = {
  link: defineRoute({
    name: 'linkBank',
    method: 'POST',
    path: `${base}/mono/link`,
    tag,
    summary: 'Finish "Connect bank" with the code from Mono Connect',
    description: 'Links the bank to one of your accounts. 404 bank_off when Mono is not set up.',
    access: { kind: 'workspace', minRole: 'editor' },
    params: WorkspaceParams,
    body: z.object({ id: Uuid.optional(), accountId: Uuid, code: z.string().min(4).max(500) }),
    status: 201,
    response: BankLink,
    errors: [400, 401, 403, 404, 502],
  }),
  list: defineRoute({
    name: 'listBankLinks',
    method: 'GET',
    path: `${base}/links`,
    tag,
    summary: 'Bank connections (Settings › Bank connections)',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: WorkspaceParams,
    status: 200,
    response: z.object({ links: z.array(BankLink), available: z.boolean() }),
    errors: [401, 404],
  }),
  sync: defineRoute({
    name: 'syncBankLink',
    method: 'POST',
    path: `${base}/links/:linkId/sync`,
    tag,
    summary: 'Sync now: new bank transactions land in review, matched against manual ones',
    access: { kind: 'workspace', minRole: 'editor' },
    params: LinkParams,
    status: 200,
    response: z.object({ import: StatementImport.nullable(), newTransactions: z.number().int() }),
    errors: [401, 403, 404, 502],
  }),
  disconnect: defineRoute({
    name: 'disconnectBank',
    method: 'DELETE',
    path: `${base}/links/:linkId`,
    tag,
    summary: 'Disconnect a bank; what was imported stays',
    access: { kind: 'workspace', minRole: 'editor' },
    params: LinkParams,
    status: 204,
    response: null,
    errors: [401, 403, 404],
  }),
  webhook: defineRoute({
    name: 'monoWebhook',
    method: 'POST',
    path: '/v1/banking/mono/webhook',
    tag,
    summary: "Mono's webhook; refused unless its secret matches MONO_WEBHOOK_SECRET",
    access: { kind: 'public' },
    body: z.record(z.string(), z.unknown()),
    status: 200,
    response: z.object({ ok: z.literal(true) }),
    errors: [401],
    idempotent: false,
  }),
};

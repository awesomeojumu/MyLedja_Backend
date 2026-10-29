import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

/** Settings › Import and export: CSV export, full backup, restore, delete account (build plan B3.6, B3.7). */

export const BACKUP_FORMAT = 'myledja-backup';
export const BACKUP_SCHEMA_VERSION = 1;

export const ExportFile = z
  .object({
    filename: z.string(),
    mimeType: z.string(),
    content: z.string().meta({ description: 'The whole file as text, for the app to save.' }),
  })
  .meta({ id: 'ExportFile' });

const BackupContent = z.object({ content: z.string().min(2).max(50_000_000) });
const RestoreBody = BackupContent.extend({
  workspaceName: z.string().trim().min(1).max(60).optional(),
});

export const RestorePreview = z
  .object({
    workspaceName: z.string(),
    createdAt: z.string(),
    accounts: z.number().int(),
    transactions: z.number().int(),
    firstDate: z.string().nullable(),
    lastDate: z.string().nullable(),
    categories: z.number().int(),
    goals: z.number().int(),
    debts: z.number().int(),
    bills: z.number().int(),
  })
  .meta({ id: 'RestorePreview' });

export const Restored = z.object({ workspaceId: z.string(), workspaceName: z.string() }).meta({
  id: 'Restored',
  description: 'A backup restores into a new workspace; the current one is never touched (TECH-SPEC 11).',
});

const tag = 'Import and export';

export const exportRoutes = {
  exportCsv: defineRoute({
    name: 'exportTransactionsCsv',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/exports/transactions',
    tag,
    summary: 'Export every transaction as CSV (asks again)',
    description: 'Cells that start with =, +, - or @ are made safe for spreadsheets.',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: WorkspaceParams,
    status: 200,
    response: ExportFile,
    errors: [401, 403, 404],
  }),
  backup: defineRoute({
    name: 'createBackup',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/backups',
    tag,
    summary: 'Download a full backup (asks again)',
    description: 'One file with a checksum and schema version (TECH-SPEC 11).',
    access: { kind: 'workspace', minRole: 'owner' },
    params: WorkspaceParams,
    status: 200,
    response: ExportFile,
    errors: [401, 403, 404],
  }),
  restorePreview: defineRoute({
    name: 'previewRestore',
    method: 'POST',
    path: '/v1/me/restore/preview',
    tag,
    summary: "What's inside a backup, before restoring it",
    description: 'A damaged or edited file is refused here, before anything is written.',
    access: { kind: 'user' },
    body: BackupContent,
    status: 200,
    response: RestorePreview,
    errors: [400, 401],
  }),
  restore: defineRoute({
    name: 'restoreBackup',
    method: 'POST',
    path: '/v1/me/restore',
    tag,
    summary: 'Restore a backup into a new workspace (asks again)',
    access: { kind: 'user' },
    body: RestoreBody,
    status: 201,
    response: Restored,
    errors: [400, 401, 403],
  }),
  deleteAccount: defineRoute({
    name: 'deleteAccount',
    method: 'POST',
    path: '/v1/me/delete',
    tag,
    summary: 'Delete my account and everything in it (asks again)',
    description:
      'Signs out everywhere at once. Data is removed by a job, including files; backups age out within 30 days.',
    access: { kind: 'user' },
    status: 202,
    response: z.object({ deletingWorkspaces: z.number().int() }),
    errors: [401, 403],
  }),
};

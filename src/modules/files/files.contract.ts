import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

/** Files: signed upload and view links (TECH-SPEC 5.8 / §8). */

export const FileUploadBody = z.object({
  contentBase64: z.string().min(1).max(12_000_000),
  contentType: z.string().trim().min(3).max(100).default('image/jpeg'),
  kind: z.enum(['receipt', 'statement', 'other']).default('receipt'),
});

export const UploadedFile = z
  .object({
    fileId: z.string(),
    bytes: z.number().int().nonnegative(),
    resourceType: z.enum(['raw', 'image']),
  })
  .meta({ id: 'UploadedFile' });

export const FileParams = WorkspaceParams.extend({ fileId: z.string().min(1).max(200) });

export const SignedView = z
  .object({
    url: z.string().min(1).meta({ description: 'Signed HTTPS link, or a data URL when Cloudinary is not configured.' }),
    expiresAt: z.string().datetime(),
    fileId: z.string(),
  })
  .meta({ id: 'SignedView' });

const tag = 'Files';
const base = '/v1/workspaces/:workspaceId/files';
const editor = { kind: 'workspace', minRole: 'editor' } as const;
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;

export const fileRoutes = {
  upload: defineRoute({
    name: 'uploadFile',
    method: 'POST',
    path: base,
    tag,
    summary: 'Upload a private file (receipt, statement)',
    description: 'Stores the file as authenticated/private and returns its id for receiptFileIds (TECH-SPEC 5.8).',
    access: editor,
    params: WorkspaceParams,
    body: FileUploadBody,
    status: 201,
    response: UploadedFile,
    errors: [400, 401, 403, 404, 503],
  }),
  viewUrl: defineRoute({
    name: 'getFileViewUrl',
    method: 'GET',
    path: `${base}/:fileId/view-url`,
    tag,
    summary: 'Get a short-lived signed link to view a private file',
    access: viewer,
    params: FileParams,
    status: 200,
    response: SignedView,
    errors: [400, 401, 404, 503],
  }),
};

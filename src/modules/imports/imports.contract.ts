import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { LocalDate, MinorAmount, Uuid } from '../../common/http/schemas.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD MMM YYYY'] as const;

export const ColumnMapping = z
  .object({
    date: z.number().int().min(0),
    amount: z
      .number()
      .int()
      .min(0)
      .nullable()
      .meta({ description: 'One signed amount column, or use moneyIn and moneyOut.' }),
    moneyIn: z.number().int().min(0).nullable(),
    moneyOut: z.number().int().min(0).nullable(),
    description: z.number().int().min(0),
    payee: z.number().int().min(0).nullable(),
    notes: z.number().int().min(0).nullable(),
    dateFormat: z.enum(DATE_FORMATS),
    hasHeader: z.boolean(),
  })
  .meta({ id: 'ColumnMapping' });

export const ImportRow = z
  .object({
    index: z.number().int(),
    date: LocalDate.nullable(),
    amount: MinorAmount.nullable().meta({ description: 'Money in is positive.' }),
    description: z.string(),
    payeeName: z.string().nullable(),
    notes: z.string().nullable(),
    categoryId: z.string().nullable(),
    duplicateOf: z.string().nullable().meta({ description: 'A likely duplicate: struck through and unticked.' }),
    include: z.boolean(),
    error: z.string().nullable().meta({ description: 'Why the row could not be read. It will not be posted.' }),
    transactionId: z.string().nullable(),
  })
  .meta({ id: 'ImportRow' });

export const Import = z
  .object({
    id: z.string(),
    accountId: z.string(),
    fileName: z.string(),
    status: z.enum(['uploaded', 'mapped', 'posted', 'undone']),
    preview: z.array(z.array(z.string())).meta({ description: 'The first 10 rows as read.' }),
    mapping: ColumnMapping.nullable(),
    rows: z.array(ImportRow),
    counts: z.object({
      rows: z.number().int(),
      new: z.number().int(),
      duplicates: z.number().int(),
      errors: z.number().int(),
      posted: z.number().int(),
    }),
    stored: z.boolean().meta({ description: 'Whether the file was kept in private Cloudinary storage.' }),
    version: z.number().int(),
  })
  .meta({ id: 'Import' });

export const ImportParams = WorkspaceParams.extend({ importId: Uuid });

const tag = 'Imports';
const base = '/v1/workspaces/:workspaceId/imports';
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const StatementImport = Import.extend({
  reader: z.enum(['parser', 'ai']).meta({ description: 'Read on the server, or by AI from redacted lines.' }),
  bank: z
    .string()
    .nullable()
    .meta({ description: 'gtbank, access, zenith, uba, kuda, premiumtrust or bank78 when recognised.' }),
}).meta({ id: 'StatementImport' });

export const importRoutes = {
  uploadStatement: defineRoute({
    name: 'uploadStatement',
    method: 'POST',
    path: `${base}/statement`,
    tag,
    summary: 'Upload a PDF or Excel statement (B4.2)',
    description:
      'Read on the server where the layout allows. With useAi and consent to AI statement reading, unreadable files are read by AI from redacted transaction lines only. Rows land in review like a CSV.',
    access: editor,
    params: WorkspaceParams,
    body: z.object({
      id: Uuid.optional(),
      accountId: Uuid,
      fileName: z.string().trim().min(1).max(200),
      fileBase64: z.string().min(8).max(14_000_000, { error: 'Use a file under 10 MB' }),
      useAi: z.boolean().default(false),
    }),
    status: 201,
    response: StatementImport,
    errors: [400, 401, 403, 404, 503],
  }),
  upload: defineRoute({
    name: 'uploadImport',
    method: 'POST',
    path: base,
    tag,
    summary: 'Upload a CSV statement for an account',
    description:
      "The file is kept privately in Cloudinary when it is set up. Returns the first 10 rows and a suggested mapping (the account's last one if it has one).",
    access: editor,
    params: WorkspaceParams,
    body: z.object({
      id: Uuid.optional(),
      accountId: Uuid,
      fileName: z.string().trim().min(1).max(200),
      content: z
        .string()
        .min(1, { error: 'This file is empty' })
        .max(2_000_000, { error: 'Use a file under 2 MB' })
        .meta({ description: 'The CSV text, UTF-8.' }),
    }),
    status: 201,
    response: Import,
    errors: [400, 401, 403, 404],
  }),
  get: defineRoute({
    name: 'getImport',
    method: 'GET',
    path: `${base}/:importId`,
    tag,
    summary: 'An import and its rows',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: ImportParams,
    status: 200,
    response: Import,
    errors: [400, 401, 404],
  }),
  map: defineRoute({
    name: 'mapImport',
    method: 'POST',
    path: `${base}/:importId/map`,
    tag,
    summary: 'Map columns, read every row and find duplicates',
    description:
      'A duplicate is the same account and amount, a date within 3 days, and a similar description. The account remembers the mapping.',
    access: editor,
    params: ImportParams,
    body: z.object({ mapping: ColumnMapping }),
    status: 200,
    response: Import,
    errors: [400, 401, 403, 404, 409],
  }),
  post: defineRoute({
    name: 'postImport',
    method: 'POST',
    path: `${base}/:importId/post`,
    tag,
    summary: 'Post the ticked rows as one batch',
    description:
      'All or nothing. Rows without a category go to "Uncategorized" (or "Other income"). Rows with an error are reported, never posted.',
    access: editor,
    params: ImportParams,
    body: z.object({
      rows: z
        .array(z.object({ index: z.number().int(), include: z.boolean(), categoryId: Uuid.nullable().optional() }))
        .max(5000)
        .default([]),
    }),
    status: 200,
    response: Import,
    errors: [400, 401, 403, 404, 409],
  }),
  undo: defineRoute({
    name: 'undoImport',
    method: 'POST',
    path: `${base}/:importId/undo`,
    tag,
    summary: 'Undo the whole import',
    description: 'Reverses every row it posted, and nothing else.',
    access: editor,
    params: ImportParams,
    status: 200,
    response: Import,
    errors: [400, 401, 403, 404, 409],
  }),
};

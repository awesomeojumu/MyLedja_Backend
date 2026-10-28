import type { ClientSession, Db } from 'mongodb';
import type { z } from 'zod';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { ColumnMapping, ImportRow } from './imports.contract.js';

type Opts = { session?: ClientSession };

export type ImportDoc = {
  _id: string;
  workspaceId: string;
  accountId: string;
  fileName: string;
  /** Raw CSV text kept for Phase 1 (Cloudinary is optional / stub). */
  content: string;
  status: 'uploaded' | 'mapped' | 'posted' | 'undone';
  preview: string[][];
  mapping: z.output<typeof ColumnMapping> | null;
  rows: z.output<typeof ImportRow>[];
  counts: { rows: number; new: number; duplicates: number; errors: number; posted: number };
  stored: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class ImportsRepository extends BaseRepository<ImportDoc> {
  constructor(db: Db) {
    super(db, 'imports');
  }

  byId(ctx: WorkspaceContext, id: string, o: Opts = {}) {
    return this.findOne(ctx, { _id: id }, o);
  }
}

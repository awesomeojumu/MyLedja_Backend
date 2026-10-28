import type { Db } from 'mongodb';
import type { z } from 'zod';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { RuleBody } from './rules.contract.js';

export type RuleDoc = z.output<typeof RuleBody> & {
  _id: string;
  workspaceId: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class RulesRepository extends BaseRepository<RuleDoc> {
  constructor(db: Db) {
    super(db, 'rules');
  }
}

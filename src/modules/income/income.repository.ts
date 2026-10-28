import type { Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { z } from 'zod';
import type { GrossDeduction, IncomeRoutingRule } from './income.contract.js';

export type IncomeStreamDoc = {
  _id: string;
  workspaceId: string;
  scheduleId: string;
  streamKind: 'regular' | 'varies' | 'irregular' | 'passive';
  employerOrSource: string | null;
  taxClass: string;
  countInBudget: boolean;
  recordAs: 'take_home' | 'gross';
  grossAmountMinor: string | null;
  deductions: z.output<typeof GrossDeduction>[];
  routing: z.output<typeof IncomeRoutingRule>[];
  amountRange: { minMinor: string; maxMinor: string } | null;
  linkedTransactionIds: string[];
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class IncomeStreamsRepository extends BaseRepository<IncomeStreamDoc> {
  constructor(db: Db) {
    super(db, 'income_streams');
  }
}

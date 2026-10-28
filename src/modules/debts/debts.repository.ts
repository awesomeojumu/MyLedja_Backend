import type { ClientSession, Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { z } from 'zod';
import type { InstalmentSchedule, InterestTerms } from './debts.contract.js';

type Opts = { session?: ClientSession };

export type DebtDoc = {
  _id: string;
  workspaceId: string;
  direction: 'they_owe_me' | 'i_owe_them';
  personName: string;
  payeeId: string;
  ledgerAccountId: string;
  principalMinor: string;
  outstandingMinor: string;
  interest: z.output<typeof InterestTerms>;
  dueDate: string | null;
  instalments: z.output<typeof InstalmentSchedule> | null;
  accountId: string;
  openedOn: string;
  status: 'open' | 'settled' | 'written_off';
  notes: string | null;
  openTransactionId: string;
  paymentTransactionIds: string[];
  operationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class DebtsRepository extends BaseRepository<DebtDoc> {
  constructor(db: Db) {
    super(db, 'debts');
  }

  page(
    ctx: WorkspaceContext,
    filter: Record<string, unknown>,
    cursor: string | undefined,
    limit: number,
    o: Opts = {},
  ) {
    const q = { ...filter, ...(cursor ? { _id: { $gt: cursor } } : {}) };
    return this.find(ctx, q as never, { ...o, sort: { _id: 1 }, limit: limit + 1 });
  }
}

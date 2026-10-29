import type { Db, Decimal128 } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';

export type ExchangeRateDoc = {
  _id: string;
  workspaceId: string;
  currency: string;
  date: string;
  /** Workspace currency per one unit of `currency` (TECH-SPEC 7: Decimal128). */
  rate: Decimal128;
  source: 'manual';
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class ExchangeRatesRepository extends BaseRepository<ExchangeRateDoc> {
  constructor(db: Db) {
    super(db, 'exchange_rates');
  }
}

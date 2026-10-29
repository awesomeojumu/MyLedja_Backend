import type { Db } from 'mongodb';
import { BaseRepository } from '../../common/repository/base.repository.js';

export type HoldingDoc = {
  /** Also the id of the holding's ledger account. */
  _id: string;
  workspaceId: string;
  name: string;
  symbol: string | null;
  type: 'stock' | 'fund' | 'pension' | 'crypto' | 'fixed_deposit' | 'other';
  accountId: string;
  currency: string;
  archivedAt: Date | null;
  operationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

/** A price typed in for one holding on one day (TECH-SPEC 6.8). Not a ledger event. */
export type PriceDoc = {
  _id: string;
  workspaceId: string;
  holdingId: string;
  date: string;
  priceMinor: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class HoldingsRepository extends BaseRepository<HoldingDoc> {
  constructor(db: Db) {
    super(db, 'holdings');
  }
}

export class PricesRepository extends BaseRepository<PriceDoc> {
  constructor(db: Db) {
    super(db, 'prices');
  }
}

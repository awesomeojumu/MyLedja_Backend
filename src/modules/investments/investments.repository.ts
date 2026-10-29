import type { Collection, Db } from 'mongodb';

export type HoldingType = 'stock' | 'fund' | 'pension' | 'crypto' | 'fixed_deposit' | 'other';

export type HoldingDoc = {
  _id: string;
  workspaceId: string;
  name: string;
  symbol: string | null;
  type: HoldingType;
  accountId: string;
  currency: string;
  ledgerAccountId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LotDoc = {
  _id: string;
  workspaceId: string;
  holdingId: string;
  date: string;
  units: string;
  soldUnits: string;
  costMinor: string;
  pricePerUnitMinor: string;
  feesMinor: string;
  buyEventId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PriceDoc = {
  _id: string;
  workspaceId: string;
  holdingId: string;
  date: string;
  priceMinor: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type RateDoc = {
  _id: string;
  workspaceId: string;
  currency: string;
  date: string;
  rate: string;
  source: 'manual' | 'download';
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export class InvestmentsRepository {
  readonly holdings: Collection<HoldingDoc>;
  readonly lots: Collection<LotDoc>;
  readonly prices: Collection<PriceDoc>;
  readonly rates: Collection<RateDoc>;

  constructor(db: Db) {
    this.holdings = db.collection('holdings');
    this.lots = db.collection('lots');
    this.prices = db.collection('prices');
    this.rates = db.collection('exchange_rates');
  }
}

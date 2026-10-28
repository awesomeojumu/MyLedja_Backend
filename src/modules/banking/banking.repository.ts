import type { Db } from 'mongodb';
import { BaseRepository, GlobalRepository } from '../../common/repository/base.repository.js';

export type BankLinkDoc = {
  _id: string;
  workspaceId: string;
  accountId: string;
  provider: 'mono';
  /** The provider's account id, encrypted with the "bank-link" key (TECH-SPEC 10). */
  providerAccount: string;
  /** Hash of the provider's account id, so a webhook can find its link without decrypting every one. */
  providerAccountHash: string;
  institution: string;
  last4: string | null;
  status: 'active' | 'needs_reauth' | 'disconnected';
  lastSyncedAt: Date | null;
  lastSyncedDate: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class BankLinksRepository extends BaseRepository<BankLinkDoc> {
  constructor(db: Db) {
    super(db, 'bank_links');
  }
}

/** Webhooks arrive without a workspace; this finds the one link a provider account belongs to. */
export class BankLinkIndex extends GlobalRepository<BankLinkDoc> {
  constructor(db: Db) {
    super(db, 'bank_links');
  }

  byProviderHash(hash: string) {
    return this.collection.findOne({ providerAccountHash: hash, status: { $ne: 'disconnected' } });
  }

  active() {
    return this.collection.find({ status: 'active' }).toArray();
  }
}

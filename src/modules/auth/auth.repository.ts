import type { ClientSession, Db } from 'mongodb';
import { GlobalRepository } from '../../common/repository/base.repository.js';

type Opts = { session?: ClientSession };

export type UserDoc = {
  _id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  googleId: string | null;
  emailVerifiedAt: Date | null;
  termsAcceptedAt: Date;
  deletedAt: Date | null;
  /** Two-factor (B3.1): the secret is encrypted with the "two-factor" key; backup codes and trusted devices are hashes. */
  twoFactor?: {
    secret: string;
    enabledAt: Date;
    backupHashes: string[];
    trusted: { hash: string; expiresAt: Date }[];
  } | null;
  twoFactorPending?: { secret: string; createdAt: Date } | null;
  /** Passkeys (B3.2): WebAuthn credentials, public keys only. */
  passkeys?: PasskeyDoc[];
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type PasskeyDoc = {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export class UsersRepository extends GlobalRepository<UserDoc> {
  constructor(db: Db) {
    super(db, 'users');
  }

  byEmail(email: string, o: Opts = {}) {
    return this.collection.findOne({ email, deletedAt: null }, o);
  }

  byId(id: string, o: Opts = {}) {
    return this.collection.findOne({ _id: id, deletedAt: null }, o);
  }

  byPasskeyId(credentialId: string, o: Opts = {}) {
    return this.collection.findOne({ 'passkeys.id': credentialId, deletedAt: null }, o);
  }

  /** Sets security fields that `update` doesn't cover (two-factor, passkeys). */
  async setFields(
    id: string,
    set: Partial<Pick<UserDoc, 'twoFactor' | 'twoFactorPending' | 'passkeys' | 'deletedAt' | 'passwordHash'>>,
    o: Opts = {},
  ) {
    await this.collection.updateOne({ _id: id }, { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } }, o);
  }

  /** For the deletion job, which runs after deletedAt is set. */
  byIdIncludingDeleted(id: string) {
    return this.collection.findOne({ _id: id });
  }

  byGoogleId(googleId: string, o: Opts = {}) {
    return this.collection.findOne({ googleId, deletedAt: null }, o);
  }

  async insert(doc: UserDoc, o: Opts = {}) {
    await this.collection.insertOne(doc, o);
    return doc;
  }

  async update(id: string, set: Partial<Omit<UserDoc, '_id' | 'version' | 'createdAt'>>, o: Opts = {}) {
    await this.collection.updateOne({ _id: id }, { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } }, o);
  }
}

export type SessionKind = 'token' | 'cookie';

export type SessionDoc = {
  _id: string;
  userId: string;
  refreshHash: string;
  previousHashes: string[];
  kind: SessionKind;
  deviceName: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  /** The last time the person confirmed it was them on this device (sensitive actions, DESIGN 10.6). */
  recheckedAt?: Date | null;
};

export class SessionsRepository extends GlobalRepository<SessionDoc> {
  constructor(db: Db) {
    super(db, 'sessions');
  }

  async insert(doc: SessionDoc, o: Opts = {}) {
    await this.collection.insertOne(doc, o);
    return doc;
  }

  byId(id: string) {
    return this.collection.findOne({ _id: id });
  }

  /** Swaps the refresh hash only if it's still the one presented, so two refreshes can't both win. */
  async rotate(id: string, fromHash: string, toHash: string, now: Date, expiresAt: Date): Promise<boolean> {
    const res = await this.collection.updateOne(
      { _id: id, refreshHash: fromHash, revokedAt: null },
      {
        $set: { refreshHash: toHash, lastUsedAt: now, expiresAt },
        $push: { previousHashes: { $each: [fromHash], $slice: -10 } },
      },
    );
    return res.modifiedCount === 1;
  }

  listForUser(userId: string, now: Date) {
    return this.collection
      .find({ userId, revokedAt: null, expiresAt: { $gt: now } })
      .sort({ lastUsedAt: -1 })
      .toArray();
  }

  async markRechecked(id: string, at: Date) {
    await this.collection.updateOne({ _id: id }, { $set: { recheckedAt: at } });
  }

  async revoke(id: string, reason: string) {
    await this.collection.updateOne(
      { _id: id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
  }

  async revokeAllForUser(userId: string, reason: string, exceptId: string | null = null, o: Opts = {}) {
    const res = await this.collection.updateMany(
      { userId, revokedAt: null, ...(exceptId ? { _id: { $ne: exceptId } } : {}) },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
      o,
    );
    return res.modifiedCount;
  }

  deleteRevokedBefore(before: Date) {
    return this.collection.deleteMany({ revokedAt: { $lt: before } });
  }
}

export type CodePurpose = 'sign_up' | 'recover' | 'change_email';

export type CodeDoc = {
  _id: string;
  email: string;
  purpose: CodePurpose;
  hash: string;
  tries: number;
  createdAt: Date;
  expiresAt: Date;
};

export class CodesRepository extends GlobalRepository<CodeDoc> {
  constructor(db: Db) {
    super(db, 'codes');
  }

  find(email: string, purpose: CodePurpose) {
    return this.collection.findOne({ email, purpose });
  }

  async put(doc: CodeDoc) {
    const { _id, email, purpose, ...rest } = doc;
    await this.collection.updateOne(
      { email, purpose },
      { $set: rest, $setOnInsert: { _id, email, purpose } },
      { upsert: true },
    );
  }

  /** Counts a wrong try and returns how many there have been. */
  async addTry(id: string): Promise<number> {
    const doc = await this.collection.findOneAndUpdate(
      { _id: id },
      { $inc: { tries: 1 } },
      { returnDocument: 'after' },
    );
    return doc?.tries ?? Number.MAX_SAFE_INTEGER;
  }

  async remove(id: string, o: Opts = {}) {
    await this.collection.deleteOne({ _id: id }, o);
  }

  deleteExpired(now: Date) {
    return this.collection.deleteMany({ expiresAt: { $lt: now } });
  }
}

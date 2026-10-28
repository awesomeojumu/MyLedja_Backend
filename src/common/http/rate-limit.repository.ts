import type { Db } from 'mongodb';
import { Errors } from '../errors/errors.js';
import { GlobalRepository } from '../repository/base.repository.js';

type RateDoc = { _id: string; count: number; level: number; lockedUntil: Date | null; expiresAt: Date };

/** Counters stored in MongoDB, so limits hold across restarts and instances (TECH-SPEC 5.3). */
export class RateLimitRepository extends GlobalRepository<RateDoc> {
  constructor(
    db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    super(db, 'rate_limits');
  }

  /** Counts one request against `key`; refuses with 429 once `limit` is passed inside the window. */
  async hit(key: string, limit: number, windowSeconds: number): Promise<void> {
    const now = this.now();
    let doc = await this.collection.findOneAndUpdate(
      { _id: key, expiresAt: { $gt: now } },
      { $inc: { count: 1 } },
      { returnDocument: 'after' },
    );
    if (!doc) {
      const fresh = {
        count: 1,
        level: 0,
        lockedUntil: null,
        expiresAt: new Date(now.getTime() + windowSeconds * 1000),
      };
      await this.collection.updateOne({ _id: key }, { $set: fresh }, { upsert: true });
      doc = { _id: key, ...fresh };
    }
    if (doc.count > limit) {
      throw Errors.tooMany(Math.max(1, Math.ceil((doc.expiresAt.getTime() - now.getTime()) / 1000)));
    }
  }

  /** Seconds left on a lock, or 0. */
  async lockedFor(key: string): Promise<number> {
    const doc = await this.collection.findOne({ _id: key });
    const now = this.now().getTime();
    if (!doc?.lockedUntil || doc.lockedUntil.getTime() <= now) return 0;
    return Math.ceil((doc.lockedUntil.getTime() - now) / 1000);
  }

  /**
   * Records a failure. Every `maxFailures` failures locks the key for 1 minute, doubling each time
   * (TECH-SPEC 10). Returns the lock's seconds, or 0 if not locked yet.
   */
  async fail(key: string, maxFailures: number, baseLockSeconds: number): Promise<number> {
    const now = this.now();
    const doc = await this.collection.findOneAndUpdate(
      { _id: key },
      {
        $inc: { count: 1 },
        $set: { expiresAt: new Date(now.getTime() + 86_400_000) },
        $setOnInsert: { level: 0, lockedUntil: null },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (!doc || doc.count < maxFailures) return 0;
    const seconds = baseLockSeconds * 2 ** doc.level;
    await this.collection.updateOne(
      { _id: key },
      { $set: { count: 0, level: doc.level + 1, lockedUntil: new Date(now.getTime() + seconds * 1000) } },
    );
    return seconds;
  }

  async clear(key: string): Promise<void> {
    await this.collection.deleteOne({ _id: key });
  }

  deleteExpired(now: Date) {
    return this.collection.deleteMany({ expiresAt: { $lt: now } });
  }
}

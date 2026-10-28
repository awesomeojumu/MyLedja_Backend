import type { Db } from 'mongodb';
import { GlobalRepository } from '../common/repository/base.repository.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'parked';

export type JobDoc = {
  _id: string;
  name: string;
  status: JobStatus;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  repeatEverySeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export class JobsRepository extends GlobalRepository<JobDoc> {
  constructor(db: Db) {
    super(db, 'jobs');
  }

  /** Makes sure a repeating job exists, without moving one that's already scheduled. */
  async ensureRepeating(id: string, name: string, everySeconds: number, maxAttempts: number, now: Date) {
    await this.collection.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          name,
          status: 'queued',
          runAt: now,
          attempts: 0,
          maxAttempts,
          leaseOwner: null,
          leaseUntil: null,
          lastError: null,
          repeatEverySeconds: everySeconds,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }

  async enqueue(doc: JobDoc) {
    await this.collection.insertOne(doc);
  }

  /**
   * Claims one due job with a single atomic update, so two runners never take the same job (TECH-SPEC 5.6).
   * A running job whose lease has lapsed (its runner died) can be claimed again.
   */
  claim(owner: string, now: Date, leaseMs: number, names: string[]) {
    return this.collection.findOneAndUpdate(
      {
        name: { $in: names },
        $or: [
          { status: 'queued', runAt: { $lte: now } },
          { status: 'running', leaseUntil: { $lt: now } },
        ],
      },
      { $set: { status: 'running', leaseOwner: owner, leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now } },
      { sort: { runAt: 1 }, returnDocument: 'after' },
    );
  }

  async finish(job: JobDoc, owner: string, now: Date) {
    const next = job.repeatEverySeconds
      ? { status: 'queued' as const, runAt: new Date(now.getTime() + job.repeatEverySeconds * 1000), attempts: 0 }
      : { status: 'done' as const };
    await this.collection.updateOne(
      { _id: job._id, leaseOwner: owner },
      { $set: { ...next, leaseOwner: null, leaseUntil: null, lastError: null, updatedAt: now } },
    );
  }

  async fail(job: JobDoc, owner: string, now: Date, error: string, retryAt: Date | null) {
    await this.collection.updateOne(
      { _id: job._id, leaseOwner: owner },
      {
        $set: {
          status: retryAt ? 'queued' : 'parked',
          runAt: retryAt ?? job.runAt,
          leaseOwner: null,
          leaseUntil: null,
          lastError: error,
          updatedAt: now,
        },
        $inc: { attempts: 1 },
      },
    );
  }

  byId(id: string) {
    return this.collection.findOne({ _id: id });
  }
}

import { type Db, MongoServerError } from 'mongodb';
import { newId } from '../ids/ids.js';
import { GlobalRepository } from '../repository/base.repository.js';

type IdemDoc = {
  _id: string;
  scope: string;
  operationId: string;
  route: string;
  bodyHash: string;
  state: 'pending' | 'done';
  statusCode: number | null;
  /** The first answer, encrypted, because it can hold tokens. */
  response: string | null;
  createdAt: Date;
  expiresAt: Date;
};

export const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

/** Remembers each write's first answer by operationId, so a retry gets that answer (TECH-SPEC 5.3). */
export class IdempotencyRepository extends GlobalRepository<IdemDoc> {
  constructor(db: Db) {
    super(db, 'idempotency');
  }

  /** Claims the operation. Returns null if this call should run, or the existing record. */
  async claim(scope: string, operationId: string, route: string, bodyHash: string): Promise<IdemDoc | null> {
    const now = new Date();
    try {
      await this.collection.insertOne({
        _id: newId(),
        scope,
        operationId,
        route,
        bodyHash,
        state: 'pending',
        statusCode: null,
        response: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      });
      return null;
    } catch (e) {
      if (e instanceof MongoServerError && e.code === 11000) {
        return this.collection.findOne({ scope, operationId });
      }
      throw e;
    }
  }

  async complete(scope: string, operationId: string, statusCode: number, response: string) {
    await this.collection.updateOne({ scope, operationId }, { $set: { state: 'done', statusCode, response } });
  }

  async release(scope: string, operationId: string) {
    await this.collection.deleteOne({ scope, operationId, state: 'pending' });
  }
}

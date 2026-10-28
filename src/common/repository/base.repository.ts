import type {
  ClientSession,
  Collection,
  Db,
  Document,
  Filter,
  FindOptions,
  OptionalUnlessRequiredId,
  UpdateFilter,
} from 'mongodb';
import type { WorkspaceContext } from '../workspace/workspace-context.js';

type Opts = { session?: ClientSession };

export type WorkspaceDoc = Document & { _id: string; workspaceId: string };

/**
 * The only way to reach a workspace collection. Every call needs a WorkspaceContext, and `workspaceId`
 * is added to every filter, update and insert, so one workspace can't touch another's data (TECH-SPEC 5.4).
 */
export abstract class BaseRepository<T extends WorkspaceDoc> {
  protected readonly collection: Collection<T>;

  protected constructor(db: Db, name: string) {
    this.collection = db.collection<T>(name);
  }

  protected scope(ctx: WorkspaceContext, filter: Filter<T> = {}): Filter<T> {
    if (!ctx?.workspaceId) throw new Error('workspace_context_missing');
    return { ...filter, workspaceId: ctx.workspaceId } as Filter<T>;
  }

  async findOne(ctx: WorkspaceContext, filter: Filter<T>, options: Opts = {}): Promise<T | null> {
    return (await this.collection.findOne(this.scope(ctx, filter), options)) as T | null;
  }

  async find(ctx: WorkspaceContext, filter: Filter<T>, options: FindOptions & Opts = {}): Promise<T[]> {
    return (await this.collection.find(this.scope(ctx, filter), options).toArray()) as T[];
  }

  async count(ctx: WorkspaceContext, filter: Filter<T> = {}, options: Opts = {}): Promise<number> {
    return this.collection.countDocuments(this.scope(ctx, filter), options);
  }

  async insertOne(ctx: WorkspaceContext, doc: Omit<T, 'workspaceId'>, options: Opts = {}): Promise<T> {
    this.scope(ctx);
    const full = { ...doc, workspaceId: ctx.workspaceId } as T;
    await this.collection.insertOne(full as OptionalUnlessRequiredId<T>, options);
    return full;
  }

  async updateOne(ctx: WorkspaceContext, filter: Filter<T>, update: UpdateFilter<T>, options: Opts = {}) {
    return this.collection.updateOne(this.scope(ctx, filter), withoutWorkspaceChange(update), options);
  }

  async findOneAndUpdate(
    ctx: WorkspaceContext,
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options: Opts & { upsert?: boolean } = {},
  ): Promise<T | null> {
    const scoped = this.scope(ctx, filter);
    const safe = withoutWorkspaceChange(update);
    if (options.upsert) {
      (safe as Document).$setOnInsert = { ...((safe as Document).$setOnInsert ?? {}), workspaceId: ctx.workspaceId };
    }
    return (await this.collection.findOneAndUpdate(scoped, safe, { ...options, returnDocument: 'after' })) as T | null;
  }

  async deleteOne(ctx: WorkspaceContext, filter: Filter<T>, options: Opts = {}) {
    return this.collection.deleteOne(this.scope(ctx, filter), options);
  }
}

function withoutWorkspaceChange<T>(update: UpdateFilter<T>): UpdateFilter<T> {
  const copy: Document = { ...update };
  for (const op of ['$set', '$setOnInsert', '$unset', '$rename', '$inc'] as const) {
    if (copy[op] && 'workspaceId' in copy[op]) {
      const { workspaceId: _ignored, ...rest } = copy[op] as Document;
      copy[op] = rest;
    }
  }
  return copy as UpdateFilter<T>;
}

/** Collections that belong to no workspace (users, sessions, codes, jobs, rate limits, idempotency). */
export abstract class GlobalRepository<T extends Document> {
  protected readonly collection: Collection<T>;

  protected constructor(db: Db, name: string) {
    this.collection = db.collection<T>(name);
  }
}

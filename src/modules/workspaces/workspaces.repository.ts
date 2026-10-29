import type { ClientSession, Db } from 'mongodb';
import type { Role } from '../../common/auth/roles.js';
import { BaseRepository, GlobalRepository } from '../../common/repository/base.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';

type Opts = { session?: ClientSession };

export type SetupDraft = {
  accounts: { id?: string; name: string; type: string; openingBalance: bigint; openingDate: string }[];
  categories: { key: string; group: string; name: string }[];
  monthlyTakeHome: bigint | null;
};

export type WorkspaceDoc = {
  _id: string;
  workspaceId: string;
  name: string;
  type: 'personal';
  currency: string;
  timeZone: string;
  weekStart: 'monday' | 'sunday' | 'saturday';
  budgetStyle: 'tracking' | 'envelope';
  setupComplete: boolean;
  skippedSteps: number[];
  features: string[];
  ownerId: string;
  setupDraft: SetupDraft | null;
  /** Each AI use is on only after the person agrees (TECH-SPEC 5.8, Settings › AI features). */
  aiConsent?: AiConsent;
  /** Health settings (DESIGN.md page 23); defaults apply until set. */
  healthSettings?: HealthSettingsDoc;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type HealthSettingsDoc = {
  cashAccountIds: string[] | null;
  targetMonths: 3 | 6 | 12;
  countInvestments: boolean;
};

export type AiConsent = { categorize: boolean; statements: boolean; healthAdvice: boolean; updatedAt: Date | null };

export class WorkspacesRepository extends BaseRepository<WorkspaceDoc> {
  constructor(db: Db) {
    super(db, 'workspaces');
  }

  get(ctx: WorkspaceContext, o: Opts = {}) {
    return this.findOne(ctx, { _id: ctx.workspaceId }, o);
  }

  async setHealthSettings(ctx: WorkspaceContext, settings: HealthSettingsDoc) {
    await this.updateOne(
      ctx,
      { _id: ctx.workspaceId },
      { $set: { healthSettings: settings, updatedAt: new Date() }, $inc: { version: 1 } },
    );
  }

  async setAiConsent(ctx: WorkspaceContext, consent: AiConsent) {
    await this.updateOne(
      ctx,
      { _id: ctx.workspaceId },
      { $set: { aiConsent: consent, updatedAt: new Date() }, $inc: { version: 1 } },
    );
  }
}

export type MembershipDoc = {
  _id: string;
  workspaceId: string;
  userId: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export class MembershipsRepository extends BaseRepository<MembershipDoc> {
  constructor(db: Db) {
    super(db, 'memberships');
  }
}

/**
 * The membership lookups that happen before a workspace is known: the access guard checking a caller,
 * and finding a person's own workspaces. Read-only.
 */
export class MembershipLookup extends GlobalRepository<MembershipDoc> {
  constructor(db: Db) {
    super(db, 'memberships');
  }

  of(userId: string, workspaceId: string) {
    return this.collection.findOne({ userId, workspaceId });
  }

  forUser(userId: string, o: Opts = {}) {
    return this.collection.find({ userId }, o).sort({ createdAt: 1 }).toArray();
  }
}

export type CounterDoc = { _id: string; workspaceId: string; seq: bigint };

/** The per-workspace `seq` for the change feed (TECH-SPEC 5.7). */
export class CountersRepository extends BaseRepository<CounterDoc> {
  constructor(db: Db) {
    super(db, 'counters');
  }

  async create(ctx: WorkspaceContext, o: Opts = {}) {
    await this.insertOne(ctx, { _id: ctx.workspaceId, seq: 0n }, o);
  }

  /** Takes the next `count` numbers of the change feed; returns the first. */
  async take(ctx: WorkspaceContext, count: number, o: Opts = {}): Promise<bigint> {
    const after = await this.findOneAndUpdate(ctx, { _id: ctx.workspaceId }, { $inc: { seq: BigInt(count) } }, o);
    if (!after) throw new Error('counter_missing');
    return after.seq - BigInt(count) + 1n;
  }

  async current(ctx: WorkspaceContext, o: Opts = {}): Promise<bigint> {
    return (await this.findOne(ctx, { _id: ctx.workspaceId }, o))?.seq ?? 0n;
  }
}

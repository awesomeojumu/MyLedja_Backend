import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { parseMinor } from '../../common/money/money.js';
import { memberContext, type WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { User } from '../auth/auth.contract.js';
import type { UserDoc } from '../auth/auth.repository.js';
import type { SetupBody, Workspace } from './workspaces.contract.js';
import type {
  CountersRepository,
  MembershipLookup,
  MembershipsRepository,
  WorkspaceDoc,
  WorkspacesRepository,
} from './workspaces.repository.js';

export const DEFAULT_TIME_ZONE = 'Africa/Lagos';

export class WorkspacesService {
  constructor(
    private readonly database: Database,
    private readonly workspaces: WorkspacesRepository,
    private readonly memberships: MembershipsRepository,
    private readonly lookup: MembershipLookup,
    private readonly counters: CountersRepository,
    private readonly audit: AuditRepository,
  ) {}

  /** The Personal workspace made at sign-up (B0.9). Runs inside the caller's transaction. */
  async createPersonal(userId: string, session: ClientSession): Promise<WorkspaceContext> {
    const workspaceId = newId();
    const ctx = memberContext({ workspaceId, userId, sessionId: null, role: 'owner' });
    const now = new Date();
    const doc: Omit<WorkspaceDoc, 'workspaceId'> = {
      _id: workspaceId,
      name: 'Personal',
      type: 'personal',
      currency: 'NGN',
      timeZone: DEFAULT_TIME_ZONE,
      weekStart: 'monday',
      budgetStyle: 'tracking',
      setupComplete: false,
      skippedSteps: [],
      features: [],
      ownerId: userId,
      setupDraft: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await this.workspaces.insertOne(ctx, doc, { session });
    await this.memberships.insertOne(
      ctx,
      { _id: newId(), userId, role: 'owner', createdAt: now, updatedAt: now, version: 1 },
      { session },
    );
    await this.counters.create(ctx, { session });
    await this.audit.record(
      ctx,
      { action: 'workspace.created', target: { collection: 'workspaces', id: workspaceId } },
      { session },
    );
    return ctx;
  }

  /** The person's own (first owned) workspace, as a context for their own actions. */
  async personalContext(userId: string, sessionId: string | null, session?: ClientSession): Promise<WorkspaceContext> {
    const list = await this.lookup.forUser(userId, { session });
    const own = list.find((m) => m.role === 'owner') ?? list[0];
    if (!own) throw Errors.notFound();
    return memberContext({ workspaceId: own.workspaceId, userId, sessionId, role: own.role });
  }

  async userView(user: UserDoc, sessionId: string | null, session?: ClientSession): Promise<z.input<typeof User>> {
    const ctx = await this.personalContext(user._id, sessionId, session);
    const ws = await this.workspaces.get(ctx, { session });
    if (!ws) throw Errors.notFound();
    return {
      id: user._id,
      name: user.name,
      email: user.email,
      setupComplete: ws.setupComplete,
      workspaceId: ws._id,
      workspaceName: ws.name,
    };
  }

  async get(ctx: WorkspaceContext): Promise<z.input<typeof Workspace>> {
    const ws = await this.workspaces.get(ctx);
    if (!ws) throw Errors.notFound();
    return view(ws, ctx);
  }

  async setup(ctx: WorkspaceContext, body: z.output<typeof SetupBody>): Promise<WorkspaceDoc> {
    return this.database.transaction(async (session) => {
      const before = await this.workspaces.get(ctx, { session });
      if (!before) throw Errors.notFound();
      const draft = {
        accounts: body.accounts.map((a) => ({ ...a, openingBalance: parseMinor(a.openingBalance) })),
        categories: body.categories,
        monthlyTakeHome: body.monthlyTakeHome === null ? null : parseMinor(body.monthlyTakeHome),
      };
      const after = await this.workspaces.findOneAndUpdate(
        ctx,
        { _id: ctx.workspaceId },
        {
          $set: {
            name: body.workspaceName,
            currency: body.currency,
            weekStart: body.weekStart,
            budgetStyle: body.budgetStyle,
            skippedSteps: [...new Set(body.skippedSteps)].sort(),
            setupComplete: true,
            setupDraft: draft,
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw Errors.notFound();
      await this.audit.record(
        ctx,
        {
          action: 'workspace.setup_finished',
          target: { collection: 'workspaces', id: ctx.workspaceId },
          before: settingsOf(before),
          after: settingsOf(after),
        },
        { session },
      );
      return after;
    });
  }
}

function settingsOf(ws: WorkspaceDoc) {
  return {
    name: ws.name,
    weekStart: ws.weekStart,
    budgetStyle: ws.budgetStyle,
    setupComplete: ws.setupComplete,
    accounts: ws.setupDraft?.accounts.length ?? 0,
    categories: ws.setupDraft?.categories.length ?? 0,
  };
}

function view(ws: WorkspaceDoc, ctx: WorkspaceContext): z.input<typeof Workspace> {
  return {
    id: ws._id,
    name: ws.name,
    type: ws.type,
    currency: ws.currency,
    timeZone: ws.timeZone,
    weekStart: ws.weekStart,
    budgetStyle: ws.budgetStyle,
    setupComplete: ws.setupComplete,
    skippedSteps: ws.skippedSteps,
    role: ctx.role === 'system' ? 'owner' : ctx.role,
    features: ws.features,
    version: ws.version,
  };
}

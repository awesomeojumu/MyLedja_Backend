import type { z } from 'zod';
import { Errors } from '../../common/errors/errors.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { Rule, RuleBody } from './rules.contract.js';
import { applyRules, type RuleChange, type RuleInput } from './rules.engine.js';
import type { RuleDoc, RulesRepository } from './rules.repository.js';

export class RulesService {
  constructor(
    private readonly database: Database,
    private readonly repo: RulesRepository,
    private readonly ledger: LedgerService,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private view(d: RuleDoc): z.input<typeof Rule> {
    return {
      id: d._id,
      enabled: d.enabled,
      stage: d.stage,
      order: d.order,
      matchMode: d.matchMode,
      conditions: d.conditions,
      actions: d.actions,
      matchedCount: d.matchedCount,
      ...(d.lastUsedAt ? { lastUsedAt: d.lastUsedAt } : {}),
      version: d.version,
    };
  }

  async list(ctx: WorkspaceContext) {
    return { rules: (await this.repo.find(ctx, { deletedAt: null })).map((d) => this.view(d)) };
  }

  async get(ctx: WorkspaceContext, id: string) {
    const d = await this.repo.findOne(ctx, { _id: id, deletedAt: null });
    if (!d) throw Errors.notFound();
    return this.view(d);
  }

  /** Create or replace a rule with the id the device made. A stale baseVersion is a conflict (TECH-SPEC 9.4). */
  async upsert(ctx: WorkspaceContext, id: string, body: z.output<typeof RuleBody>, baseVersion: number | null) {
    return this.database.transaction(async (session) => {
      const now = this.now();
      const before = await this.repo.findOne(ctx, { _id: id }, { session });
      if (before && baseVersion !== null && baseVersion !== 0 && before.version !== baseVersion) {
        throw Errors.validation('baseVersion', 'This rule changed on another device.');
      }
      if (before)
        await this.repo.updateOne(
          ctx,
          { _id: id },
          { $set: { ...body, deletedAt: null, updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
      else
        await this.repo.insertOne(
          ctx,
          { _id: id, ...body, deletedAt: null, createdAt: now, updatedAt: now, version: 1 },
          { session },
        );
      await this.ledger.feed(ctx, [{ collection: 'rules', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: before ? 'rule.updated' : 'rule.created', target: { collection: 'rules', id } },
        { session },
      );
      return this.view((await this.repo.findOne(ctx, { _id: id }, { session }))!);
    });
  }

  async remove(ctx: WorkspaceContext, id: string) {
    await this.database.transaction(async (session) => {
      await this.repo.updateOne(
        ctx,
        { _id: id },
        { $set: { deletedAt: this.now(), enabled: false, updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'rules', docId: id, op: 'tombstone' }], session);
      await this.audit.record(ctx, { action: 'rule.deleted', target: { collection: 'rules', id } }, { session });
    });
    return { id };
  }

  /** What the workspace's rules would change on one row, for imports and bank sync before any AI suggestion. */
  async changeFor(ctx: WorkspaceContext, inputs: RuleInput[]): Promise<RuleChange[]> {
    const rules = await this.repo.find(ctx, { deletedAt: null, enabled: true });
    return inputs.map((i) => applyRules(rules, i));
  }
}

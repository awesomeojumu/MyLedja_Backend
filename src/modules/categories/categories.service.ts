import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import { inputOf } from '../ledger/input-of.js';
import { toRef } from '../ledger/ledger.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { SystemKey } from '../ledger/ledger.types.js';
import type {
  Category,
  CategoryGroup,
  CreateCategoryBody,
  CreateGroupBody,
  CreatePayeeBody,
  MergePayeesBody,
  Payee,
  Tag,
  UpdateCategoryBody,
  UpdateGroupBody,
  UpdatePayeeBody,
} from './categories.contract.js';
import type { BudgetMonthsRepository } from '../budget/budget.repository.js';
import type { RulesRepository } from '../rules/rules.repository.js';
import type { SchedulesRepository } from '../schedules/schedules.repository.js';
import {
  type CategoriesRepository,
  type CategoryDoc,
  type GroupDoc,
  type GroupsRepository,
  keyOf,
  type PayeeDoc,
  type PayeeMergesRepository,
  type PayeesRepository,
  type TagDoc,
  type TagsRepository,
} from './categories.repository.js';

type Opts = { session?: ClientSession };

/** Every workspace starts with these, so every movement has a category (Q-B13, Q-B14). */
const DEFAULT_GROUPS = [
  { key: 'income', name: 'Income', kind: 'income' },
  { key: 'other', name: 'Other', kind: 'expense' },
] as const;

const DEFAULT_CATEGORIES: {
  key: string;
  group: 'income' | 'other';
  name: string;
  kind: 'income' | 'expense';
  system: SystemKey | null;
  budgetable: boolean;
}[] = [
  { key: 'other_income', group: 'income', name: 'Other income', kind: 'income', system: null, budgetable: true },
  {
    key: 'interest_earned',
    group: 'income',
    name: 'Interest earned',
    kind: 'income',
    system: 'interest_earned',
    budgetable: false,
  },
  {
    key: 'investment_income',
    group: 'income',
    name: 'Investment income',
    kind: 'income',
    system: 'investment_income',
    budgetable: false,
  },
  {
    key: 'investment_gain',
    group: 'income',
    name: 'Investment gain',
    kind: 'income',
    system: 'investment_gain',
    budgetable: false,
  },
  { key: 'uncategorized', group: 'other', name: 'Uncategorized', kind: 'expense', system: null, budgetable: true },
  {
    key: 'interest_and_charges',
    group: 'other',
    name: 'Interest and charges',
    kind: 'expense',
    system: 'interest_and_charges',
    budgetable: true,
  },
  { key: 'fees', group: 'other', name: 'Fees', kind: 'expense', system: 'fees', budgetable: true },
  { key: 'taxes', group: 'other', name: 'Taxes', kind: 'expense', system: 'taxes', budgetable: false },
];

const meta = (now: Date) => ({ createdAt: now, updatedAt: now, version: 1 });

export const CategoryErrors = {
  nameTaken: (what: string) =>
    new AppError(409, 'name_taken', `You already have a ${what} with this name.`, { field: 'name' }),
  /** PU46-2: a bank name belongs to only one payee. */
  aliasTaken: (ownerName: string) =>
    new AppError(409, 'alias_taken', `That name already belongs to ${ownerName}.`, {
      field: 'aliases',
      ownerName,
    }),
  groupKind: () =>
    new AppError(400, 'wrong_group', 'Move it to a group of the same kind (income or spending).', { field: 'groupId' }),
  system: () =>
    new AppError(409, 'system_category', 'This category is built in, so it can\u2019t be deleted. You can hide it.'),
  moveToNeeded: (n: number) =>
    new AppError(400, 'move_to_needed', `Choose where its ${n} transactions should move.`, { field: 'moveTo' }),
  moveToKind: () =>
    new AppError(400, 'wrong_category', 'Move them to a category of the same kind.', { field: 'moveTo' }),
  groupNotEmpty: () => new AppError(409, 'group_not_empty', 'Move or delete its categories first.'),
  mergeSelf: () => new AppError(400, 'invalid_input', 'Pick at least two different payees.', { field: 'mergeIds' }),
  payeeHasTx: (n: number) =>
    new AppError(
      400,
      'payee_has_transactions',
      `This payee still has ${n} transactions. Merge it into another payee instead.`,
      { field: 'payeeId', transactionCount: n },
    ),
  undone: () => new AppError(409, 'already_undone', 'This was already undone.'),
  stale: (current: unknown) =>
    new AppError(409, 'already_changed', 'This was already changed on another device.', { current }),
};

/** Categories, groups, tags and payees (build plan B1.7). Every write updates the change feed in its transaction. */
export class CategoriesService {
  constructor(
    private readonly database: Database,
    readonly categories: CategoriesRepository,
    private readonly groups: GroupsRepository,
    private readonly tags: TagsRepository,
    readonly payees: PayeesRepository,
    private readonly merges: PayeeMergesRepository,
    private readonly ledger: LedgerService,
    private readonly audit: AuditRepository,
    private readonly currencyOf: (ctx: WorkspaceContext, session?: ClientSession) => Promise<string>,
    private readonly now: () => Date = () => new Date(),
    private readonly budgetMonths: BudgetMonthsRepository | null = null,
    private readonly rules: RulesRepository | null = null,
    private readonly schedules: SchedulesRepository | null = null,
    /** Resolve a stored logo file id to a URL the client can show (Cloudinary signed/public). */
    private readonly logoUrlOf: (logoFileId: string | null) => string | null = () => null,
  ) {}

  /** The default groups and categories, each with its ledger account. Safe to run twice. */
  async seedDefaults(ctx: WorkspaceContext, currency: string, session: ClientSession): Promise<void> {
    const groupIds = new Map<string, string>();
    for (const [i, g] of DEFAULT_GROUPS.entries()) {
      const found = await this.groups.findOne(ctx, { name: g.name, kind: g.kind }, { session });
      const id = found?._id ?? newId();
      if (!found)
        await this.groups.insertOne(
          ctx,
          { _id: id, name: g.name, kind: g.kind, sortOrder: i === 0 ? 0 : 1000, ...meta(this.now()) },
          { session },
        );
      groupIds.set(g.key, id);
    }
    for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
      if (await this.categories.byStarterKey(ctx, c.key, { session })) continue;
      await this.insertCategory(
        ctx,
        {
          groupId: groupIds.get(c.group)!,
          name: c.name,
          kind: c.kind,
          system: c.system,
          starterKey: c.key,
          budgetable: c.budgetable,
          sortOrder: 900 + i,
        },
        currency,
        session,
      );
    }
  }

  /** Welcome's categories (P04): each in the group named, made if missing. Matched by key, then by name. */
  async ensureFromSetup(
    ctx: WorkspaceContext,
    list: { key: string; group: string; name: string }[],
    currency: string,
    session: ClientSession,
  ): Promise<void> {
    const groups = await this.groups.find(ctx, {}, { session });
    const existing = await this.categories.live(ctx, { session });
    for (const [i, c] of list.entries()) {
      const kind = keyOf(c.group) === 'income' ? 'income' : 'expense';
      if (existing.some((x) => x.starterKey === c.key || (keyOf(x.name) === keyOf(c.name) && x.kind === kind)))
        continue;
      let group = groups.find((g) => keyOf(g.name) === keyOf(c.group) && g.kind === kind);
      if (!group) {
        group = await this.groups.insertOne(
          ctx,
          { _id: newId(), name: c.group.trim(), kind, sortOrder: 10 + groups.length, ...meta(this.now()) },
          { session },
        );
        groups.push(group);
        await this.ledger.feed(ctx, [{ collection: 'category_groups', docId: group._id, op: 'upsert' }], session);
      }
      const doc = await this.insertCategory(
        ctx,
        { groupId: group._id, name: c.name, kind, starterKey: c.key, sortOrder: 10 + i },
        currency,
        session,
      );
      existing.push(doc);
    }
  }

  private async insertCategory(
    ctx: WorkspaceContext,
    c: Partial<CategoryDoc> & Pick<CategoryDoc, 'groupId' | 'name' | 'kind'>,
    currency: string,
    session: ClientSession,
  ): Promise<CategoryDoc> {
    const now = this.now();
    const doc = await this.categories.insertOne(
      ctx,
      {
        _id: c._id ?? newId(),
        groupId: c.groupId,
        name: c.name,
        icon: c.icon ?? null,
        kind: c.kind,
        type: c.kind === 'expense' ? (c.type ?? 'flexible') : null,
        hidden: false,
        budgetable: c.budgetable ?? true,
        carryOver: c.carryOver ?? false,
        essential: c.essential ?? false,
        system: c.system ?? null,
        starterKey: c.starterKey ?? null,
        sortOrder: c.sortOrder ?? 0,
        deletedAt: null,
        deletion: null,
        ...meta(now),
      },
      { session },
    );
    if (doc.system) await this.ledger.linkSystemCategory(ctx, doc.system, doc._id, session);
    else
      await this.ledger.ensureCategoryAccount(
        ctx,
        { categoryId: doc._id, kind: doc.kind, name: doc.name, currency },
        session,
      );
    await this.ledger.feed(ctx, [{ collection: 'categories', docId: doc._id, op: 'upsert' }], session);
    return doc;
  }

  async tree(
    ctx: WorkspaceContext,
  ): Promise<{ groups: z.input<typeof CategoryGroup>[]; categories: z.input<typeof Category>[] }> {
    const groups = await this.groups.find(ctx, {}, { sort: { sortOrder: 1, name: 1 } });
    const categories = await this.categories.live(ctx);
    return { groups: groups.map(groupView), categories: categories.map(categoryView) };
  }

  async create(ctx: WorkspaceContext, body: z.output<typeof CreateCategoryBody>) {
    return this.database.transaction(async (session) => {
      const currency = await this.currencyOf(ctx, session);
      const group = await this.groups.findOne(ctx, { _id: body.groupId }, { session });
      if (!group) throw Errors.validation('groupId', "We couldn't find this group. It may have been removed.");
      await this.assertFreeName(ctx, body.name, group.kind, null, session);
      if (body.id && (await this.categories.findOne(ctx, { _id: body.id }, { session }))) {
        return categoryView((await this.categories.findOne(ctx, { _id: body.id }, { session }))!);
      }
      const doc = await this.insertCategory(
        ctx,
        {
          _id: body.id,
          groupId: group._id,
          name: body.name,
          kind: group.kind,
          icon: body.icon ?? null,
          type: body.type ?? null,
          budgetable: body.budgetable,
          carryOver: body.carryOver,
          essential: body.essential,
        },
        currency,
        session,
      );
      await this.audit.record(
        ctx,
        { action: 'category.created', target: { collection: 'categories', id: doc._id }, after: categoryView(doc) },
        { session },
      );
      return categoryView(doc);
    });
  }

  async update(ctx: WorkspaceContext, id: string, body: z.output<typeof UpdateCategoryBody>) {
    return this.database.transaction(async (session) => {
      const before = await this.categories.byId(ctx, id, { session });
      if (!before) throw Errors.notFound();
      if (before.version !== body.baseVersion) throw CategoryErrors.stale(categoryView(before));
      const { baseVersion: _v, ...changes } = body;
      if (changes.groupId) {
        const g = await this.groups.findOne(ctx, { _id: changes.groupId }, { session });
        if (!g) throw Errors.validation('groupId', "We couldn't find this group. It may have been removed.");
        if (g.kind !== before.kind) throw CategoryErrors.groupKind();
      }
      if (changes.name && keyOf(changes.name) !== keyOf(before.name))
        await this.assertFreeName(ctx, changes.name, before.kind, id, session);
      const after = await this.categories.findOneAndUpdate(
        ctx,
        { _id: id, version: before.version },
        { $set: { ...changes, updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw CategoryErrors.stale(categoryView(before));
      if (changes.name && !before.system) {
        await this.ledger.accounts.updateOne(
          ctx,
          { categoryId: id },
          { $set: { name: changes.name, updatedAt: this.now() } },
          { session },
        );
      }
      await this.ledger.feed(ctx, [{ collection: 'categories', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        {
          action: 'category.updated',
          target: { collection: 'categories', id },
          before: categoryView(before),
          after: categoryView(after),
        },
        { session },
      );
      return categoryView(after);
    });
  }

  /**
   * Moves every live transaction to `moveTo` (each as a correction, TECH-SPEC 6.3), moves budget
   * amounts / rules / schedules, then removes the category. Moves happen first, so a failure
   * part-way leaves the category in place to try again.
   */
  async remove(
    ctx: WorkspaceContext,
    id: string,
    moveTo: string | null,
    operationId: string,
    clientUndoId?: string | null,
  ) {
    const cat = await this.categories.byId(ctx, id);
    if (!cat) throw Errors.notFound();
    if (cat.system || cat.starterKey === 'uncategorized' || cat.starterKey === 'other_income')
      throw CategoryErrors.system();
    const events = await this.liveEventsIn(ctx, id);
    let target: CategoryDoc | null = null;
    if (moveTo) {
      target = await this.categories.byId(ctx, moveTo);
      if (!target || target._id === id)
        throw Errors.validation('moveTo', "We couldn't find this category. It may have been removed.");
      if (target.kind !== cat.kind) throw CategoryErrors.moveToKind();
    } else if (events.length > 0) throw CategoryErrors.moveToNeeded(events.length);
    const moves = await this.recategorize(ctx, events, id, target?._id ?? null, operationId);
    const budgetMoves = target ? await this.moveBudgetAmounts(ctx, id, target._id) : [];
    const ruleIds = target ? await this.rewriteRuleCategories(ctx, id, target._id) : [];
    const scheduleIds = target ? await this.rewriteScheduleCategories(ctx, id, target._id) : [];
    // Honor the device's undo token so offline toast Undo matches deletion.undoId after sync.
    const undoId = clientUndoId || newId();
    await this.database.transaction(async (session) => {
      await this.categories.updateOne(
        ctx,
        { _id: id },
        {
          $set: {
            deletedAt: this.now(),
            deletion: {
              undoId,
              movedTo: target?._id ?? null,
              moves,
              budgetMoves,
              ruleIds,
              scheduleIds,
            },
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'categories', docId: id, op: 'tombstone' }], session);
      await this.audit.record(
        ctx,
        {
          action: 'category.deleted',
          target: { collection: 'categories', id },
          after: {
            movedTo: target?._id ?? null,
            moved: moves.length,
            budgets: budgetMoves.length,
            rules: ruleIds.length,
            schedules: scheduleIds.length,
          },
        },
        { session },
      );
    });
    return { categoryId: id, moved: moves.length, undoId };
  }

  async undoRemove(ctx: WorkspaceContext, undoId: string, operationId: string) {
    const cat = await this.categories.findOne(ctx, { 'deletion.undoId': undoId });
    if (!cat) throw Errors.notFound();
    if (!cat.deletedAt) throw CategoryErrors.undone();
    const movedTo = cat.deletion?.movedTo;
    if (movedTo) {
      const back: string[] = [];
      for (const m of cat.deletion?.moves ?? []) back.push(m.to);
      const moved = await this.ledger.transactions.find(ctx, { _id: { $in: back }, status: 'posted' });
      await this.recategorize(ctx, moved, movedTo, cat._id, `${operationId}:undo`, true);
      await this.restoreBudgetAmounts(ctx, cat._id, movedTo, cat.deletion?.budgetMoves ?? []);
      await this.rewriteRuleCategories(ctx, movedTo, cat._id, cat.deletion?.ruleIds);
      await this.rewriteScheduleCategories(ctx, movedTo, cat._id, cat.deletion?.scheduleIds);
    }
    return this.database.transaction(async (session) => {
      const after = await this.categories.findOneAndUpdate(
        ctx,
        { _id: cat._id },
        { $set: { deletedAt: null, updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'categories', docId: cat._id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: 'category.restored', target: { collection: 'categories', id: cat._id } },
        { session },
      );
      return categoryView(after!);
    });
  }

  /** Move assigned budget amounts from one category to another; returns what left the source. */
  private async moveBudgetAmounts(
    ctx: WorkspaceContext,
    fromId: string,
    toId: string,
  ): Promise<{ month: string; amountMinor: string }[]> {
    if (!this.budgetMonths) return [];
    const rows = await this.budgetMonths.find(ctx, { categoryId: fromId });
    const moved: { month: string; amountMinor: string }[] = [];
    await this.database.transaction(async (session) => {
      const now = this.now();
      for (const row of rows) {
        if (row.assignedMinor <= 0n) continue;
        moved.push({ month: row.month, amountMinor: toMinorString(row.assignedMinor) });
        const dest = await this.budgetMonths!.byCategoryMonth(ctx, toId, row.month, { session });
        const next = (dest?.assignedMinor ?? 0n) + row.assignedMinor;
        await this.budgetMonths!.setAssigned(ctx, row.month, toId, next, now, { session });
        await this.budgetMonths!.setAssigned(ctx, row.month, fromId, 0n, now, { session });
        await this.ledger.feed(
          ctx,
          [
            { collection: 'budget_months', docId: `${toId}:${row.month}`, op: 'upsert' },
            { collection: 'budget_months', docId: `${fromId}:${row.month}`, op: 'upsert' },
          ],
          session,
        );
      }
    });
    return moved;
  }

  private async restoreBudgetAmounts(
    ctx: WorkspaceContext,
    categoryId: string,
    fromId: string,
    budgetMoves: { month: string; amountMinor: string }[],
  ) {
    if (!this.budgetMonths || budgetMoves.length === 0) return;
    await this.database.transaction(async (session) => {
      const now = this.now();
      for (const m of budgetMoves) {
        const amount = BigInt(m.amountMinor);
        const from = await this.budgetMonths!.byCategoryMonth(ctx, fromId, m.month, { session });
        const fromNext = (from?.assignedMinor ?? 0n) > amount ? from!.assignedMinor - amount : 0n;
        await this.budgetMonths!.setAssigned(ctx, m.month, fromId, fromNext, now, { session });
        await this.budgetMonths!.setAssigned(ctx, m.month, categoryId, amount, now, { session });
        await this.ledger.feed(
          ctx,
          [
            { collection: 'budget_months', docId: `${fromId}:${m.month}`, op: 'upsert' },
            { collection: 'budget_months', docId: `${categoryId}:${m.month}`, op: 'upsert' },
          ],
          session,
        );
      }
    });
  }

  /** Rewrite setCategory actions (optionally only for `onlyIds`). */
  private async rewriteRuleCategories(
    ctx: WorkspaceContext,
    fromId: string,
    toId: string,
    onlyIds?: string[],
  ): Promise<string[]> {
    if (!this.rules) return [];
    const filter = onlyIds?.length ? { _id: { $in: onlyIds }, deletedAt: null } : { deletedAt: null };
    const docs = await this.rules.find(ctx, filter);
    const changed: string[] = [];
    await this.database.transaction(async (session) => {
      for (const doc of docs) {
        let touched = false;
        const actions = doc.actions.map((a) => {
          if (a.kind === 'setCategory' && a.value === fromId) {
            touched = true;
            return { ...a, value: toId };
          }
          return a;
        });
        if (!touched) continue;
        await this.rules!.updateOne(
          ctx,
          { _id: doc._id },
          { $set: { actions, updatedAt: this.now() }, $inc: { version: 1 } },
          { session },
        );
        await this.ledger.feed(ctx, [{ collection: 'rules', docId: doc._id, op: 'upsert' }], session);
        changed.push(doc._id);
      }
    });
    return changed;
  }

  private async rewriteScheduleCategories(
    ctx: WorkspaceContext,
    fromId: string,
    toId: string,
    onlyIds?: string[],
  ): Promise<string[]> {
    if (!this.schedules) return [];
    const filter = onlyIds?.length ? { _id: { $in: onlyIds } } : { categoryId: fromId };
    const docs = await this.schedules.find(ctx, filter);
    const changed: string[] = [];
    await this.database.transaction(async (session) => {
      for (const doc of docs) {
        if (doc.categoryId !== fromId) continue;
        await this.schedules!.updateOne(
          ctx,
          { _id: doc._id },
          { $set: { categoryId: toId, updatedAt: this.now() }, $inc: { version: 1 } },
          { session },
        );
        await this.ledger.feed(ctx, [{ collection: 'schedules', docId: doc._id, op: 'upsert' }], session);
        changed.push(doc._id);
      }
    });
    return changed;
  }

  /** Corrects each event so lines on `from` land on `to`. Returns the old and new event ids. */
  async recategorize(
    ctx: WorkspaceContext,
    events: { _id: string }[],
    from: string,
    to: string | null,
    operationId: string,
    skipMissing = false,
  ): Promise<{ from: string; to: string }[]> {
    if (!to) return [];
    const moves: { from: string; to: string }[] = [];
    for (const [i, e] of events.entries()) {
      const full = await this.ledger.transactions.byId(ctx, e._id);
      if (!full || full.status !== 'posted') {
        if (skipMissing) continue;
        throw Errors.notFound();
      }
      const refs = new Map(
        (
          await this.ledger.accounts.byIds(
            ctx,
            full.lines.map((l) => l.ledgerAccountId),
          )
        ).map((a) => [a._id, toRef(a)]),
      );
      const input = inputOf(full, (id) => refs.get(id) ?? null);
      if (!input) continue;
      const swapped = JSON.parse(JSON.stringify(input).replaceAll(`"${from}"`, `"${to}"`));
      const { event } = await this.ledger.correct(ctx, full._id, swapped, {
        operationId: `${operationId}:${i}`,
        baseVersion: full.version,
      });
      moves.push({ from: full._id, to: event._id });
    }
    return moves;
  }

  liveEventsIn(ctx: WorkspaceContext, categoryId: string) {
    return this.ledger.transactions.find(
      ctx,
      { 'lines.categoryId': categoryId, status: 'posted', type: { $ne: 'reversal' } },
      { projection: { _id: 1 } },
    );
  }

  private async assertFreeName(
    ctx: WorkspaceContext,
    name: string,
    kind: string,
    except: string | null,
    session: ClientSession,
  ) {
    const same = (await this.categories.find(ctx, { deletedAt: null, kind: kind as never }, { session })).find(
      (c) => keyOf(c.name) === keyOf(name) && c._id !== except,
    );
    if (same) throw CategoryErrors.nameTaken('category');
  }

  async createGroup(ctx: WorkspaceContext, body: z.output<typeof CreateGroupBody>) {
    return this.database.transaction(async (session) => {
      const all = await this.groups.find(ctx, {}, { session });
      if (body.id) {
        const same = all.find((g) => g._id === body.id);
        if (same) return groupView(same);
      }
      if (all.some((g) => keyOf(g.name) === keyOf(body.name) && g.kind === body.kind))
        throw CategoryErrors.nameTaken('group');
      const doc = await this.groups.insertOne(
        ctx,
        { _id: body.id ?? newId(), name: body.name, kind: body.kind, sortOrder: all.length * 10, ...meta(this.now()) },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'category_groups', docId: doc._id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: 'category_group.created', target: { collection: 'category_groups', id: doc._id } },
        { session },
      );
      return groupView(doc);
    });
  }

  async updateGroup(ctx: WorkspaceContext, id: string, body: z.output<typeof UpdateGroupBody>) {
    return this.database.transaction(async (session) => {
      const before = await this.groups.findOne(ctx, { _id: id }, { session });
      if (!before) throw Errors.notFound();
      const { baseVersion, ...changes } = body;
      const after = await this.groups.findOneAndUpdate(
        ctx,
        { _id: id, version: baseVersion },
        { $set: { ...changes, updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw CategoryErrors.stale(groupView(before));
      await this.ledger.feed(ctx, [{ collection: 'category_groups', docId: id, op: 'upsert' }], session);
      return groupView(after);
    });
  }

  async removeGroup(ctx: WorkspaceContext, id: string) {
    await this.database.transaction(async (session) => {
      const g = await this.groups.findOne(ctx, { _id: id }, { session });
      if (!g) throw Errors.notFound();
      if ((await this.categories.count(ctx, { groupId: id, deletedAt: null }, { session })) > 0)
        throw CategoryErrors.groupNotEmpty();
      await this.groups.deleteOne(ctx, { _id: id }, { session });
      await this.ledger.feed(ctx, [{ collection: 'category_groups', docId: id, op: 'tombstone' }], session);
    });
  }

  // Tags

  async listTags(ctx: WorkspaceContext) {
    return { tags: (await this.tags.find(ctx, {}, { sort: { nameKey: 1 } })).map(tagView) };
  }

  async createTag(ctx: WorkspaceContext, body: { id?: string; name: string }) {
    return this.database.transaction(async (session) => {
      if (body.id) {
        const same = await this.tags.findOne(ctx, { _id: body.id }, { session });
        if (same) return tagView(same);
      }
      if (await this.tags.findOne(ctx, { nameKey: keyOf(body.name) }, { session }))
        throw CategoryErrors.nameTaken('tag');
      const doc = await this.tags.insertOne(
        ctx,
        { _id: body.id ?? newId(), name: body.name, nameKey: keyOf(body.name), ...meta(this.now()) },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'tags', docId: doc._id, op: 'upsert' }], session);
      return tagView(doc);
    });
  }

  async updateTag(ctx: WorkspaceContext, id: string, body: { baseVersion: number; name: string }) {
    return this.database.transaction(async (session) => {
      const before = await this.tags.findOne(ctx, { _id: id }, { session });
      if (!before) throw Errors.notFound();
      const clash = await this.tags.findOne(ctx, { nameKey: keyOf(body.name), _id: { $ne: id } }, { session });
      if (clash) throw CategoryErrors.nameTaken('tag');
      const after = await this.tags.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        { $set: { name: body.name, nameKey: keyOf(body.name), updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw CategoryErrors.stale(tagView(before));
      await this.ledger.feed(ctx, [{ collection: 'tags', docId: id, op: 'upsert' }], session);
      return tagView(after);
    });
  }

  async removeTag(ctx: WorkspaceContext, id: string) {
    await this.database.transaction(async (session) => {
      if (!(await this.tags.findOne(ctx, { _id: id }, { session }))) throw Errors.notFound();
      await this.ledger.patchMany(ctx, { tagId: id }, { pullTagId: id }, 'tag.removed_from_transactions', session);
      await this.tags.deleteOne(ctx, { _id: id }, { session });
      await this.ledger.feed(ctx, [{ collection: 'tags', docId: id, op: 'tombstone' }], session);
    });
  }

  // Payees

  async listPayees(ctx: WorkspaceContext, q: { q?: string; cursor?: string; limit: number }) {
    const filter: Record<string, unknown> = { mergedInto: null };
    if (q.q) {
      const re = new RegExp(escapeRegex(keyOf(q.q)));
      filter.$or = [{ nameKey: re }, { aliasKeys: re }];
    }
    if (q.cursor) {
      const [nameKey, id] = decodeCursor(q.cursor);
      filter.$and = [{ $or: [{ nameKey: { $gt: nameKey } }, { nameKey, _id: { $gt: id } }] }];
    }
    const docs = await this.payees.find(ctx, filter as never, { sort: { nameKey: 1, _id: 1 }, limit: q.limit + 1 });
    const page = docs.slice(0, q.limit);
    const stats = await this.payeeStats(
      ctx,
      page.map((p) => p._id),
    );
    return {
      items: page.map((p) => this.viewPayee(p, stats.get(p._id))),
      nextCursor: docs.length > q.limit ? encodeCursor([page.at(-1)!.nameKey, page.at(-1)!._id]) : null,
    };
  }

  async getPayee(ctx: WorkspaceContext, id: string) {
    const p = await this.payees.findOne(ctx, { _id: id, mergedInto: null });
    if (!p) throw Errors.notFound();
    return this.viewPayee(p, (await this.payeeStats(ctx, [id])).get(id));
  }

  async createPayee(ctx: WorkspaceContext, body: z.output<typeof CreatePayeeBody>) {
    const doc = await this.database.transaction(async (session) => {
      if (body.id) {
        const same = await this.payees.findOne(ctx, { _id: body.id }, { session });
        if (same) return same;
      }
      if (await this.payees.findOne(ctx, { nameKey: keyOf(body.name), mergedInto: null }, { session }))
        throw CategoryErrors.nameTaken('payee');
      const aliases = uniq(body.aliases ?? []);
      await this.assertAliasKeysFree(ctx, [keyOf(body.name), ...aliases.map(keyOf)], null, session);
      await this.assertCategory(ctx, body.defaultCategoryId ?? null, session);
      const p = await this.payees.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          name: body.name,
          nameKey: keyOf(body.name),
          aliases,
          aliasKeys: aliases.map(keyOf),
          defaultCategoryId: body.defaultCategoryId ?? null,
          logoFileId: body.logoFileId ?? null,
          mergedInto: null,
          ...meta(this.now()),
        },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'payees', docId: p._id, op: 'upsert' }], session);
      return p;
    });
    return this.viewPayee(doc, undefined);
  }

  async updatePayee(ctx: WorkspaceContext, id: string, body: z.output<typeof UpdatePayeeBody>) {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.payees.findOne(ctx, { _id: id, mergedInto: null }, { session });
      if (!before) throw Errors.notFound();
      const set: Partial<PayeeDoc> = { updatedAt: this.now() };
      if (body.name !== undefined) {
        const clash = await this.payees.findOne(
          ctx,
          { nameKey: keyOf(body.name), mergedInto: null, _id: { $ne: id } },
          { session },
        );
        if (clash) throw CategoryErrors.nameTaken('payee');
        set.name = body.name;
        set.nameKey = keyOf(body.name);
      }
      if (body.aliases !== undefined) {
        set.aliases = uniq(body.aliases);
        set.aliasKeys = set.aliases.map(keyOf);
      }
      const nameKey = set.nameKey ?? before.nameKey;
      const aliasKeys = set.aliasKeys ?? before.aliasKeys;
      await this.assertAliasKeysFree(ctx, [nameKey, ...aliasKeys], id, session);
      if (body.defaultCategoryId !== undefined) {
        await this.assertCategory(ctx, body.defaultCategoryId, session);
        set.defaultCategoryId = body.defaultCategoryId;
      }
      if (body.logoFileId !== undefined) set.logoFileId = body.logoFileId;
      const after = await this.payees.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        { $set: set, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw CategoryErrors.stale(this.viewPayee(before, undefined));
      await this.ledger.feed(ctx, [{ collection: 'payees', docId: id, op: 'upsert' }], session);
      return after;
    });
    return this.viewPayee(doc, (await this.payeeStats(ctx, [id])).get(id));
  }

  /** Every transaction moves to the kept payee in place; merged names become its aliases (P24-04). */
  async mergePayees(ctx: WorkspaceContext, body: z.output<typeof MergePayeesBody>) {
    const ids = uniq(body.mergeIds).filter((x) => x !== body.keepId);
    if (ids.length === 0) throw CategoryErrors.mergeSelf();
    const result = await this.database.transaction(async (session) => {
      const keep = await this.payees.findOne(ctx, { _id: body.keepId, mergedInto: null }, { session });
      const others = await this.payees.find(ctx, { _id: { $in: ids }, mergedInto: null }, { session });
      if (!keep || others.length !== ids.length) throw Errors.notFound();
      const pool = [keep, ...others];
      const logoFrom = body.logoFromId ? pool.find((p) => p._id === body.logoFromId) : keep;
      const categoryFrom = body.categoryFromId ? pool.find((p) => p._id === body.categoryFromId) : keep;
      if (body.logoFromId && !logoFrom) throw Errors.notFound();
      if (body.categoryFromId && !categoryFrom) throw Errors.notFound();
      const merged: { payeeId: string; eventIds: string[] }[] = [];
      let moved = 0;
      for (const o of others) {
        const eventIds = await this.ledger.patchMany(
          ctx,
          { payeeIds: [o._id] },
          { payeeId: keep._id },
          'payee.merged',
          session,
        );
        merged.push({ payeeId: o._id, eventIds });
        moved += eventIds.length;
      }
      const aliases = uniq([...keep.aliases, ...others.flatMap((o) => [o.name, ...o.aliases])]).filter(
        (a) => keyOf(a) !== keyOf(body.name ?? keep.name),
      );
      const mergeId = newId();
      await this.merges.insertOne(
        ctx,
        {
          _id: mergeId,
          keepId: keep._id,
          kept: {
            name: keep.name,
            aliases: keep.aliases,
            defaultCategoryId: keep.defaultCategoryId,
            logoFileId: keep.logoFileId,
          },
          merged,
          at: this.now(),
          undoneAt: null,
        },
        { session },
      );
      const name = body.name ?? keep.name;
      const logoFileId = body.logoFileId !== undefined ? body.logoFileId : (logoFrom?.logoFileId ?? keep.logoFileId);
      const defaultCategoryId =
        body.defaultCategoryId !== undefined
          ? body.defaultCategoryId
          : (categoryFrom?.defaultCategoryId ?? keep.defaultCategoryId);
      if (defaultCategoryId) await this.assertCategory(ctx, defaultCategoryId, session);
      const after = await this.payees.findOneAndUpdate(
        ctx,
        { _id: keep._id },
        {
          $set: {
            name,
            nameKey: keyOf(name),
            aliases,
            aliasKeys: aliases.map(keyOf),
            logoFileId,
            defaultCategoryId,
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await this.payees.updateMany(
        ctx,
        { _id: { $in: ids } },
        { $set: { mergedInto: keep._id, updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      await this.ledger.feed(
        ctx,
        [
          { collection: 'payees', docId: keep._id, op: 'upsert' },
          ...ids.map((docId) => ({ collection: 'payees', docId, op: 'tombstone' as const })),
        ],
        session,
      );
      await this.audit.record(
        ctx,
        { action: 'payee.merged', target: { collection: 'payees', id: keep._id }, after: { merged: ids, moved } },
        { session },
      );
      return { payee: after!, moved, mergeId };
    });
    return {
      payee: this.viewPayee(result.payee, (await this.payeeStats(ctx, [result.payee._id])).get(result.payee._id)),
      moved: result.moved,
      mergeId: result.mergeId,
    };
  }

  async undoMerge(ctx: WorkspaceContext, mergeId: string) {
    const ids = await this.database.transaction(async (session) => {
      const m = await this.merges.findOne(ctx, { _id: mergeId }, { session });
      if (!m) throw Errors.notFound();
      if (m.undoneAt) throw CategoryErrors.undone();
      for (const part of m.merged)
        await this.ledger.patchMany(
          ctx,
          { ids: part.eventIds },
          { payeeId: part.payeeId },
          'payee.merge_undone',
          session,
        );
      const restored = m.merged.map((x) => x.payeeId);
      await this.payees.updateMany(
        ctx,
        { _id: { $in: restored } },
        { $set: { mergedInto: null, updatedAt: this.now() }, $inc: { version: 1 } },
        { session },
      );
      await this.payees.updateOne(
        ctx,
        { _id: m.keepId },
        {
          $set: {
            name: m.kept.name,
            nameKey: keyOf(m.kept.name),
            aliases: m.kept.aliases,
            aliasKeys: m.kept.aliases.map(keyOf),
            defaultCategoryId: m.kept.defaultCategoryId ?? null,
            logoFileId: m.kept.logoFileId ?? null,
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await this.merges.updateOne(ctx, { _id: mergeId }, { $set: { undoneAt: this.now() } }, { session });
      await this.ledger.feed(
        ctx,
        [m.keepId, ...restored].map((docId) => ({ collection: 'payees', docId, op: 'upsert' as const })),
        session,
      );
      return [m.keepId, ...restored];
    });
    const docs = await this.payees.find(ctx, { _id: { $in: ids } });
    const stats = await this.payeeStats(ctx, ids);
    return { payees: docs.map((p) => this.viewPayee(p, stats.get(p._id))) };
  }

  /** PU-46: delete only when the payee has no transactions. */
  async deletePayee(ctx: WorkspaceContext, id: string) {
    await this.database.transaction(async (session) => {
      const before = await this.payees.findOne(ctx, { _id: id, mergedInto: null }, { session });
      if (!before) throw Errors.notFound();
      const stats = (await this.payeeStats(ctx, [id])).get(id);
      const count = stats?.count ?? 0;
      if (count > 0) throw CategoryErrors.payeeHasTx(count);
      await this.payees.deleteOne(ctx, { _id: id }, { session });
      await this.ledger.feed(ctx, [{ collection: 'payees', docId: id, op: 'tombstone' }], session);
      await this.audit.record(ctx, { action: 'payee.deleted', target: { collection: 'payees', id } }, { session });
    });
    return { payeeId: id };
  }

  /** Count, spending this year and last use, from live transactions. */
  private async payeeStats(ctx: WorkspaceContext, ids: string[]) {
    if (ids.length === 0) return new Map<string, Stats>();
    const year = `${this.now().getUTCFullYear()}`;
    const rows = await this.ledger.transactions.aggregate<{ _id: string; count: number; last: string; spent: bigint }>(
      ctx,
      [
        { $match: { payeeId: { $in: ids }, status: 'posted', type: { $ne: 'reversal' } } },
        {
          $project: {
            payeeId: 1,
            date: 1,
            spent: {
              $cond: [
                { $and: [{ $in: ['$type', ['expense', 'refund']] }, { $eq: [{ $substrCP: ['$date', 0, 4] }, year] }] },
                {
                  $sum: {
                    $map: {
                      input: {
                        $filter: { input: '$lines', cond: { $ne: [{ $ifNull: ['$$this.categoryId', null] }, null] } },
                      },
                      in: '$$this.amountMinor',
                    },
                  },
                },
                { $toLong: 0 },
              ],
            },
          },
        },
        { $group: { _id: '$payeeId', count: { $sum: 1 }, last: { $max: '$date' }, spent: { $sum: '$spent' } } },
      ],
    );
    return new Map(rows.map((r) => [r._id, { count: r.count, last: r.last, spent: BigInt(r.spent) }]));
  }

  private async assertCategory(ctx: WorkspaceContext, id: string | null, session: ClientSession) {
    if (id && !(await this.categories.byId(ctx, id, { session }))) {
      throw Errors.validation('defaultCategoryId', "We couldn't find this category. It may have been removed.");
    }
  }

  /** PU46-2: name and alias keys must not belong to another live payee. */
  private async assertAliasKeysFree(
    ctx: WorkspaceContext,
    keys: string[],
    exceptId: string | null,
    session: ClientSession,
  ) {
    const unique = [...new Set(keys.map(keyOf).filter(Boolean))];
    for (const k of unique) {
      const owner = await this.payees.findOne(
        ctx,
        {
          mergedInto: null,
          ...(exceptId ? { _id: { $ne: exceptId } } : {}),
          $or: [{ nameKey: k }, { aliasKeys: k }],
        } as never,
        { session },
      );
      if (owner) throw CategoryErrors.aliasTaken(owner.name);
    }
  }

  private viewPayee(p: PayeeDoc, s: Stats | undefined): z.input<typeof Payee> {
    return payeeView(p, s, this.logoUrlOf);
  }

  categoryById(ctx: WorkspaceContext, id: string, o: Opts = {}) {
    return this.categories.byId(ctx, id, o);
  }
}

type Stats = { count: number; last: string; spent: bigint };

export function categoryView(c: CategoryDoc): z.input<typeof Category> {
  return {
    id: c._id,
    groupId: c.groupId,
    name: c.name,
    icon: c.icon,
    kind: c.kind,
    type: c.type,
    hidden: c.hidden,
    budgetable: c.budgetable,
    carryOver: c.carryOver,
    essential: c.essential,
    system: c.system,
    starterKey: c.starterKey,
    sortOrder: c.sortOrder,
    version: c.version,
  };
}

const groupView = (g: GroupDoc): z.input<typeof CategoryGroup> => ({
  id: g._id,
  name: g.name,
  kind: g.kind,
  sortOrder: g.sortOrder,
  version: g.version,
});
const tagView = (t: TagDoc): z.input<typeof Tag> => ({ id: t._id, name: t.name, version: t.version });

export function payeeView(
  p: PayeeDoc,
  s: Stats | undefined,
  logoUrlOf: (logoFileId: string | null) => string | null = () => null,
): z.input<typeof Payee> {
  const raw = p.logoFileId;
  const logoUrl =
    raw &&
    (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:') || raw.startsWith('file:'))
      ? raw
      : logoUrlOf(raw);
  return {
    id: p._id,
    name: p.name,
    aliases: p.aliases,
    defaultCategoryId: p.defaultCategoryId,
    logoUrl,
    transactionCount: s?.count ?? 0,
    spentThisYear: toMinorString(s?.spent ?? 0n),
    lastUsed: s?.last ?? null,
    version: p.version,
  };
}

const uniq = (xs: string[]) => [...new Map(xs.map((x) => [keyOf(x), x.trim()])).values()];
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const encodeCursor = (parts: string[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
export function decodeCursor(c: string): string[] {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  } catch {
    // fall through
  }
  throw Errors.validation('cursor', 'This list has changed. Refresh and try again.');
}

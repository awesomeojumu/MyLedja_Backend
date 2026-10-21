import { Inject, Injectable } from "@nestjs/common";
import { Db } from "mongodb";
import { newId } from "@/common/ids";
import { parseMoney } from "@/common/money/money";
import { nairaOrNull } from "@/common/money/naira-or-null";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { CatalogFailure } from "@/modules/categories-merchants/domain/catalog-failure";
import { CatalogRepository } from "@/modules/categories-merchants/repositories/catalog.repository";
import type { CategoryGroupDoc } from "@/modules/categories-merchants/schemas/catalog";

type Kind = "income" | "expense";

/**
 * Groups organise categories ("Food and home", "Income"). A group decides whether its categories are spending or
 * income. Deleting a category moves everything that used it to another category first.
 */
@Injectable()
export class CategoryGroups {
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly memberships: ResolveMembership,
    @Inject(MONGO_DB) private readonly db: Db,
  ) {}

  private get groups() {
    return this.db.collection<CategoryGroupDoc>("category_groups");
  }

  private async allow(userId: string, workspaceId: string, write: boolean) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, write ? "write_records" : "view");
  }

  /** First look at a workspace's groups: an Income group holding its income categories. Only ever done once. */
  async seed(workspaceId: string): Promise<void> {
    const workspaces = this.db.collection<{ _id: string; categoryGroupsSeeded?: boolean }>("workspaces");
    const ws = await workspaces.findOne({ _id: workspaceId });
    if (!ws || ws.categoryGroupsSeeded) return;
    const claimed = await workspaces.updateOne({ _id: workspaceId, categoryGroupsSeeded: { $ne: true } }, { $set: { categoryGroupsSeeded: true } });
    if (!claimed.modifiedCount) return;
    const income = await this.catalog.categories.find({ workspaceId, kind: "income" }).toArray();
    if (!income.length) return;
    const group: CategoryGroupDoc = { _id: newId(), workspaceId, name: "Income", kind: "income" };
    await this.groups.insertOne(group);
    await this.catalog.categories.updateMany({ workspaceId, kind: "income", groupId: { $in: [null, undefined] } as never }, { $set: { groupId: group._id } });
  }

  async list(userId: string, workspaceId: string) {
    await this.allow(userId, workspaceId, false);
    await this.seed(workspaceId);
    const rows = await this.groups.find({ workspaceId }).toArray();
    return { status: "ok" as const, data: rows.map((g) => ({ id: g._id, name: g.name, kind: g.kind })), error: null };
  }

  async create(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.allow(userId, workspaceId, true);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new CatalogFailure("bad_request", "Name this group.");
    const kind: Kind = body.kind === "income" ? "income" : "expense";
    const clash = await this.groups.findOne({ workspaceId, name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
    if (clash) throw new CatalogFailure("bad_request", "There's already a group with that name.");
    const doc: CategoryGroupDoc = { _id: newId(), workspaceId, name, kind };
    await this.groups.insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id, name, kind }, error: null };
  }

  async rename(userId: string, workspaceId: string, groupId: string, body: Record<string, unknown>) {
    await this.allow(userId, workspaceId, true);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new CatalogFailure("bad_request", "Name this group.");
    const res = await this.groups.updateOne({ _id: groupId, workspaceId }, { $set: { name } });
    if (!res.matchedCount) throw new CatalogFailure("not_found", "not found");
    const g = await this.groups.findOne({ _id: groupId, workspaceId });
    return { status: "ok" as const, data: { id: groupId, name: g?.name, kind: g?.kind }, error: null };
  }

  /** Deleting a group keeps its categories; they become ungrouped. */
  async remove(userId: string, workspaceId: string, groupId: string) {
    await this.allow(userId, workspaceId, true);
    const res = await this.groups.deleteOne({ _id: groupId, workspaceId });
    if (!res.deletedCount) throw new CatalogFailure("not_found", "not found");
    await this.catalog.categories.updateMany({ workspaceId, groupId }, { $set: { groupId: null } });
    return { status: "ok" as const, data: { id: groupId }, error: null };
  }

  /** The kind a category takes in a group, or an error if the group isn't this workspace's. */
  async kindFor(workspaceId: string, groupId: string): Promise<Kind> {
    const g = await this.groups.findOne({ _id: groupId, workspaceId });
    if (!g) throw new CatalogFailure("bad_request", "Unknown group.");
    return g.kind;
  }

  /**
   * Delete a category. If anything uses it (transactions, old budget lines, monthly budget amounts), `moveTo` names
   * the category of the same kind that takes them over; monthly amounts for both are added together.
   */
  async removeCategory(userId: string, workspaceId: string, categoryId: string, body: Record<string, unknown>) {
    await this.allow(userId, workspaceId, true);
    const row = await this.catalog.categories.findOne({ _id: categoryId, workspaceId });
    if (!row) throw new CatalogFailure("not_found", "not found");
    const transactions = this.db.collection<{ workspaceId: string; categoryId?: string | null }>("transactions");
    const lines = this.db.collection<{ _id: string; workspaceId: string; budgetId: string; categoryId: string; amountMinor: unknown }>("budget_lines");
    const months = this.db.collection<{ _id: string; workspaceId: string; lines?: { categoryId: string; amountMinor: unknown }[] }>("month_budgets");
    const children = await this.catalog.categories.countDocuments({ workspaceId, parentId: categoryId });
    if (children) throw new CatalogFailure("bad_request", "Move or delete its subcategories first.");
    const used =
      (await transactions.countDocuments({ workspaceId, categoryId })) +
      (await lines.countDocuments({ workspaceId, categoryId })) +
      (await months.countDocuments({ workspaceId, "lines.categoryId": categoryId } as never));
    const moveTo = typeof body.moveTo === "string" && body.moveTo ? body.moveTo : null;
    if (used && !moveTo) throw new CatalogFailure("bad_request", "This category is in use. Choose where its records should move.");
    if (moveTo) {
      if (moveTo === categoryId) throw new CatalogFailure("bad_request", "Choose a different category to move to.");
      const target = await this.catalog.categories.findOne({ _id: moveTo, workspaceId });
      if (!target) throw new CatalogFailure("bad_request", "Unknown category to move to.");
      if (target.kind !== row.kind) throw new CatalogFailure("bad_request", "Move to a category of the same type (spending or income).");
      await transactions.updateMany({ workspaceId, categoryId }, { $set: { categoryId: moveTo } });
      // Old per-budget lines: one line per category per budget, so merge into an existing line when there is one.
      for (const line of await lines.find({ workspaceId, categoryId }).toArray()) {
        const existing = await lines.findOne({ workspaceId, budgetId: line.budgetId, categoryId: moveTo });
        if (existing) {
          const sum = this.minor(existing.amountMinor) + this.minor(line.amountMinor);
          await lines.updateOne({ _id: existing._id }, { $set: { amountMinor: sum } });
          await lines.deleteOne({ _id: line._id });
        } else {
          await lines.updateOne({ _id: line._id }, { $set: { categoryId: moveTo } });
        }
      }
      for (const m of await months.find({ workspaceId, "lines.categoryId": categoryId } as never).toArray()) {
        const merged = new Map<string, bigint>();
        for (const l of m.lines ?? []) {
          const id = l.categoryId === categoryId ? moveTo : l.categoryId;
          merged.set(id, (merged.get(id) ?? 0n) + this.minor(l.amountMinor));
        }
        await months.updateOne({ _id: m._id }, { $set: { lines: [...merged.entries()].map(([id, amountMinor]) => ({ categoryId: id, amountMinor })) } });
      }
    }
    await this.catalog.categories.deleteOne({ _id: categoryId, workspaceId });
    return { status: "ok" as const, data: { id: categoryId, movedTo: moveTo }, error: null };
  }

  private minor(value: unknown): bigint {
    return parseMoney(nairaOrNull(value as never) ?? "0.00", "NGN").amountMinor;
  }
}

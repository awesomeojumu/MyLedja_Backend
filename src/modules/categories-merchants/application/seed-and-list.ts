import { Inject, Injectable } from "@nestjs/common";
import { Db } from "mongodb";
import { newId } from "@/common/ids";
import { formatMoney, money, parseMoney } from "@/common/money/money";
import { nairaOrNull } from "@/common/money/naira-or-null";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";
import { CatalogFailure } from "@/modules/categories-merchants/domain/catalog-failure";
import { CatalogRepository } from "@/modules/categories-merchants/repositories/catalog.repository";
import { DEFAULT_CATEGORIES } from "@/modules/categories-merchants/schemas/catalog";
import { weekBounds, zonedInstant } from "@/modules/calendar/period";

@Injectable()
export class SeedAndListCategories {
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly memberships: ResolveMembership,
    private readonly workspaces: WorkspacesRepository,
    @Inject(MONGO_DB) private readonly db: Db,
  ) {}

  async list(userId: string, workspaceId: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    let rows = await this.catalog.categories.find({ workspaceId }).toArray();
    if (rows.length === 0) {
      const docs = DEFAULT_CATEGORIES.map((row) => ({
        _id: newId(),
        workspaceId,
        name: row.name,
        kind: row.kind,
        parentId: null as string | null,
        monthlyBudgetMinor: null as bigint | null,
      }));
      if (docs.length) await this.catalog.categories.insertMany(docs);
      rows = docs;
      const progress = (await this.workspaces.findById(workspaceId))?.setupProgress;
      await this.workspaces.patchSetup(workspaceId, {
        setupProgress: {
          currency: progress?.currency ?? false,
          firstAccount: progress?.firstAccount ?? false,
          opening: progress?.opening ?? false,
          categories: true,
          firstTransaction: progress?.firstTransaction ?? false,
        },
      });
    }
    return {
      status: "ok" as const,
      data: rows.map((row) => ({
        id: row._id,
        name: row.name,
        kind: row.kind,
        parentId: row.parentId,
        monthlyBudget: nairaOrNull(row.monthlyBudgetMinor),
      })),
      error: null,
    };
  }

  async create(
    userId: string,
    workspaceId: string,
    input: { name: string; kind: "income" | "expense"; parentId?: string | null; monthlyBudget?: string | null },
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = await this.catalog.categories.findOne({ _id: parentId, workspaceId });
      if (!parent) throw new CatalogFailure("bad_request", "Unknown parent category.");
      if (parent.parentId) throw new CatalogFailure("bad_request", "Subcategories cannot have children.");
      if (parent.kind !== input.kind) throw new CatalogFailure("bad_request", "Subcategory type must match its parent.");
    }
    const monthlyBudgetMinor = input.monthlyBudget && input.monthlyBudget.trim() ? parseMoney(input.monthlyBudget, "NGN").amountMinor : null;
    const doc = { _id: newId(), workspaceId, name: input.name.trim(), kind: input.kind, parentId, monthlyBudgetMinor };
    if (!doc.name) throw new CatalogFailure("bad_request", "Name this category.");
    await this.catalog.categories.insertOne(doc);
    return {
      status: "ok" as const,
      data: {
        id: doc._id,
        name: doc.name,
        kind: doc.kind,
        parentId: doc.parentId,
        monthlyBudget: nairaOrNull(doc.monthlyBudgetMinor),
      },
      error: null,
    };
  }

  async get(userId: string, workspaceId: string, categoryId: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const row = await this.catalog.categories.findOne({ _id: categoryId, workspaceId });
    if (!row) throw new CatalogFailure("not_found", "not found");
    const now = new Date();
    const workspace = await this.workspaces.findById(workspaceId);
    const weekStartsOn = workspace?.weekStartsOn ?? "monday";
    const timezone = workspace?.timezone ?? "Africa/Lagos";
    const lines = await this.db.collection("budget_lines").find({ workspaceId, categoryId }).toArray();
    const budgetIds = lines.map((line) => String(line.budgetId));
    const budgets = budgetIds.length
      ? await this.db
          .collection<{ _id: string; workspaceId: string; primaryPeriod?: string }>("budgets")
          .find({ workspaceId, _id: { $in: budgetIds } })
          .toArray()
      : [];
    const period =
      budgets.find((budget) => budget.primaryPeriod === "month")?.primaryPeriod ??
      budgets[0]?.primaryPeriod ??
      "month";
    const open = budgets.filter((budget) => String(budget.primaryPeriod ?? "month") === String(period));
    const openIds = new Set(open.map((budget) => String(budget._id)));
    const plannedLines = openIds.size ? lines.filter((line) => openIds.has(String(line.budgetId))) : lines;
    const fromBudgetLines = plannedLines.reduce(
      (sum, line) => sum + parseMoney(nairaOrNull(line.amountMinor) ?? "0.00", "NGN").amountMinor,
      0n,
    );
    const plannedMinor = row.monthlyBudgetMinor != null && row.monthlyBudgetMinor > 0n ? row.monthlyBudgetMinor : fromBudgetLines;

    const bounds = this.periodWindow(String(period), zonedInstant(now, timezone), weekStartsOn);
    const txns = await this.db.collection("transactions").find({ workspaceId, categoryId, status: "posted" }).toArray();
    let spentMinor = 0n;
    for (const txn of txns) {
      const at = zonedInstant(new Date((txn.occurredAt as Date) ?? (txn.createdAt as Date)), timezone);
      if (at < bounds.from || at > bounds.to) continue;
      if (txn.type === "expense") spentMinor += parseMoney(nairaOrNull(txn.amountMinor) ?? "0.00", "NGN").amountMinor;
      if (txn.type === "refund") spentMinor -= parseMoney(nairaOrNull(txn.amountMinor) ?? "0.00", "NGN").amountMinor;
    }
    if (spentMinor < 0n) spentMinor = 0n;
    const remainingMinor = plannedMinor - spentMinor;
    return {
      status: "ok" as const,
      data: {
        id: row._id,
        name: row.name,
        kind: row.kind,
        parentId: row.parentId,
        budgetId: open[0] ? String(open[0]._id) : null,
        periodFrom: bounds.from.toISOString(),
        periodTo: bounds.to.toISOString(),
        planned: formatMoney(money(plannedMinor, "NGN")),
        spent: formatMoney(money(spentMinor, "NGN")),
        remaining: formatMoney(money(remainingMinor, "NGN")),
        monthlyBudget: nairaOrNull(row.monthlyBudgetMinor),
      },
      error: null,
    };
  }

  private periodWindow(period: string, now: Date, weekStartsOn: "monday" | "sunday") {
    const dayFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (period === "day") return { from: dayFrom, to: new Date(dayFrom.getTime() + 86400000 - 1) };
    if (period === "week") return weekBounds(now, weekStartsOn);
    if (period === "year") {
      return {
        from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
        to: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1) - 1),
      };
    }
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1),
    };
  }

  async update(
    userId: string,
    workspaceId: string,
    categoryId: string,
    input: { name?: string; parentId?: string | null; kind?: string; monthlyBudget?: string | null },
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    const row = await this.catalog.categories.findOne({ _id: categoryId, workspaceId });
    if (!row) throw new CatalogFailure("not_found", "not found");
    if (input.kind && input.kind !== row.kind) {
      const used = await this.db.collection("transactions").findOne({ workspaceId, categoryId, status: "posted" });
      if (used) throw new CatalogFailure("bad_request", "Kind cannot change after posted spend.");
    }
    const kind = input.kind === "income" || input.kind === "expense" ? input.kind : row.kind;
    let parentId = input.parentId === undefined ? row.parentId : input.parentId;
    if (parentId === categoryId) throw new CatalogFailure("bad_request", "A category cannot be its own parent.");
    if (parentId) {
      const parent = await this.catalog.categories.findOne({ _id: String(parentId), workspaceId });
      if (!parent) throw new CatalogFailure("bad_request", "Unknown parent category.");
      if (parent.parentId) throw new CatalogFailure("bad_request", "Subcategories cannot have children.");
      if (parent.kind !== kind) throw new CatalogFailure("bad_request", "Subcategory type must match its parent.");
    } else {
      parentId = null;
    }
    const next: Record<string, unknown> = {
      name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : row.name,
      parentId: parentId ?? null,
      kind,
    };
    if (input.monthlyBudget !== undefined) {
      next.monthlyBudgetMinor = input.monthlyBudget && input.monthlyBudget.trim() ? parseMoney(input.monthlyBudget, "NGN").amountMinor : null;
    }
    await this.catalog.categories.updateOne({ _id: categoryId, workspaceId }, { $set: next });
    const updated = await this.catalog.categories.findOne({ _id: categoryId, workspaceId });
    return {
      status: "ok" as const,
      data: {
        id: categoryId,
        name: updated?.name,
        kind: updated?.kind,
        parentId: updated?.parentId,
        monthlyBudget: nairaOrNull(updated?.monthlyBudgetMinor),
      },
      error: null,
    };
  }
}

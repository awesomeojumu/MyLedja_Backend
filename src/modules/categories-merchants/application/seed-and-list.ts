import { Injectable } from "@nestjs/common";
import { newId } from "@/common/ids";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";
import { CatalogFailure } from "@/modules/categories-merchants/domain/catalog-failure";
import { CatalogRepository } from "@/modules/categories-merchants/repositories/catalog.repository";
import { DEFAULT_CATEGORIES } from "@/modules/categories-merchants/schemas/catalog";

@Injectable()
export class SeedAndListCategories {
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly memberships: ResolveMembership,
    private readonly workspaces: WorkspacesRepository,
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
    return { status: "ok" as const, data: rows.map((row) => ({ id: row._id, name: row.name, kind: row.kind, parentId: row.parentId })), error: null };
  }

  async create(
    userId: string,
    workspaceId: string,
    input: { name: string; kind: "income" | "expense"; parentId?: string | null },
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
    const doc = { _id: newId(), workspaceId, name: input.name.trim(), kind: input.kind, parentId };
    if (!doc.name) throw new CatalogFailure("bad_request", "Name this category.");
    await this.catalog.categories.insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id, name: doc.name, kind: doc.kind, parentId: doc.parentId }, error: null };
  }
}

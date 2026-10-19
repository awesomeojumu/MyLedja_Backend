import { Injectable } from "@nestjs/common";
import { newId } from "@/common/ids";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { CatalogFailure } from "@/modules/categories-merchants/domain/catalog-failure";
import { CatalogRepository } from "@/modules/categories-merchants/repositories/catalog.repository";

@Injectable()
export class MerchantsAndTags {
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async createMerchant(
    userId: string,
    workspaceId: string,
    input: { name: string; categoryId: string; aliases: string[] },
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    if (!input.name.trim()) throw new CatalogFailure("bad_request", "Name this merchant.");
    const doc = {
      _id: newId(),
      workspaceId,
      name: input.name.trim(),
      categoryId: input.categoryId,
      aliases: input.aliases.map((a) => a.trim()).filter(Boolean),
    };
    await this.catalog.merchants.insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id, name: doc.name, categoryId: doc.categoryId, aliases: doc.aliases }, error: null };
  }

  async createTag(userId: string, workspaceId: string, name: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) throw new CatalogFailure("bad_request", "Name this tag.");
    const doc = { _id: newId(), workspaceId, name: trimmed };
    await this.catalog.tags.insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id, name: doc.name }, error: null };
  }

  async listMerchants(userId: string, workspaceId: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const rows = await this.catalog.merchants.find({ workspaceId }).toArray();
    return {
      status: "ok" as const,
      data: rows.map((row) => ({ id: row._id, name: row.name, categoryId: row.categoryId, aliases: row.aliases })),
      error: null,
    };
  }

  async getMerchant(userId: string, workspaceId: string, merchantId: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const row = await this.catalog.merchants.findOne({ _id: merchantId, workspaceId });
    if (!row) throw new CatalogFailure("not_found", "not found");
    return {
      status: "ok" as const,
      data: { id: row._id, name: row.name, categoryId: row.categoryId, aliases: row.aliases },
      error: null,
    };
  }

  async updateMerchant(
    userId: string,
    workspaceId: string,
    merchantId: string,
    input: { name?: string; categoryId?: string; aliases?: string[] },
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    const row = await this.catalog.merchants.findOne({ _id: merchantId, workspaceId });
    if (!row) throw new CatalogFailure("not_found", "not found");
    const next = {
      name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : row.name,
      categoryId: typeof input.categoryId === "string" ? input.categoryId : row.categoryId,
      aliases: Array.isArray(input.aliases) ? input.aliases.map((a) => a.trim()).filter(Boolean) : row.aliases,
    };
    await this.catalog.merchants.updateOne({ _id: merchantId, workspaceId }, { $set: next });
    return { status: "ok" as const, data: { id: merchantId, ...next }, error: null };
  }

  async listTags(userId: string, workspaceId: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const rows = await this.catalog.tags.find({ workspaceId }).toArray();
    return { status: "ok" as const, data: rows.map((row) => ({ id: row._id, name: row.name })), error: null };
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { normalizeDescription } from "@/modules/categories-merchants/domain/aliases";
import { TRANSACTIONS_COLLECTION } from "@/modules/transactions/schemas/transaction";

@Injectable()
export class PreviewRule {
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(
    userId: string,
    workspaceId: string,
    match: { descriptionContains?: string; merchantId?: string; alias?: string },
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const rows = await this.db
      .collection<{ _id: string; status: string; description: string; merchantId?: string }>(TRANSACTIONS_COLLECTION)
      .find({ workspaceId, status: "posted" })
      .toArray();
    const needle = match.descriptionContains
      ? normalizeDescription(match.descriptionContains)
      : match.alias
        ? normalizeDescription(match.alias)
        : "";
    const ids = rows
      .filter((row) => {
        if (match.merchantId) return row.merchantId === match.merchantId;
        if (!needle) return false;
        return normalizeDescription(row.description).includes(needle);
      })
      .map((row) => row._id);
    return { status: "ok" as const, data: { transactionIds: ids }, error: null };
  }
}

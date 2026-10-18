import { Inject, Injectable } from "@nestjs/common";
import { Db } from "mongodb";
import { formatMoney, money } from "@/common/money/money";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { AccountFailure } from "@/modules/accounts/domain/account-failure";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";
import {
  RECONCILIATION_EVENTS_COLLECTION,
  ReconciliationEventDoc,
} from "@/modules/accounts/schemas/account";

@Injectable()
export class ListReconciliations {
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly accounts: AccountsRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(userId: string, workspaceId: string, accountId: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const current = await this.accounts.findById(workspaceId, accountId);
    if (!current) throw new AccountFailure("not_found", "not found");
    const rows = await this.db
      .collection<ReconciliationEventDoc>(RECONCILIATION_EVENTS_COLLECTION)
      .find({ workspaceId, accountId })
      .sort({ at: -1 })
      .toArray();
    return {
      status: "ok" as const,
      data: rows.map((row) => {
        const difference = row.calculatedMinor - row.externalMinor;
        const abs = difference < 0n ? -difference : difference;
        return {
          at: row.at.toISOString(),
          external: formatMoney(money(row.externalMinor, current.currency)),
          calculated: formatMoney(money(row.calculatedMinor, current.currency)),
          difference: formatMoney(money(abs, current.currency)),
          reconciled: difference === 0n,
        };
      }),
      error: null,
    };
  }
}

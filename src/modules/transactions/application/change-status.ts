import { Injectable } from "@nestjs/common";
import { MongoClient } from "mongodb";
import { Inject } from "@nestjs/common";
import { MONGO_CLIENT } from "@/database/mongo/mongo.constants";
import { runInTransaction } from "@/database/mongo/transaction";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { LedgerFailure } from "@/modules/transactions/domain/ledger-failure";
import { TransactionsRepository } from "@/modules/transactions/repositories/transactions.repository";
import { LedgerStatus } from "@/modules/transactions/schemas/transaction";
import { publicTransaction } from "@/modules/transactions/application/public-transaction";

const ALLOWED: Record<LedgerStatus, LedgerStatus[]> = {
  pending: ["posted", "voided"],
  posted: ["reversed", "voided"],
  reversed: [],
  voided: [],
};

@Injectable()
export class ChangeStatus {
  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    private readonly txns: TransactionsRepository,
    private readonly accounts: AccountsRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(userId: string, workspaceId: string, id: string, status: LedgerStatus) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    const current = await this.txns.findById(workspaceId, id);
    if (!current) throw new LedgerFailure("not_found", "not found");
    if (!ALLOWED[current.status].includes(status)) {
      throw new LedgerFailure("bad_request", "That status change is not allowed.");
    }
    await runInTransaction(this.client, async (session) => {
      if (current.status === "posted" && status !== "posted") {
        for (const effect of current.effects) {
          await this.accounts.addBalance(effect.accountId, -effect.amountMinor, session);
        }
      }
      if (current.status !== "posted" && status === "posted") {
        for (const effect of current.effects) {
          await this.accounts.addBalance(effect.accountId, effect.amountMinor, session);
        }
      }
      await this.txns.setStatus(workspaceId, id, status, current.version + 1);
    });
    return { status: "ok" as const, data: publicTransaction({ ...current, status, version: current.version + 1 }), error: null };
  }
}

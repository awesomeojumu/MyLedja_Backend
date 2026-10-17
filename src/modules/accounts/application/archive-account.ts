import { Injectable } from "@nestjs/common";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { AccountFailure } from "@/modules/accounts/domain/account-failure";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";
import { publicAccount } from "@/modules/accounts/application/public-account";

@Injectable()
export class ArchiveAccount {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(userId: string, workspaceId: string, accountId: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    const current = await this.accounts.findById(workspaceId, accountId);
    if (!current) throw new AccountFailure("not_found", "not found");
    const archivedAt = current.archivedAt ?? new Date();
    await this.accounts.archive(workspaceId, accountId, archivedAt);
    return { status: "ok" as const, data: publicAccount({ ...current, archivedAt }), error: null };
  }
}

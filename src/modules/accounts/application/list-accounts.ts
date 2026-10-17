import { Injectable } from "@nestjs/common";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";
import { publicAccount } from "@/modules/accounts/application/public-account";

@Injectable()
export class ListAccounts {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(userId: string, workspaceId: string, archived: boolean) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const rows = await this.accounts.list(workspaceId, archived);
    return { status: "ok" as const, data: rows.map(publicAccount), error: null };
  }
}

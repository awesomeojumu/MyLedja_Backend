import { Injectable } from "@nestjs/common";
import { parseMoney } from "@/common/money/money";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";
import { AccountFailure } from "@/modules/accounts/domain/account-failure";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";
import { publicAccount } from "@/modules/accounts/application/public-account";

@Injectable()
export class SetOpening {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly memberships: ResolveMembership,
    private readonly workspaces: WorkspacesRepository,
  ) {}

  async execute(userId: string, workspaceId: string, accountId: string, opening: string) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    const current = await this.accounts.findById(workspaceId, accountId);
    if (!current) throw new AccountFailure("not_found", "not found");
    const next = parseMoney(opening, current.currency);
    const posted = current.balanceMinor - current.openingBalanceMinor;
    const balanceMinor = next.amountMinor + posted;
    await this.accounts.setOpening(workspaceId, accountId, next.amountMinor, balanceMinor);
    const progress = (await this.workspaces.findById(workspaceId))?.setupProgress;
    await this.workspaces.patchSetup(workspaceId, {
      setupProgress: {
        currency: progress?.currency ?? false,
        firstAccount: progress?.firstAccount ?? true,
        opening: true,
        categories: progress?.categories ?? false,
        firstTransaction: progress?.firstTransaction ?? false,
      },
    });
    return {
      status: "ok" as const,
      data: publicAccount({ ...current, openingBalanceMinor: next.amountMinor, balanceMinor }),
      error: null,
    };
  }
}

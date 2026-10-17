import { Injectable } from "@nestjs/common";
import { newId } from "@/common/ids";
import { parseMoney } from "@/common/money/money";
import { loadConfig } from "@/config/env";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";
import { encryptAccountNumber } from "@/modules/accounts/domain/account-number";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";
import { publicAccount } from "@/modules/accounts/application/public-account";

@Injectable()
export class CreateAccount {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly memberships: ResolveMembership,
    private readonly workspaces: WorkspacesRepository,
  ) {}

  async execute(
    userId: string,
    workspaceId: string,
    input: {
      name: string;
      kind: "bank" | "wallet" | "cash" | "savings" | "liability" | "receivable";
      institutionId: string | null;
      connectionType: "manual" | "linked" | "imported";
      currency: string;
      opening: string;
      accountNumber?: string;
    },
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "write_records");
    const opening = parseMoney(input.opening, input.currency);
    const now = new Date();
    let cipher: ReturnType<typeof encryptAccountNumber> | undefined;
    if (input.accountNumber) {
      cipher = encryptAccountNumber(input.accountNumber, loadConfig().accountNumberKey);
    }
    const doc = {
      _id: newId(),
      workspaceId,
      name: input.name,
      kind: input.kind,
      institutionId: input.institutionId,
      connectionType: input.connectionType,
      currency: input.currency,
      openingBalanceMinor: opening.amountMinor,
      balanceMinor: opening.amountMinor,
      accountNumberCipher: cipher?.cipher,
      accountNumberIv: cipher?.iv,
      accountNumberTag: cipher?.tag,
      mask: cipher?.mask,
      archivedAt: null,
      createdAt: now,
    };
    await this.accounts.insert(doc);
    const progress = (await this.workspaces.findById(workspaceId))?.setupProgress;
    await this.workspaces.patchSetup(workspaceId, {
      setupProgress: {
        currency: progress?.currency ?? false,
        firstAccount: true,
        opening: progress?.opening ?? opening.amountMinor !== 0n,
        categories: progress?.categories ?? false,
        firstTransaction: progress?.firstTransaction ?? false,
      },
    });
    return { status: "ok" as const, data: publicAccount(doc), error: null };
  }
}

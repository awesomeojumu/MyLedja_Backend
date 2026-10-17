import { Injectable } from "@nestjs/common";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { EMPTY_SETUP, SetupProgress } from "@/modules/workspaces/schemas/workspace";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";

@Injectable()
export class PatchSetup {
  constructor(
    private readonly workspaces: WorkspacesRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(
    userId: string,
    workspaceId: string,
    input: { defaultCurrency?: string; setupProgress?: Partial<SetupProgress> },
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "update_workspace");
    const current = await this.workspaces.findById(workspaceId);
    const setupProgress = { ...(current?.setupProgress ?? EMPTY_SETUP), ...input.setupProgress };
    await this.workspaces.patchSetup(workspaceId, {
      ...(input.defaultCurrency ? { defaultCurrency: input.defaultCurrency } : {}),
      setupProgress,
    });
    return {
      status: "ok" as const,
      data: { id: workspaceId, defaultCurrency: input.defaultCurrency ?? current?.defaultCurrency ?? "NGN", setupProgress },
      error: null,
    };
  }
}

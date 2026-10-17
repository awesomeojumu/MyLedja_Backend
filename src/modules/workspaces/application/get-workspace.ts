import { Injectable } from "@nestjs/common";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";

@Injectable()
export class GetWorkspace {
  constructor(
    private readonly workspaces: WorkspacesRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(
    userId: string,
    workspaceId: string,
  ) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const workspace = await this.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new WorkspaceFailure("not_found", "not found");
    }
    return {
      id: workspace._id,
      name: workspace.name,
      role: membership.role,
      defaultCurrency: workspace.defaultCurrency ?? "NGN",
      setupProgress: workspace.setupProgress,
    };
  }
}

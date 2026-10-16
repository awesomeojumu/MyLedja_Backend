import { Injectable } from "@nestjs/common";
import { requireCapability } from "../domain/capabilities";
import { WorkspaceFailure, WorkspaceRole } from "../domain/roles";
import { ResolveMembership } from "../policies/resolve-membership";
import { WorkspacesRepository } from "../repositories/workspaces.repository";

@Injectable()
export class GetWorkspace {
  constructor(
    private readonly workspaces: WorkspacesRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(
    userId: string,
    workspaceId: string,
  ): Promise<{ id: string; name: string; role: WorkspaceRole }> {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "view");
    const workspace = await this.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new WorkspaceFailure("not_found", "not found");
    }
    return { id: workspace._id, name: workspace.name, role: membership.role };
  }
}

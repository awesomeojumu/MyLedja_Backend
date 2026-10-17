import { Injectable } from "@nestjs/common";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { WorkspaceRole } from "@/modules/workspaces/domain/roles";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";

@Injectable()
export class UpdateWorkspace {
  constructor(
    private readonly workspaces: WorkspacesRepository,
    private readonly memberships: ResolveMembership,
  ) {}

  async execute(
    userId: string,
    workspaceId: string,
    name: string,
  ): Promise<{ id: string; name: string; role: WorkspaceRole }> {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, "update_workspace");
    await this.workspaces.updateName(workspaceId, name);
    return { id: workspaceId, name, role: membership.role };
  }
}

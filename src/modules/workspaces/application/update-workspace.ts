import { Injectable } from "@nestjs/common";
import { requireCapability } from "../domain/capabilities";
import { WorkspaceRole } from "../domain/roles";
import { ResolveMembership } from "../policies/resolve-membership";
import { WorkspacesRepository } from "../repositories/workspaces.repository";

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

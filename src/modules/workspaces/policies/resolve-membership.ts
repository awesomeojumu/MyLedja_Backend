import { Injectable } from "@nestjs/common";
import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";
import { MembershipsRepository } from "@/modules/workspaces/repositories/memberships.repository";
import { MembershipDoc } from "@/modules/workspaces/schemas/membership";

@Injectable()
export class ResolveMembership {
  constructor(private readonly memberships: MembershipsRepository) {}

  async execute(userId: string, workspaceId: string): Promise<MembershipDoc> {
    const membership = await this.memberships.find(workspaceId, userId);
    if (!membership) {
      throw new WorkspaceFailure("not_found", "not found");
    }
    return membership;
  }
}

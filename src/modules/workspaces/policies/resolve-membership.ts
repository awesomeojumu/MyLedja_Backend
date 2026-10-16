import { Injectable } from "@nestjs/common";
import { WorkspaceFailure } from "../domain/roles";
import { MembershipsRepository } from "../repositories/memberships.repository";
import { MembershipDoc } from "../schemas/membership";

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

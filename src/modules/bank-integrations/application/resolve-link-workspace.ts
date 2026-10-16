import { Injectable } from "@nestjs/common";
import { MembershipsRepository } from "../../workspaces/repositories/memberships.repository";
import { MonoFailure } from "../domain/mono-failure";

@Injectable()
export class ResolveLinkWorkspace {
  constructor(private readonly memberships: MembershipsRepository) {}

  async execute(userId: string, workspaceId?: string): Promise<string> {
    if (workspaceId) {
      const membership = await this.memberships.find(workspaceId, userId);
      if (!membership) {
        throw new MonoFailure("not_found", "not found");
      }
      return workspaceId;
    }
    const list = await this.memberships.listForUser(userId);
    const first = list[0];
    if (!first) {
      throw new MonoFailure("not_found", "not found");
    }
    return first.workspaceId;
  }
}

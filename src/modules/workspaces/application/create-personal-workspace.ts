import { Injectable } from "@nestjs/common";
import { newId } from "../../../common/ids";
import { ClientSession } from "mongodb";
import { MembershipsRepository } from "../repositories/memberships.repository";
import { WorkspacesRepository } from "../repositories/workspaces.repository";

@Injectable()
export class CreatePersonalWorkspace {
  constructor(
    private readonly workspaces: WorkspacesRepository,
    private readonly memberships: MembershipsRepository,
  ) {}

  async execute(userId: string, session?: ClientSession): Promise<{ workspaceId: string }> {
    const now = new Date();
    const workspaceId = newId();
    await this.workspaces.insert(
      {
        _id: workspaceId,
        name: "Personal",
        kind: "personal",
        ownerId: userId,
        createdAt: now,
      },
      session,
    );
    await this.memberships.insert(
      {
        _id: newId(),
        workspaceId,
        userId,
        role: "owner",
        createdAt: now,
      },
      session,
    );
    return { workspaceId };
  }
}

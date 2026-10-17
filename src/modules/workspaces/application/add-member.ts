import { Inject, Injectable } from "@nestjs/common";
import { MongoClient } from "mongodb";
import { newId } from "@/common/ids";
import { MONGO_CLIENT } from "@/database/mongo/mongo.constants";
import { runInTransaction } from "@/database/mongo/transaction";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { WorkspaceFailure, WorkspaceRole } from "@/modules/workspaces/domain/roles";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { AuditEventsRepository } from "@/modules/workspaces/repositories/audit-events.repository";
import { MembershipsRepository } from "@/modules/workspaces/repositories/memberships.repository";

@Injectable()
export class AddMember {
  constructor(
    @Inject(MONGO_CLIENT) private readonly mongo: MongoClient,
    private readonly users: UsersRepository,
    private readonly memberships: MembershipsRepository,
    private readonly resolve: ResolveMembership,
    private readonly audit: AuditEventsRepository,
  ) {}

  async execute(
    actorId: string,
    workspaceId: string,
    userId: string,
    role: "editor" | "viewer",
  ): Promise<{ userId: string; role: WorkspaceRole }> {
    const actor = await this.resolve.execute(actorId, workspaceId);
    requireCapability(actor.role, "add_member");
    const user = await this.users.findById(userId);
    if (!user || !user.verifiedAt) {
      throw new WorkspaceFailure("not_found", "not found");
    }
    const existing = await this.memberships.find(workspaceId, userId);
    if (existing) {
      throw new WorkspaceFailure("bad_request", "already a member");
    }
    const now = new Date();
    await runInTransaction(this.mongo, async (session) => {
      await this.memberships.insert({ _id: newId(), workspaceId, userId, role, createdAt: now }, session);
      await this.audit.insert(
        {
          _id: newId(),
          workspaceId,
          actorId,
          action: "member_added",
          targetUserId: userId,
          fromRole: null,
          toRole: role,
          createdAt: now,
        },
        session,
      );
    });
    return { userId, role };
  }
}

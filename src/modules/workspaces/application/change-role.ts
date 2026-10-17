import { Inject, Injectable } from "@nestjs/common";
import { MongoClient } from "mongodb";
import { newId } from "@/common/ids";
import { MONGO_CLIENT } from "@/database/mongo/mongo.constants";
import { runInTransaction } from "@/database/mongo/transaction";
import { canAssignRole, requireCapability } from "@/modules/workspaces/domain/capabilities";
import { WorkspaceFailure, WorkspaceRole } from "@/modules/workspaces/domain/roles";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { AuditEventsRepository } from "@/modules/workspaces/repositories/audit-events.repository";
import { MembershipsRepository } from "@/modules/workspaces/repositories/memberships.repository";

@Injectable()
export class ChangeRole {
  constructor(
    @Inject(MONGO_CLIENT) private readonly mongo: MongoClient,
    private readonly memberships: MembershipsRepository,
    private readonly resolve: ResolveMembership,
    private readonly audit: AuditEventsRepository,
  ) {}

  /** The role change and its audit event commit together or not at all. */
  async execute(
    actorId: string,
    workspaceId: string,
    targetUserId: string,
    nextRole: "editor" | "viewer",
  ): Promise<{ userId: string; fromRole: WorkspaceRole; toRole: WorkspaceRole }> {
    const actor = await this.resolve.execute(actorId, workspaceId);
    requireCapability(actor.role, "change_role");
    const target = await this.memberships.find(workspaceId, targetUserId);
    if (!target) {
      throw new WorkspaceFailure("not_found", "not found");
    }
    if (!canAssignRole(actor.role, target.role, nextRole)) {
      throw new WorkspaceFailure("forbidden", "forbidden");
    }
    await runInTransaction(this.mongo, async (session) => {
      await this.memberships.setRole(workspaceId, targetUserId, nextRole, session);
      await this.audit.insert(
        {
          _id: newId(),
          workspaceId,
          actorId,
          action: "role_change",
          targetUserId,
          fromRole: target.role,
          toRole: nextRole,
          createdAt: new Date(),
        },
        session,
      );
    });
    return { userId: targetUserId, fromRole: target.role, toRole: nextRole };
  }
}

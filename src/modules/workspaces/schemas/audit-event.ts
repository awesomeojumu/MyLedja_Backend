import { WorkspaceRole } from "../domain/roles";

export const AUDIT_EVENTS_COLLECTION = "audit_events";

/** Never holds credentials, tokens or financial payloads (§17.1). */
export interface AuditEventDoc {
  _id: string;
  workspaceId: string;
  actorId: string;
  action: "member_added" | "role_change";
  targetUserId: string;
  fromRole: WorkspaceRole | null;
  toRole: WorkspaceRole;
  createdAt: Date;
}

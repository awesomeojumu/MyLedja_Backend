import { WorkspaceRole } from "@/modules/workspaces/domain/roles";

export const MEMBERSHIPS_COLLECTION = "memberships";

export interface MembershipDoc {
  _id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
}

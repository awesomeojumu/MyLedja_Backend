import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";

export interface AddMemberInput {
  userId: string;
  role: "editor" | "viewer";
}

export function parseAddMember(body: unknown): AddMemberInput {
  if (!body || typeof body !== "object") {
    throw new WorkspaceFailure("bad_request", "userId and role are required");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.userId !== "string" || record.userId.length === 0) {
    throw new WorkspaceFailure("bad_request", "userId is required");
  }
  if (record.role !== "editor" && record.role !== "viewer") {
    throw new WorkspaceFailure("bad_request", "role must be editor or viewer");
  }
  return { userId: record.userId, role: record.role };
}

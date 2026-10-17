import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";

export interface ChangeRoleInput {
  role: "editor" | "viewer";
}

export function parseChangeRole(body: unknown): ChangeRoleInput {
  if (!body || typeof body !== "object") {
    throw new WorkspaceFailure("bad_request", "role is required");
  }
  const record = body as Record<string, unknown>;
  if (record.role !== "editor" && record.role !== "viewer") {
    throw new WorkspaceFailure("bad_request", "role must be editor or viewer");
  }
  return { role: record.role };
}

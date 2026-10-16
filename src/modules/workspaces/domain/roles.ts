export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export class WorkspaceFailure extends Error {
  constructor(
    readonly status: "bad_request" | "not_found" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFailure";
  }
}

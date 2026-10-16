import { WorkspaceFailure, WorkspaceRole } from "./roles";

/** Role matrix from ADR-0005. Every workspace use case names one capability. */
export type Capability =
  | "view"
  | "update_workspace"
  | "add_member"
  | "change_role"
  | "remove_member"
  | "write_records"
  | "export_all"
  | "transfer_ownership"
  | "delete_workspace";

const MATRIX: Record<WorkspaceRole, readonly Capability[]> = {
  owner: [
    "view",
    "update_workspace",
    "add_member",
    "change_role",
    "remove_member",
    "write_records",
    "export_all",
    "transfer_ownership",
    "delete_workspace",
  ],
  admin: ["view", "update_workspace", "add_member", "change_role", "remove_member", "write_records"],
  editor: ["view", "write_records"],
  viewer: ["view"],
};

export function can(role: WorkspaceRole, capability: Capability): boolean {
  return MATRIX[role].includes(capability);
}

export function requireCapability(role: WorkspaceRole, capability: Capability): void {
  if (!can(role, capability)) {
    throw new WorkspaceFailure("forbidden", "forbidden");
  }
}

/**
 * Whether actor may move target to next. The owner role is never assigned or taken away here; it moves only
 * through ownership transfer. Admins manage editors and viewers only, and never create admins.
 */
export function canAssignRole(actor: WorkspaceRole, target: WorkspaceRole, next: WorkspaceRole): boolean {
  if (target === "owner" || next === "owner") return false;
  if (actor === "owner") return true;
  if (actor === "admin") {
    return (target === "editor" || target === "viewer") && (next === "editor" || next === "viewer");
  }
  return false;
}

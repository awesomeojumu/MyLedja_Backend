import { can, canAssignRole, Capability } from "../domain/capabilities";
import { WORKSPACE_ROLES } from "../domain/roles";

const MUTATIONS: Capability[] = [
  "update_workspace",
  "add_member",
  "change_role",
  "remove_member",
  "write_records",
  "export_all",
  "transfer_ownership",
  "delete_workspace",
];

describe("ADR-0005 role matrix", () => {
  it("lets every role view", () => {
    for (const role of WORKSPACE_ROLES) {
      expect(can(role, "view")).toBe(true);
    }
  });

  it("never lets a viewer mutate (TC-09)", () => {
    for (const capability of MUTATIONS) {
      expect(can("viewer", capability)).toBe(false);
    }
  });

  it("lets editors write records but not manage the workspace", () => {
    expect(can("editor", "write_records")).toBe(true);
    for (const capability of MUTATIONS.filter((c) => c !== "write_records")) {
      expect(can("editor", capability)).toBe(false);
    }
  });

  it("keeps export, ownership transfer and deletion with the owner", () => {
    for (const capability of ["export_all", "transfer_ownership", "delete_workspace"] as const) {
      expect(can("owner", capability)).toBe(true);
      expect(can("admin", capability)).toBe(false);
    }
  });

  it("never assigns or removes the owner role", () => {
    expect(canAssignRole("owner", "owner", "editor")).toBe(false);
    expect(canAssignRole("owner", "editor", "owner")).toBe(false);
  });

  it("lets admins manage only editors and viewers, and never create admins", () => {
    expect(canAssignRole("admin", "viewer", "editor")).toBe(true);
    expect(canAssignRole("admin", "editor", "viewer")).toBe(true);
    expect(canAssignRole("admin", "viewer", "admin")).toBe(false);
    expect(canAssignRole("admin", "admin", "viewer")).toBe(false);
  });

  it("refuses role changes from editors and viewers", () => {
    expect(canAssignRole("editor", "viewer", "editor")).toBe(false);
    expect(canAssignRole("viewer", "viewer", "editor")).toBe(false);
  });
});

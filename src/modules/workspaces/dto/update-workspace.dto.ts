import { WorkspaceFailure } from "../domain/roles";

export interface UpdateWorkspaceInput {
  name: string;
}

export function parseUpdateWorkspace(body: unknown): UpdateWorkspaceInput {
  if (!body || typeof body !== "object") {
    throw new WorkspaceFailure("bad_request", "name is required");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.name !== "string") {
    throw new WorkspaceFailure("bad_request", "name is required");
  }
  const name = record.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new WorkspaceFailure("bad_request", "name must be 1 to 80 characters");
  }
  return { name };
}

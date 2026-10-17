import { Injectable } from "@nestjs/common";
import { WorkspaceRole } from "@/modules/workspaces/domain/roles";
import { MembershipsRepository } from "@/modules/workspaces/repositories/memberships.repository";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: string;
  role: WorkspaceRole;
}

/** Only the caller's own memberships; nothing else is discoverable. */
@Injectable()
export class ListWorkspaces {
  constructor(
    private readonly workspaces: WorkspacesRepository,
    private readonly memberships: MembershipsRepository,
  ) {}

  async execute(userId: string): Promise<WorkspaceSummary[]> {
    const memberships = await this.memberships.listForUser(userId);
    const docs = await this.workspaces.findByIds(memberships.map((m) => m.workspaceId));
    const byId = new Map(docs.map((d) => [d._id, d]));
    return memberships.flatMap((m) => {
      const ws = byId.get(m.workspaceId);
      return ws ? [{ id: ws._id, name: ws.name, kind: ws.kind, role: m.role }] : [];
    });
  }
}

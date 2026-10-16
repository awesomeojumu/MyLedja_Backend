import { Module } from "@nestjs/common";
import { RequireAccessToken } from "../auth/policies/require-access-token";
import { SessionsRepository } from "../auth/repositories/sessions.repository";
import { UsersModule } from "../users/users.module";
import { AddMember } from "./application/add-member";
import { ChangeRole } from "./application/change-role";
import { CreatePersonalWorkspace } from "./application/create-personal-workspace";
import { GetWorkspace } from "./application/get-workspace";
import { ListWorkspaces } from "./application/list-workspaces";
import { UpdateWorkspace } from "./application/update-workspace";
import { WorkspacesController } from "./controllers/workspaces.controller";
import { ResolveMembership } from "./policies/resolve-membership";
import { AuditEventsRepository } from "./repositories/audit-events.repository";
import { MembershipsRepository } from "./repositories/memberships.repository";
import { WorkspacesRepository } from "./repositories/workspaces.repository";

@Module({
  imports: [UsersModule],
  controllers: [WorkspacesController],
  providers: [
    RequireAccessToken,
    SessionsRepository,
    WorkspacesRepository,
    MembershipsRepository,
    AuditEventsRepository,
    ResolveMembership,
    CreatePersonalWorkspace,
    GetWorkspace,
    UpdateWorkspace,
    AddMember,
    ChangeRole,
    ListWorkspaces,
  ],
  exports: [CreatePersonalWorkspace, WorkspacesRepository, MembershipsRepository, AuditEventsRepository],
})
export class WorkspacesModule {}

import { Module } from "@nestjs/common";
import { RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";
import { UsersModule } from "@/modules/users/users.module";
import { AddMember } from "@/modules/workspaces/application/add-member";
import { ChangeRole } from "@/modules/workspaces/application/change-role";
import { CreatePersonalWorkspace } from "@/modules/workspaces/application/create-personal-workspace";
import { GetWorkspace } from "@/modules/workspaces/application/get-workspace";
import { ListWorkspaces } from "@/modules/workspaces/application/list-workspaces";
import { PatchSetup } from "@/modules/workspaces/application/patch-setup";
import { UpdateWorkspace } from "@/modules/workspaces/application/update-workspace";
import { WorkspacesController } from "@/modules/workspaces/controllers/workspaces.controller";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { AuditEventsRepository } from "@/modules/workspaces/repositories/audit-events.repository";
import { MembershipsRepository } from "@/modules/workspaces/repositories/memberships.repository";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";

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
    PatchSetup,
  ],
  exports: [
    CreatePersonalWorkspace,
    WorkspacesRepository,
    MembershipsRepository,
    AuditEventsRepository,
    ResolveMembership,
  ],
})
export class WorkspacesModule {}

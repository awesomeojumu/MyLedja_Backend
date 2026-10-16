import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "../../auth/policies/require-access-token";
import { AddMember } from "../application/add-member";
import { ChangeRole } from "../application/change-role";
import { GetWorkspace } from "../application/get-workspace";
import { ListWorkspaces } from "../application/list-workspaces";
import { UpdateWorkspace } from "../application/update-workspace";
import { WorkspaceFailure } from "../domain/roles";
import { parseAddMember } from "../dto/add-member.dto";
import { parseChangeRole } from "../dto/change-role.dto";
import { parseUpdateWorkspace } from "../dto/update-workspace.dto";

const STATUS_CODE = {
  bad_request: 400,
  not_found: 404,
  forbidden: 403,
} as const;

function toHttp(error: unknown): never {
  if (error instanceof WorkspaceFailure) {
    throw new HttpException({ status: "error", error: error.message }, STATUS_CODE[error.status]);
  }
  throw error;
}

@Controller("workspaces")
@UseGuards(RequireAccessToken)
export class WorkspacesController {
  constructor(
    private readonly getWorkspace: GetWorkspace,
    private readonly updateWorkspace: UpdateWorkspace,
    private readonly addMember: AddMember,
    private readonly changeRole: ChangeRole,
    private readonly listWorkspaces: ListWorkspaces,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    try {
      return await this.listWorkspaces.execute(getAuth(req).userId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Get(":workspaceId")
  async get(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.getWorkspace.execute(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Patch(":workspaceId")
  async update(
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.updateWorkspace.execute(
        getAuth(req).userId,
        workspaceId,
        parseUpdateWorkspace(body).name,
      );
    } catch (error) {
      toHttp(error);
    }
  }

  @Post(":workspaceId/members")
  async members(
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      const input = parseAddMember(body);
      return await this.addMember.execute(getAuth(req).userId, workspaceId, input.userId, input.role);
    } catch (error) {
      toHttp(error);
    }
  }

  @Patch(":workspaceId/members/:userId")
  async role(
    @Param("workspaceId") workspaceId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.changeRole.execute(
        getAuth(req).userId,
        workspaceId,
        userId,
        parseChangeRole(body).role,
      );
    } catch (error) {
      toHttp(error);
    }
  }
}

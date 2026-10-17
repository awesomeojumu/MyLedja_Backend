import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { rec, toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class GoalsController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Post("workspaces/:workspaceId/goals")
  async create(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.createGoal(getAuth(req).userId, workspaceId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/goals")
  async list(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.listGoals(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/goals/:goalId/schedule")
  async schedule(@Param("workspaceId") workspaceId: string, @Param("goalId") goalId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.scheduleGoal(getAuth(req).userId, workspaceId, goalId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/goals/:goalId/allocate")
  async allocate(@Param("workspaceId") workspaceId: string, @Param("goalId") goalId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.allocateGoal(getAuth(req).userId, workspaceId, goalId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }
}

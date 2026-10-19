import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { rec, toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class BudgetsController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Post("workspaces/:workspaceId/budgets")
  async create(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.createBudget(getAuth(req).userId, workspaceId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/budgets")
  async list(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.listBudgets(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/budgets/:budgetId")
  async one(@Param("workspaceId") workspaceId: string, @Param("budgetId") budgetId: string, @Req() req: Request) {
    try {
      return await this.ops.budgetViews(getAuth(req).userId, workspaceId, budgetId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Patch("workspaces/:workspaceId/budgets/:budgetId")
  async patch(
    @Param("workspaceId") workspaceId: string,
    @Param("budgetId") budgetId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.patchBudget(getAuth(req).userId, workspaceId, budgetId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }
}

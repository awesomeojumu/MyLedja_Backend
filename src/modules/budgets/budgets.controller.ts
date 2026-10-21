import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
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

  /** Months that have a budget, newest first, with planned vs spent. */
  @Get("workspaces/:workspaceId/month-budgets")
  async history(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.monthHistory(getAuth(req).userId, workspaceId, Number((req.query as Record<string, string>).limit) || 6);
    } catch (error) {
      toHttp(error);
    }
  }

  /** A month's budget (YYYY-MM): income, set-asides from bills/goals/debts, the spending plan and live tracking. */
  @Get("workspaces/:workspaceId/month-budgets/:month")
  async month(@Param("workspaceId") workspaceId: string, @Param("month") month: string, @Req() req: Request) {
    try {
      return await this.ops.monthBudget(getAuth(req).userId, workspaceId, month);
    } catch (error) {
      toHttp(error);
    }
  }

  @Put("workspaces/:workspaceId/month-budgets/:month/lines")
  async monthLines(@Param("workspaceId") workspaceId: string, @Param("month") month: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.setMonthLines(getAuth(req).userId, workspaceId, month, rec(body));
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

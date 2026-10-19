import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { rec, toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class DebtsController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Post("workspaces/:workspaceId/debts")
  async create(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.createDebt(getAuth(req).userId, workspaceId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/debts")
  async list(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.listDebts(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/debts/:debtId")
  async one(@Param("workspaceId") workspaceId: string, @Param("debtId") debtId: string, @Req() req: Request) {
    try {
      return await this.ops.getDebt(getAuth(req).userId, workspaceId, debtId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Patch("workspaces/:workspaceId/debts/:debtId")
  async patch(
    @Param("workspaceId") workspaceId: string,
    @Param("debtId") debtId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.patchDebt(getAuth(req).userId, workspaceId, debtId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/debts/:debtId/:kind")
  async move(
    @Param("workspaceId") workspaceId: string,
    @Param("debtId") debtId: string,
    @Param("kind") kind: "borrow" | "repay" | "lend" | "collect",
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.debtMove(getAuth(req).userId, workspaceId, debtId, kind, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }
}

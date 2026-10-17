import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class DashboardController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Get("workspaces/:workspaceId/net-worth")
  async netWorth(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.netWorth(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/dashboard")
  async dashboard(
    @Param("workspaceId") workspaceId: string,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.dashboard(getAuth(req).userId, workspaceId, from, to);
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/search")
  async search(@Param("workspaceId") workspaceId: string, @Query("q") q: string, @Req() req: Request) {
    try {
      return await this.ops.search(getAuth(req).userId, workspaceId, q ?? "");
    } catch (error) {
      toHttp(error);
    }
  }
}

import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { rec, toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class IncomeController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Post("workspaces/:workspaceId/income-streams")
  async create(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.createStream(getAuth(req).userId, workspaceId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/income-streams")
  async list(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.listStreams(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/income-streams/:streamId/match")
  async match(
    @Param("workspaceId") workspaceId: string,
    @Param("streamId") streamId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.matchIncome(getAuth(req).userId, workspaceId, streamId, String(rec(body).transactionId));
    } catch (error) {
      toHttp(error);
    }
  }
}

import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
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

  @Get("workspaces/:workspaceId/income-streams/:streamId")
  async one(@Param("workspaceId") workspaceId: string, @Param("streamId") streamId: string, @Req() req: Request) {
    try {
      return await this.ops.getStream(getAuth(req).userId, workspaceId, streamId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Patch("workspaces/:workspaceId/income-streams/:streamId")
  async patch(
    @Param("workspaceId") workspaceId: string,
    @Param("streamId") streamId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.patchStream(getAuth(req).userId, workspaceId, streamId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/income-streams/:streamId/period")
  async period(@Param("workspaceId") workspaceId: string, @Param("streamId") streamId: string, @Req() req: Request) {
    try {
      return await this.ops.streamPeriod(getAuth(req).userId, workspaceId, streamId);
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

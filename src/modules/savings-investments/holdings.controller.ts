import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { rec, toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class HoldingsController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Post("workspaces/:workspaceId/holdings")
  async create(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.createHolding(getAuth(req).userId, workspaceId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/holdings")
  async list(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.listHoldings(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/holdings/:holdingId")
  async one(@Param("workspaceId") workspaceId: string, @Param("holdingId") holdingId: string, @Req() req: Request) {
    try {
      return await this.ops.getHolding(getAuth(req).userId, workspaceId, holdingId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Patch("workspaces/:workspaceId/holdings/:holdingId")
  async patch(
    @Param("workspaceId") workspaceId: string,
    @Param("holdingId") holdingId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.updateHolding(getAuth(req).userId, workspaceId, holdingId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/holdings/:holdingId/buy")
  async buy(@Param("workspaceId") workspaceId: string, @Param("holdingId") holdingId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.buyHolding(getAuth(req).userId, workspaceId, holdingId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/holdings/:holdingId/sell")
  async sell(@Param("workspaceId") workspaceId: string, @Param("holdingId") holdingId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.sellHolding(getAuth(req).userId, workspaceId, holdingId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/holdings/:holdingId/dividend")
  async dividend(@Param("workspaceId") workspaceId: string, @Param("holdingId") holdingId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.dividendHolding(getAuth(req).userId, workspaceId, holdingId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/holdings/:holdingId/performance")
  async performance(
    @Param("workspaceId") workspaceId: string,
    @Param("holdingId") holdingId: string,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.holdingPerformance(getAuth(req).userId, workspaceId, holdingId, from, to);
    } catch (error) {
      toHttp(error);
    }
  }
}

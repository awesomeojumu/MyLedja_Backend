import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { rec, toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class BillsController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Post("workspaces/:workspaceId/bills")
  async create(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.createBill(getAuth(req).userId, workspaceId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/bills")
  async list(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.listBills(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/bills/:billId")
  async one(@Param("workspaceId") workspaceId: string, @Param("billId") billId: string, @Req() req: Request) {
    try {
      return await this.ops.getBill(getAuth(req).userId, workspaceId, billId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Patch("workspaces/:workspaceId/bills/:billId")
  async patch(
    @Param("workspaceId") workspaceId: string,
    @Param("billId") billId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.updateBill(getAuth(req).userId, workspaceId, billId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/bills/:billId/reminders")
  async reminders(@Param("workspaceId") workspaceId: string, @Param("billId") billId: string, @Req() req: Request) {
    try {
      return await this.ops.listReminders(getAuth(req).userId, workspaceId, billId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/bills/:billId/paid")
  async paid(@Param("workspaceId") workspaceId: string, @Param("billId") billId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.ops.markPaid(getAuth(req).userId, workspaceId, billId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }
}

import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { LedgerFailure } from "@/modules/transactions/domain/ledger-failure";
import { rec, toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class ImportsController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Get("workspaces/:workspaceId/transactions/:id/offset")
  async offset(@Param("workspaceId") workspaceId: string, @Param("id") id: string, @Req() req: Request) {
    try {
      return await this.ops.offset(getAuth(req).userId, workspaceId, id);
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/transactions/:id/splits")
  async splits(@Param("workspaceId") workspaceId: string, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    try {
      const lines = rec(body).lines;
      if (!Array.isArray(lines)) throw new LedgerFailure("bad_request", "lines required.");
      return await this.ops.split(
        getAuth(req).userId,
        workspaceId,
        id,
        lines.map((line) => ({
          amount: String((line as { amount: string }).amount),
          categoryId: (line as { categoryId?: string }).categoryId,
        })),
      );
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/accounts/:accountId/reconcile")
  async reconcile(
    @Param("workspaceId") workspaceId: string,
    @Param("accountId") accountId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.ops.reconcile(getAuth(req).userId, workspaceId, accountId, rec(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/imports/preview")
  async preview(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      const r = rec(body);
      return await this.ops.previewImport(
        getAuth(req).userId,
        workspaceId,
        String(r.text ?? ""),
        r.mapping as Record<string, string> | undefined,
        typeof r.accountId === "string" ? r.accountId : undefined,
      );
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("workspaces/:workspaceId/imports/:importId/commit")
  async commit(
    @Param("workspaceId") workspaceId: string,
    @Param("importId") importId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      const r = rec(body);
      return await this.ops.commitImport(getAuth(req).userId, workspaceId, importId, String(r.operationId), String(r.accountId));
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("workspaces/:workspaceId/exports/transactions.csv")
  @Header("content-type", "text/csv")
  async exportCsv(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.ops.exportCsv(getAuth(req).userId, workspaceId);
    } catch (error) {
      toHttp(error);
    }
  }
}

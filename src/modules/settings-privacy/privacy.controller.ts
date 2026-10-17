import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { rec, toHttp } from "@/modules/ledger/http";

@Controller()
@UseGuards(RequireAccessToken)
export class PrivacyController {
  constructor(private readonly ops: LedgerOpsService) {}

  @Get("me/sessions")
  async sessions(@Req() req: Request) {
    return this.ops.listSessions(getAuth(req).userId);
  }

  @Delete("me/sessions/:id")
  async revoke(@Param("id") id: string, @Req() req: Request) {
    return this.ops.revokeSession(getAuth(req).userId, id);
  }

  @Patch("me/settings")
  async settings(@Body() body: unknown, @Req() req: Request) {
    const hide = rec(body).hideLockScreenAmounts !== false;
    return this.ops.patchSettings(getAuth(req).userId, hide);
  }

  @Post("me/deletion")
  async deletion(@Req() req: Request) {
    return this.ops.startDeletion(getAuth(req).userId);
  }

  @Post("me/deletion/run")
  async runDeletion(@Req() req: Request) {
    try {
      return await this.ops.runDeletion(getAuth(req).userId);
    } catch (error) {
      toHttp(error);
    }
  }
}

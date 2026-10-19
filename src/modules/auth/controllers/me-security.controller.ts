import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { HttpException } from "@nestjs/common";
import { MfaAndPasskeys } from "@/modules/auth/application/mfa-passkeys";
import { AuthFailure, AuthFailureStatus } from "@/modules/auth/domain/auth-failure";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";

const STATUS_CODE: Record<AuthFailureStatus, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  unverified: 403,
  rate_limited: 429,
};

function toHttp(error: unknown): never {
  if (error instanceof AuthFailure) {
    throw new HttpException({ status: "error", error: error.message }, STATUS_CODE[error.status]);
  }
  throw error;
}

@Controller()
@UseGuards(RequireAccessToken)
export class MeSecurityController {
  constructor(private readonly mfa: MfaAndPasskeys) {}

  @Post("me/mfa/totp/start")
  async start(@Req() req: Request) {
    try {
      return await this.mfa.startTotp(getAuth(req).userId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("me/mfa/totp/confirm")
  async confirm(@Body() body: unknown, @Req() req: Request) {
    try {
      const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      return await this.mfa.confirmTotp(getAuth(req).userId, String(rec.code ?? ""));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("me/mfa/totp/disable")
  async disable(@Body() body: unknown, @Req() req: Request) {
    try {
      const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      return await this.mfa.disableTotp(getAuth(req).userId, String(rec.code ?? rec.backupCode ?? ""));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("me/passkeys/register/start")
  async passkeyStart(@Req() req: Request) {
    try {
      return await this.mfa.passkeyStart(getAuth(req).userId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("me/passkeys/register/finish")
  async passkeyFinish(@Body() body: unknown, @Req() req: Request) {
    try {
      return await this.mfa.passkeyFinish(
        getAuth(req).userId,
        body && typeof body === "object" ? (body as Record<string, unknown>) : {},
      );
    } catch (error) {
      toHttp(error);
    }
  }
}

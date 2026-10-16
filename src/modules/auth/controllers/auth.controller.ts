import { Body, Controller, Get, HttpCode, HttpException, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { ConfirmRecovery } from "../application/confirm-recovery";
import { GetMe } from "../application/get-me";
import { Login } from "../application/login";
import { Logout } from "../application/logout";
import { RefreshSession } from "../application/refresh-session";
import { RegisterUser } from "../application/register-user";
import { RequestRecovery } from "../application/request-recovery";
import { ResendVerification } from "../application/resend-verification";
import { VerifyEmail } from "../application/verify-email";
import { AuthFailure, AuthFailureStatus } from "../domain/auth-failure";
import { parseLogin } from "../dto/login.dto";
import { parseLogout } from "../dto/logout.dto";
import { parseRecoveryConfirm, parseRecoveryRequest } from "../dto/recovery.dto";
import { getAuth, RequireAccessToken } from "../policies/require-access-token";
import { parseRefresh } from "../dto/refresh.dto";
import { parseRegister } from "../dto/register.dto";
import { parseVerify } from "../dto/verify.dto";

const STATUS_CODE: Record<AuthFailureStatus, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  unverified: 403,
  rate_limited: 429,
};

/**
 * Never read X-Forwarded-For directly: any client can set it and dodge IP limits. Behind a proxy, set
 * TRUST_PROXY so Express derives req.ip from the trusted hop.
 */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function toHttp(error: unknown): never {
  if (error instanceof AuthFailure) {
    throw new HttpException({ status: "error", error: error.message }, STATUS_CODE[error.status]);
  }
  throw error;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUser,
    private readonly verifyEmail: VerifyEmail,
    private readonly login: Login,
    private readonly refreshSession: RefreshSession,
    private readonly logout: Logout,
    private readonly requestRecovery: RequestRecovery,
    private readonly confirmRecovery: ConfirmRecovery,
    private readonly resendVerification: ResendVerification,
    private readonly getMe: GetMe,
  ) {}

  @Post("register")
  @HttpCode(202)
  async register(@Body() body: unknown, @Req() req: Request): Promise<{ status: "accepted" }> {
    try {
      await this.registerUser.execute({ ...parseRegister(body), ip: clientIp(req) });
      return { status: "accepted" };
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("verify")
  @HttpCode(200)
  async verify(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ status: "verified"; userId: string; workspaceId: string }> {
    try {
      const result = await this.verifyEmail.execute({ ...parseVerify(body), ip: clientIp(req) });
      return { status: "verified", ...result };
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("verify/resend")
  @HttpCode(202)
  async resend(@Body() body: unknown, @Req() req: Request): Promise<{ status: "accepted" }> {
    try {
      await this.resendVerification.execute({ ...parseRecoveryRequest(body), ip: clientIp(req) });
      return { status: "accepted" };
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("me")
  @UseGuards(RequireAccessToken)
  async me(@Req() req: Request): Promise<{ userId: string; email: string }> {
    try {
      return await this.getMe.execute(getAuth(req).userId);
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("login")
  @HttpCode(200)
  async signIn(@Body() body: unknown, @Req() req: Request): Promise<{
    accessToken: string;
    refreshToken: string;
    userId: string;
    expiresIn: number;
  }> {
    try {
      return await this.login.execute({ ...parseLogin(body), ip: clientIp(req) });
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: unknown): Promise<{
    accessToken: string;
    refreshToken: string;
    userId: string;
    expiresIn: number;
  }> {
    try {
      return await this.refreshSession.execute(parseRefresh(body).refreshToken);
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("logout")
  @HttpCode(200)
  async signOut(@Body() body: unknown): Promise<{ status: "ok" }> {
    try {
      await this.logout.execute(parseLogout(body).refreshToken);
      return { status: "ok" };
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("recovery")
  @HttpCode(202)
  async recovery(@Body() body: unknown, @Req() req: Request): Promise<{ status: "accepted" }> {
    try {
      await this.requestRecovery.execute({ ...parseRecoveryRequest(body), ip: clientIp(req) });
      return { status: "accepted" };
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("recovery/confirm")
  @HttpCode(200)
  async confirm(@Body() body: unknown, @Req() req: Request): Promise<{ status: "reset" }> {
    try {
      await this.confirmRecovery.execute({ ...parseRecoveryConfirm(body), ip: clientIp(req) });
      return { status: "reset" };
    } catch (error) {
      toHttp(error);
    }
  }
}

import { Body, Controller, HttpCode, HttpException, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "../../auth/policies/require-access-token";
import { CompleteLink } from "../application/complete-link";
import { StartLink } from "../application/start-link";
import { MonoFailure } from "../domain/mono-failure";
import { parseCompleteLink, parseWorkspaceId } from "../dto/link.dto";

const STATUS_CODE = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  misconfigured: 503,
  upstream: 502,
} as const;

function toHttp(error: unknown): never {
  if (error instanceof MonoFailure) {
    throw new HttpException({ status: "error", error: error.message }, STATUS_CODE[error.status]);
  }
  throw error;
}

@Controller("bank-integrations")
@UseGuards(RequireAccessToken)
export class BankIntegrationsController {
  constructor(
    private readonly startLink: StartLink,
    private readonly completeLink: CompleteLink,
  ) {}

  @Post("link")
  @HttpCode(200)
  async start(@Req() req: Request, @Body() body: unknown): Promise<{ status: "ok"; data: { monoUrl: string } }> {
    try {
      const data = await this.startLink.execute(getAuth(req).userId, parseWorkspaceId(body));
      return { status: "ok", data };
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("link/complete")
  @HttpCode(200)
  async complete(@Req() req: Request, @Body() body: unknown): Promise<{ status: "ok"; data: Awaited<ReturnType<CompleteLink["execute"]>> }> {
    try {
      const parsed = parseCompleteLink(body);
      const data = await this.completeLink.execute(getAuth(req).userId, parsed.code, parsed.workspaceId);
      return { status: "ok", data };
    } catch (error) {
      toHttp(error);
    }
  }
}

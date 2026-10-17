import { Body, Controller, Delete, Get, HttpException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { ArchiveAccount } from "@/modules/accounts/application/archive-account";
import { CreateAccount } from "@/modules/accounts/application/create-account";
import { ListAccounts } from "@/modules/accounts/application/list-accounts";
import { SetOpening } from "@/modules/accounts/application/set-opening";
import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";
import { AccountFailure } from "@/modules/accounts/domain/account-failure";
import { INSTITUTIONS } from "@/modules/accounts/domain/institutions";
import { parseCreateAccount, parseOpening, parseWorkspaceId } from "@/modules/accounts/dto/account.dto";

const STATUS_CODE = { bad_request: 400, not_found: 404, forbidden: 403, conflict: 409 } as const;

function toHttp(error: unknown): never {
  if (error instanceof AccountFailure) {
    throw new HttpException({ status: "error", error: error.message }, STATUS_CODE[error.status]);
  }
  if (error instanceof WorkspaceFailure) {
    throw new HttpException({ status: "error", error: error.message }, error.status === "forbidden" ? 403 : 404);
  }
  throw error;
}

@Controller("workspaces/:workspaceId")
@UseGuards(RequireAccessToken)
export class AccountsController {
  constructor(
    private readonly createAccount: CreateAccount,
    private readonly listAccounts: ListAccounts,
    private readonly archiveAccount: ArchiveAccount,
    private readonly setOpening: SetOpening,
  ) {}

  @Get("institutions")
  institutions() {
    return { status: "ok", data: INSTITUTIONS, error: null };
  }

  @Get("accounts")
  async list(
    @Param("workspaceId") workspaceId: string,
    @Query("archived") archived: string | undefined,
    @Req() req: Request,
  ) {
    try {
      return await this.listAccounts.execute(getAuth(req).userId, parseWorkspaceId(workspaceId), archived === "true");
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("accounts")
  async create(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.createAccount.execute(getAuth(req).userId, parseWorkspaceId(workspaceId), parseCreateAccount(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("accounts/:accountId/opening")
  async opening(
    @Param("workspaceId") workspaceId: string,
    @Param("accountId") accountId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.setOpening.execute(
        getAuth(req).userId,
        parseWorkspaceId(workspaceId),
        accountId,
        parseOpening(body).opening,
      );
    } catch (error) {
      toHttp(error);
    }
  }

  @Delete("accounts/:accountId")
  async remove(
    @Param("workspaceId") workspaceId: string,
    @Param("accountId") accountId: string,
    @Req() req: Request,
  ) {
    try {
      return await this.archiveAccount.execute(getAuth(req).userId, parseWorkspaceId(workspaceId), accountId);
    } catch (error) {
      toHttp(error);
    }
  }
}

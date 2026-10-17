import { Body, Controller, Get, HttpException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { ChangeStatus } from "@/modules/transactions/application/change-status";
import { CreateTransaction } from "@/modules/transactions/application/create-transaction";
import { periodTotals } from "@/modules/transactions/application/totals";
import { publicTransaction } from "@/modules/transactions/application/public-transaction";
import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";
import { LedgerFailure } from "@/modules/transactions/domain/ledger-failure";
import { parseCreateTxn, parseStatus, parseWorkspaceId } from "@/modules/transactions/dto/transaction.dto";
import { TransactionsRepository } from "@/modules/transactions/repositories/transactions.repository";

const STATUS_CODE = {
  bad_request: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  reused: 422,
  unprocessable: 422,
} as const;

function toHttp(error: unknown): never {
  if (error instanceof LedgerFailure) {
    throw new HttpException({ status: "error", error: error.message }, STATUS_CODE[error.status]);
  }
  if (error instanceof WorkspaceFailure) {
    throw new HttpException({ status: "error", error: error.message }, error.status === "forbidden" ? 403 : 404);
  }
  throw error;
}

@Controller("workspaces/:workspaceId/transactions")
@UseGuards(RequireAccessToken)
export class TransactionsController {
  constructor(
    private readonly createTransaction: CreateTransaction,
    private readonly changeStatus: ChangeStatus,
    private readonly txns: TransactionsRepository,
  ) {}

  @Get()
  async list(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      parseWorkspaceId(workspaceId);
      getAuth(req);
      const rows = await this.txns.listAll(workspaceId);
      return {
        status: "ok",
        data: { transactions: rows.map(publicTransaction), totals: periodTotals(rows) },
        error: null,
      };
    } catch (error) {
      toHttp(error);
    }
  }

  @Post()
  async create(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      return await this.createTransaction.execute(getAuth(req).userId, parseWorkspaceId(workspaceId), parseCreateTxn(body));
    } catch (error) {
      toHttp(error);
    }
  }

  @Patch(":id/status")
  async status(
    @Param("workspaceId") workspaceId: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    try {
      return await this.changeStatus.execute(getAuth(req).userId, parseWorkspaceId(workspaceId), id, parseStatus(body));
    } catch (error) {
      toHttp(error);
    }
  }
}

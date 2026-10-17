import { HttpException } from "@nestjs/common";
import { LedgerFailure } from "@/modules/transactions/domain/ledger-failure";
import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";

export function rec(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function toHttp(error: unknown): never {
  if (error instanceof LedgerFailure) {
    const code = error.status === "forbidden" ? 403 : error.status === "not_found" ? 404 : error.status === "bad_request" ? 400 : 422;
    throw new HttpException({ status: "error", error: error.message }, code);
  }
  if (error instanceof WorkspaceFailure) {
    throw new HttpException({ status: "error", error: error.message }, error.status === "forbidden" ? 403 : 404);
  }
  throw error;
}

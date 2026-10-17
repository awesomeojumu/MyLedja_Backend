import { isId } from "@/common/ids";
import { LedgerFailure } from "@/modules/transactions/domain/ledger-failure";
import { LedgerStatus, LedgerType } from "@/modules/transactions/schemas/transaction";

function rec(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") throw new LedgerFailure("bad_request", "That request is not valid.");
  return body as Record<string, unknown>;
}

const TYPES: LedgerType[] = ["income", "expense", "transfer", "refund"];
const STATUSES: LedgerStatus[] = ["pending", "posted", "reversed", "voided"];

export function parseCreateTxn(body: unknown) {
  const r = rec(body);
  if (!isId(r.operationId)) throw new LedgerFailure("bad_request", "operationId must be a UUIDv7.");
  if (!TYPES.includes(r.type as LedgerType)) throw new LedgerFailure("bad_request", "Choose income, expense, transfer or refund.");
  if (typeof r.amount !== "string") throw new LedgerFailure("bad_request", "Enter an amount.");
  if (typeof r.accountId !== "string") throw new LedgerFailure("bad_request", "Choose an account.");
  const status = r.status === undefined ? "posted" : (r.status as LedgerStatus);
  if (!STATUSES.includes(status)) throw new LedgerFailure("bad_request", "Unsupported status.");
  return {
    operationId: r.operationId as string,
    type: r.type as LedgerType,
    amount: r.amount,
    currency: typeof r.currency === "string" ? r.currency : "NGN",
    accountId: r.accountId,
    toAccountId: typeof r.toAccountId === "string" ? r.toAccountId : undefined,
    categoryId: typeof r.categoryId === "string" ? r.categoryId : undefined,
    description: typeof r.description === "string" ? r.description : "",
    status,
    tagIds: Array.isArray(r.tagIds) ? r.tagIds.filter((id): id is string => typeof id === "string") : [],
  };
}

export function parseStatus(body: unknown): LedgerStatus {
  const r = rec(body);
  if (!STATUSES.includes(r.status as LedgerStatus)) throw new LedgerFailure("bad_request", "Unsupported status.");
  return r.status as LedgerStatus;
}

export function parseWorkspaceId(id: string): string {
  if (!isId(id)) throw new LedgerFailure("bad_request", "That workspace is not valid.");
  return id;
}

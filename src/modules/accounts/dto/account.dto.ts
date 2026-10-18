import { isId } from "@/common/ids";
import { parseMoney } from "@/common/money/money";
import { AccountFailure } from "@/modules/accounts/domain/account-failure";
import { institutionById } from "@/modules/accounts/domain/institutions";
import { AccountKind, ConnectionType } from "@/modules/accounts/schemas/account";

const KINDS: AccountKind[] = ["bank", "wallet", "cash", "savings", "liability", "receivable"];
const CONNECTIONS: ConnectionType[] = ["manual", "linked", "imported"];

function rec(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new AccountFailure("bad_request", "That request is not valid.");
  }
  return body as Record<string, unknown>;
}

export function parseCreateAccount(body: unknown): {
  name: string;
  kind: AccountKind;
  institutionId: string | null;
  connectionType: ConnectionType;
  currency: string;
  opening: string;
  accountNumber?: string;
} {
  const r = rec(body);
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) throw new AccountFailure("bad_request", "Give this account a name.");
  if (!KINDS.includes(r.kind as AccountKind)) {
    throw new AccountFailure("bad_request", "Choose a valid account type.");
  }
  const connectionType = (r.connectionType as ConnectionType) ?? "manual";
  if (!CONNECTIONS.includes(connectionType)) {
    throw new AccountFailure("bad_request", "Choose a valid connection type.");
  }
  const institutionId = r.institutionId == null || r.institutionId === "" ? null : String(r.institutionId);
  if ((r.kind === "bank" || r.kind === "wallet") && !institutionId) {
    throw new AccountFailure("bad_request", "Pick an institution. It is stored separately from this account.");
  }
  if (institutionId && !institutionById(institutionId)) {
    throw new AccountFailure("bad_request", "Unknown institution.");
  }
  const currency = typeof r.currency === "string" ? r.currency : "NGN";
  const opening = typeof r.opening === "string" ? r.opening : "0.00";
  parseMoney(opening, currency);
  const accountNumber = typeof r.accountNumber === "string" && r.accountNumber.trim() ? r.accountNumber.trim() : undefined;
  return { name, kind: r.kind as AccountKind, institutionId, connectionType, currency, opening, accountNumber };
}

export function parseOpening(body: unknown): { opening: string } {
  const r = rec(body);
  if (typeof r.opening !== "string") throw new AccountFailure("bad_request", "Opening balance must be a naira amount.");
  return { opening: r.opening };
}

export function parseKind(body: unknown): { kind: AccountKind } {
  const r = rec(body);
  if (!KINDS.includes(r.kind as AccountKind)) {
    throw new AccountFailure("bad_request", "Choose a valid account type.");
  }
  return { kind: r.kind as AccountKind };
}

export function parseRename(body: unknown): { name: string } {
  const r = rec(body);
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) throw new AccountFailure("bad_request", "Give this account a name.");
  return { name };
}

export function parseWorkspaceId(id: string): string {
  if (!isId(id)) throw new AccountFailure("bad_request", "That workspace is not valid.");
  return id;
}

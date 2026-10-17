import { MonoFailure } from "@/modules/bank-integrations/domain/mono-failure";

export function parseWorkspaceId(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new MonoFailure("bad_request", "That request is not valid.");
  }
  const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
  if (workspaceId === undefined || workspaceId === "") return undefined;
  if (typeof workspaceId !== "string") {
    throw new MonoFailure("bad_request", "That workspace is not valid.");
  }
  return workspaceId;
}

export function parseCompleteLink(body: unknown): { code: string; workspaceId?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MonoFailure("bad_request", "That request is not valid.");
  }
  const code = (body as { code?: unknown }).code;
  if (typeof code !== "string" || !code.trim()) {
    throw new MonoFailure("bad_request", "That code is missing.");
  }
  return { code: code.trim(), workspaceId: parseWorkspaceId(body) };
}

import { AuthFailure } from "@/modules/auth/domain/auth-failure";

export interface RefreshInput {
  refreshToken: string;
}

export function parseRefresh(body: unknown): RefreshInput {
  if (!body || typeof body !== "object") {
    throw new AuthFailure("bad_request", "refreshToken is required");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.refreshToken !== "string" || record.refreshToken.length === 0) {
    throw new AuthFailure("bad_request", "refreshToken is required");
  }
  return { refreshToken: record.refreshToken };
}

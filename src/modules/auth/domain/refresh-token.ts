import { createHash, randomBytes, randomUUID } from "node:crypto";

export const REFRESH_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;

export function newFamilyId(): string {
  return randomUUID();
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueRefreshToken(familyId: string): { token: string; hash: string } {
  const token = `${familyId}.${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashRefreshToken(token) };
}

export function familyIdFrom(token: string): string | undefined {
  const separator = token.indexOf(".");
  if (separator <= 0) {
    return undefined;
  }
  return token.slice(0, separator);
}

export function refreshWindows(now: Date): {
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
} {
  return {
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: new Date(now.getTime() + REFRESH_IDLE_MS),
    absoluteExpiresAt: new Date(now.getTime() + REFRESH_ABSOLUTE_MS),
  };
}

import { newId } from "@/common/ids";
import { loadConfig } from "@/config/env";
import { ACCESS_TTL_SECONDS, signAccessToken } from "@/modules/auth/domain/access-token";
import { issueRefreshToken, newFamilyId, refreshWindows } from "@/modules/auth/domain/refresh-token";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";

export async function issueTokens(
  sessions: SessionsRepository,
  userId: string,
  deviceLabel?: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string; expiresIn: number }> {
  const now = new Date();
  const sid = newId();
  const familyId = newFamilyId();
  const refresh = issueRefreshToken(familyId);
  const windows = refreshWindows(now);
  await sessions.insert({
    _id: sid,
    userId,
    familyId,
    refreshTokenHash: refresh.hash,
    ...windows,
    revokedAt: null,
    deviceLabel: deviceLabel ?? "This device",
  });
  const accessToken = await signAccessToken({ userId, sid }, loadConfig().jwtSecret, now);
  return { accessToken, refreshToken: refresh.token, userId, expiresIn: ACCESS_TTL_SECONDS };
}

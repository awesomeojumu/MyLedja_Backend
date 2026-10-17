import { Injectable } from "@nestjs/common";
import { loadConfig } from "@/config/env";
import { newId } from "@/common/ids";
import { ACCESS_TTL_SECONDS, signAccessToken } from "@/modules/auth/domain/access-token";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";
import {
  familyIdFrom,
  hashRefreshToken,
  issueRefreshToken,
  REFRESH_IDLE_MS,
} from "@/modules/auth/domain/refresh-token";
import { SecurityEventsRepository } from "@/modules/auth/repositories/security-events.repository";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";

@Injectable()
export class RefreshSession {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly events: SecurityEventsRepository,
  ) {}

  async execute(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    userId: string;
    expiresIn: number;
  }> {
    const now = new Date();
    const hash = hashRefreshToken(refreshToken);
    const session = await this.sessions.findByHash(hash);
    if (!session) {
      await this.revokeOnReuse(familyIdFrom(refreshToken), now);
      throw new AuthFailure("unauthorized", "invalid refresh token");
    }
    if (session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      await this.sessions.revokeFamily(session.familyId, now);
      throw new AuthFailure("unauthorized", "invalid refresh token");
    }
    const next = issueRefreshToken(session.familyId);
    const rotated = await this.sessions.rotate(
      session._id,
      hash,
      next.hash,
      now,
      new Date(now.getTime() + REFRESH_IDLE_MS),
    );
    if (!rotated) {
      await this.revokeOnReuse(session.familyId, now);
      throw new AuthFailure("unauthorized", "invalid refresh token");
    }
    const accessToken = await signAccessToken(
      { userId: session.userId, sid: session._id },
      loadConfig().jwtSecret,
      now,
    );
    return {
      accessToken,
      refreshToken: next.token,
      userId: session.userId,
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }

  /** A token that is no longer current was presented: revoke its whole family and record it (TC-17). */
  private async revokeOnReuse(familyId: string | undefined, now: Date): Promise<void> {
    if (!familyId) {
      return;
    }
    const known = await this.sessions.findByFamily(familyId);
    if (!known) {
      return;
    }
    await this.sessions.revokeFamily(familyId, now);
    await this.events.insert({
      _id: newId(),
      type: "refresh_reuse",
      userId: known.userId,
      familyId,
      createdAt: now,
    });
  }
}

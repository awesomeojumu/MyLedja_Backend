import { Injectable } from "@nestjs/common";
import { hashRefreshToken } from "@/modules/auth/domain/refresh-token";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";

@Injectable()
export class Logout {
  constructor(private readonly sessions: SessionsRepository) {}

  /** Revokes the session the current refresh token belongs to. An unknown token is a no-op. */
  async execute(refreshToken: string): Promise<void> {
    const session = await this.sessions.findByHash(hashRefreshToken(refreshToken));
    if (session) {
      await this.sessions.revokeFamily(session.familyId, new Date());
    }
  }
}

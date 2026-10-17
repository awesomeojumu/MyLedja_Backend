import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@/common/ids";
import { HashOptions } from "argon2";
import { loadConfig } from "@/config/env";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import { ACCESS_TTL_SECONDS, signAccessToken } from "@/modules/auth/domain/access-token";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";
import { ARGON2_OPTIONS, dummyPasswordCheck, verifyPassword } from "@/modules/auth/domain/password";
import { RateLimit } from "@/modules/auth/domain/rate-limit";
import {
  issueRefreshToken,
  newFamilyId,
  refreshWindows,
} from "@/modules/auth/domain/refresh-token";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";

@Injectable()
export class Login {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly rateLimit: RateLimit,
    @Inject(ARGON2_OPTIONS) private readonly argon2: HashOptions,
  ) {}

  async execute(input: { email: string; password: string; ip: string }): Promise<{
    accessToken: string;
    refreshToken: string;
    userId: string;
    expiresIn: number;
  }> {
    const ipKey = `login:ip:${input.ip}`;
    const emailKey = `login:email:${input.email}`;
    if (this.rateLimit.isLimited(ipKey) || this.rateLimit.isLimited(emailKey)) {
      throw new AuthFailure("rate_limited", "too many attempts");
    }
    const user = await this.users.findByEmail(input.email);
    if (!user) {
      await dummyPasswordCheck(input.password, this.argon2);
      this.rateLimit.record(ipKey);
      this.rateLimit.record(emailKey);
      throw new AuthFailure("unauthorized", "invalid credentials");
    }
    const matches = await verifyPassword(user.passwordHash, input.password);
    if (!matches) {
      this.rateLimit.record(ipKey);
      this.rateLimit.record(emailKey);
      throw new AuthFailure("unauthorized", "invalid credentials");
    }
    if (!user.verifiedAt) {
      throw new AuthFailure("unverified", "email not verified");
    }
    this.rateLimit.reset(emailKey);
    const now = new Date();
    const sid = newId();
    const familyId = newFamilyId();
    const refresh = issueRefreshToken(familyId);
    const windows = refreshWindows(now);
    await this.sessions.insert({
      _id: sid,
      userId: user._id,
      familyId,
      refreshTokenHash: refresh.hash,
      ...windows,
      revokedAt: null,
    });
    const accessToken = await signAccessToken({ userId: user._id, sid }, loadConfig().jwtSecret, now);
    return {
      accessToken,
      refreshToken: refresh.token,
      userId: user._id,
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }
}

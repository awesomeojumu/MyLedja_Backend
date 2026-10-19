import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@/common/ids";
import { HashOptions } from "argon2";
import { loadConfig } from "@/config/env";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import { ACCESS_TTL_SECONDS, signAccessToken } from "@/modules/auth/domain/access-token";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";
import { ARGON2_OPTIONS, unusedPasswordWork, verifyPassword } from "@/modules/auth/domain/password";
import { RateLimit } from "@/modules/auth/domain/rate-limit";
import {
  issueRefreshToken,
  newFamilyId,
  refreshWindows,
} from "@/modules/auth/domain/refresh-token";
import { MfaRequired } from "@/modules/auth/domain/mfa-required";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";
import { Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";

@Injectable()
export class Login {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly rateLimit: RateLimit,
    @Inject(ARGON2_OPTIONS) private readonly argon2: HashOptions,
    @Inject(MONGO_DB) private readonly db: Db,
  ) {}

  async execute(input: { email: string; password: string; ip: string; deviceLabel?: string }): Promise<{
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
      await unusedPasswordWork(input.password, this.argon2);
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
    this.rateLimit.reset(ipKey);
    if (user.totpEnabled) {
      const challengeId = newId();
      await this.db.collection<{ _id: string; userId: string; expiresAt: Date }>("mfa_challenges").insertOne({
        _id: challengeId,
        userId: user._id,
        expiresAt: new Date(Date.now() + 120_000),
      });
      throw new MfaRequired(challengeId);
    }
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
      deviceLabel: input.deviceLabel ?? "This device",
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

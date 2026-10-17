import { Inject, Injectable } from "@nestjs/common";
import { HashOptions } from "argon2";
import { newId } from "@/common/ids";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";
import { codeMatches, unusedCodeWork, MAX_CODE_ATTEMPTS } from "@/modules/auth/domain/email-code";
import { ARGON2_OPTIONS, hashPassword } from "@/modules/auth/domain/password";
import { RateLimit } from "@/modules/auth/domain/rate-limit";
import { EmailCodesRepository } from "@/modules/auth/repositories/email-codes.repository";
import { SecurityEventsRepository } from "@/modules/auth/repositories/security-events.repository";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";

@Injectable()
export class ConfirmRecovery {
  constructor(
    private readonly users: UsersRepository,
    private readonly codes: EmailCodesRepository,
    private readonly sessions: SessionsRepository,
    private readonly events: SecurityEventsRepository,
    private readonly rateLimit: RateLimit,
    @Inject(ARGON2_OPTIONS) private readonly argon2: HashOptions,
  ) {}

  async execute(input: { email: string; code: string; password: string; ip: string }): Promise<void> {
    const ipKey = `recovery:ip:${input.ip}`;
    const emailKey = `recovery:email:${input.email}`;
    if (this.rateLimit.isLimited(ipKey) || this.rateLimit.isLimited(emailKey)) {
      throw new AuthFailure("rate_limited", "too many attempts");
    }
    const user = await this.users.findByEmail(input.email);
    const active = await this.codes.findActive(input.email, "recovery");
    const now = new Date();
    if (!user || !user.verifiedAt || !active || active.expiresAt <= now) {
      unusedCodeWork(input.code);
      this.rateLimit.record(ipKey);
      this.rateLimit.record(emailKey);
      throw new AuthFailure("unauthorized", "invalid code");
    }
    if (!codeMatches(active.codeHash, input.code)) {
      const attempts = active.attempts + 1;
      await this.codes.recordMiss(active._id, attempts, attempts >= MAX_CODE_ATTEMPTS ? now : null);
      this.rateLimit.record(ipKey);
      this.rateLimit.record(emailKey);
      throw new AuthFailure("unauthorized", "invalid code");
    }
    this.rateLimit.reset(ipKey);
    this.rateLimit.reset(emailKey);
    await this.codes.consume(active._id, now);
    await this.users.setPassword(user._id, await hashPassword(input.password, this.argon2));
    await this.sessions.revokeUser(user._id, now);
    await this.events.insert({ _id: newId(), type: "password_reset", userId: user._id, createdAt: now });
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@/common/ids";
import { HashOptions } from "argon2";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import {
  unusedCodeWork,
  generateEmailCode,
  hashEmailCode,
  VERIFY_CODE_TTL_MS,
} from "@/modules/auth/domain/email-code";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";
import { MAILER, Mailer } from "@/modules/auth/domain/mailer";
import { ARGON2_OPTIONS, unusedPasswordWork, hashPassword } from "@/modules/auth/domain/password";
import { RateLimit } from "@/modules/auth/domain/rate-limit";
import { EmailCodesRepository } from "@/modules/auth/repositories/email-codes.repository";

@Injectable()
export class RegisterUser {
  constructor(
    private readonly users: UsersRepository,
    private readonly codes: EmailCodesRepository,
    private readonly rateLimit: RateLimit,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ARGON2_OPTIONS) private readonly argon2: HashOptions,
  ) {}

  async execute(input: { email: string; password: string; ip: string }): Promise<void> {
    const ipKey = `register:ip:${input.ip}`;
    if (this.rateLimit.isLimited(ipKey)) {
      throw new AuthFailure("rate_limited", "too many attempts");
    }
    this.rateLimit.record(ipKey);
    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      await unusedPasswordWork(input.password, this.argon2);
      unusedCodeWork(generateEmailCode());
      return;
    }
    const now = new Date();
    const userId = newId();
    const inserted = await this.users.insert({
      _id: userId,
      email: input.email,
      passwordHash: await hashPassword(input.password, this.argon2),
      verifiedAt: null,
      createdAt: now,
    });
    if (inserted === "duplicate") {
      return;
    }
    const code = generateEmailCode();
    await this.codes.replaceActive({
      _id: newId(),
      email: input.email,
      purpose: "verify",
      codeHash: hashEmailCode(code),
      expiresAt: new Date(now.getTime() + VERIFY_CODE_TTL_MS),
      attempts: 0,
      usedAt: null,
      createdAt: now,
    });
    await this.mailer.sendCode({ email: input.email, purpose: "verify", code });
  }
}

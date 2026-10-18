import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@/common/ids";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";
import {
  unusedCodeWork,
  generateEmailCode,
  hashEmailCode,
  RECOVERY_CODE_TTL_MS,
} from "@/modules/auth/domain/email-code";
import { MAILER, Mailer, sendCodeQuietly } from "@/modules/auth/domain/mailer";
import { RateLimit } from "@/modules/auth/domain/rate-limit";
import { EmailCodesRepository } from "@/modules/auth/repositories/email-codes.repository";

@Injectable()
export class RequestRecovery {
  constructor(
    private readonly users: UsersRepository,
    private readonly codes: EmailCodesRepository,
    private readonly rateLimit: RateLimit,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async execute(input: { email: string; ip: string }): Promise<void> {
    const ipKey = `recovery:ip:${input.ip}`;
    const emailKey = `recovery:email:${input.email}`;
    if (this.rateLimit.isLimited(ipKey) || this.rateLimit.isLimited(emailKey)) {
      throw new AuthFailure("rate_limited", "too many attempts");
    }
    this.rateLimit.record(ipKey);
    this.rateLimit.record(emailKey);
    const user = await this.users.findByEmail(input.email);
    unusedCodeWork(generateEmailCode());
    if (!user || !user.verifiedAt) {
      return;
    }
    const now = new Date();
    const code = generateEmailCode();
    await this.codes.replaceActive({
      _id: newId(),
      email: input.email,
      purpose: "recovery",
      codeHash: hashEmailCode(code),
      expiresAt: new Date(now.getTime() + RECOVERY_CODE_TTL_MS),
      attempts: 0,
      usedAt: null,
      createdAt: now,
    });
    await sendCodeQuietly(this.mailer, { email: input.email, purpose: "recovery", code });
  }
}

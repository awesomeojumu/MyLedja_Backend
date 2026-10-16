import { Inject, Injectable } from "@nestjs/common";
import { newId } from "../../../common/ids";
import { UsersRepository } from "../../users/repositories/users.repository";
import { AuthFailure } from "../domain/auth-failure";
import {
  dummyCodeCheck,
  generateEmailCode,
  hashEmailCode,
  RECOVERY_CODE_TTL_MS,
} from "../domain/email-code";
import { MAILER, Mailer } from "../domain/mailer";
import { RateLimit } from "../domain/rate-limit";
import { EmailCodesRepository } from "../repositories/email-codes.repository";

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
    dummyCodeCheck(generateEmailCode());
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
    await this.mailer.sendCode({ email: input.email, purpose: "recovery", code });
  }
}

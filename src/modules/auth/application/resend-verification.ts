import { Inject, Injectable } from "@nestjs/common";
import { newId } from "../../../common/ids";
import { UsersRepository } from "../../users/repositories/users.repository";
import { AuthFailure } from "../domain/auth-failure";
import { dummyCodeCheck, generateEmailCode, hashEmailCode, VERIFY_CODE_TTL_MS } from "../domain/email-code";
import { MAILER, Mailer } from "../domain/mailer";
import { RateLimit } from "../domain/rate-limit";
import { EmailCodesRepository } from "../repositories/email-codes.repository";

/** Sends a fresh verification code to an unverified account. Always looks the same to the caller. */
@Injectable()
export class ResendVerification {
  constructor(
    private readonly users: UsersRepository,
    private readonly codes: EmailCodesRepository,
    private readonly rateLimit: RateLimit,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async execute(input: { email: string; ip: string }): Promise<void> {
    const ipKey = `resend:ip:${input.ip}`;
    const emailKey = `resend:email:${input.email}`;
    if (this.rateLimit.isLimited(ipKey) || this.rateLimit.isLimited(emailKey)) {
      throw new AuthFailure("rate_limited", "too many attempts");
    }
    this.rateLimit.record(ipKey);
    this.rateLimit.record(emailKey);
    const user = await this.users.findByEmail(input.email);
    if (!user || user.verifiedAt) {
      dummyCodeCheck(generateEmailCode());
      return;
    }
    const now = new Date();
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

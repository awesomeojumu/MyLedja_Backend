import { Inject, Injectable } from "@nestjs/common";
import { MongoClient } from "mongodb";
import { MONGO_CLIENT } from "../../../database/mongo/mongo.constants";
import { runInTransaction } from "../../../database/mongo/transaction";
import { UsersRepository } from "../../users/repositories/users.repository";
import { CreatePersonalWorkspace } from "../../workspaces/application/create-personal-workspace";
import { AuthFailure } from "../domain/auth-failure";
import { codeMatches, dummyCodeCheck, MAX_CODE_ATTEMPTS } from "../domain/email-code";
import { RateLimit } from "../domain/rate-limit";
import { EmailCodesRepository } from "../repositories/email-codes.repository";

@Injectable()
export class VerifyEmail {
  constructor(
    @Inject(MONGO_CLIENT) private readonly mongo: MongoClient,
    private readonly users: UsersRepository,
    private readonly codes: EmailCodesRepository,
    private readonly workspaces: CreatePersonalWorkspace,
    private readonly rateLimit: RateLimit,
  ) {}

  async execute(input: { email: string; code: string; ip: string }): Promise<{
    userId: string;
    workspaceId: string;
  }> {
    const ipKey = `verify:ip:${input.ip}`;
    const emailKey = `verify:email:${input.email}`;
    if (this.rateLimit.isLimited(ipKey) || this.rateLimit.isLimited(emailKey)) {
      throw new AuthFailure("rate_limited", "too many attempts");
    }
    const user = await this.users.findByEmail(input.email);
    const active = await this.codes.findActive(input.email, "verify");
    const now = new Date();
    if (!user || user.verifiedAt || !active || active.expiresAt <= now) {
      dummyCodeCheck(input.code);
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
    return runInTransaction(this.mongo, async (session) => {
      await this.codes.consume(active._id, now, session);
      await this.users.markVerified(user._id, now, session);
      const { workspaceId } = await this.workspaces.execute(user._id, session);
      return { userId: user._id, workspaceId };
    });
  }
}

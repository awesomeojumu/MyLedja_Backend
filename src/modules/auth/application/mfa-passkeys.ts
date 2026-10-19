import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Db } from "mongodb";
import { hash, verify } from "argon2";
import { newId } from "@/common/ids";
import { loadConfig } from "@/config/env";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { ARGON2_OPTIONS } from "@/modules/auth/domain/password";
import type { HashOptions } from "argon2";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";
import { RateLimit } from "@/modules/auth/domain/rate-limit";
import {
  decryptSecret,
  encryptSecret,
  newBackupCodes,
  newTotpSecret,
  otpauthUri,
  totpOk,
} from "@/modules/auth/domain/totp";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";
import { issueTokens } from "@/modules/auth/application/issue-tokens";

@Injectable()
export class MfaAndPasskeys {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly rateLimit: RateLimit,
    @Inject(MONGO_DB) private readonly db: Db,
    @Inject(ARGON2_OPTIONS) private readonly argon2: HashOptions,
  ) {}

  async startTotp(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthFailure("unauthorized", "invalid access token");
    const secret = newTotpSecret();
    await this.users.setTotpPending(userId, encryptSecret(secret, loadConfig().jwtSecret));
    return { status: "ok" as const, data: { otpauthUri: otpauthUri(user.email, secret), secret }, error: null };
  }

  async confirmTotp(userId: string, code: string) {
    const user = await this.users.findById(userId);
    if (!user?.totpPendingEnc) throw new AuthFailure("bad_request", "Start authenticator setup first.");
    const secret = decryptSecret(user.totpPendingEnc, loadConfig().jwtSecret);
    if (!totpOk(secret, code)) throw new AuthFailure("unauthorized", "invalid code");
    const backups = newBackupCodes();
    const hashes = await Promise.all(backups.map((c) => hash(c, this.argon2)));
    await this.users.confirmTotp(userId, encryptSecret(secret, loadConfig().jwtSecret), hashes);
    return { status: "ok" as const, data: { backupCodes: backups }, error: null };
  }

  async disableTotp(userId: string, code: string) {
    const user = await this.users.findById(userId);
    if (!user?.totpEnabled || !user.totpSecretEnc) throw new AuthFailure("bad_request", "MFA is off.");
    const secret = decryptSecret(user.totpSecretEnc, loadConfig().jwtSecret);
    const totp = totpOk(secret, code);
    const backup = !totp ? await this.consumeBackup(user, code) : false;
    if (!totp && !backup) throw new AuthFailure("unauthorized", "invalid code");
    await this.users.disableTotp(userId);
    return { status: "ok" as const, data: { totpEnabled: false }, error: null };
  }

  async completeMfa(input: { challengeId: string; code?: string; backupCode?: string; ip: string }) {
    const key = `login:ip:${input.ip}`;
    if (this.rateLimit.isLimited(key)) throw new AuthFailure("rate_limited", "too many attempts");
    const challenge = await this.db
      .collection<{ _id: string; userId: string; expiresAt: Date }>("mfa_challenges")
      .findOne({ _id: input.challengeId });
    if (!challenge || new Date(challenge.expiresAt as Date) < new Date()) {
      this.rateLimit.record(key);
      throw new AuthFailure("unauthorized", "invalid code");
    }
    const user = await this.users.findById(String(challenge.userId));
    if (!user?.totpEnabled || !user.totpSecretEnc) throw new AuthFailure("unauthorized", "invalid code");
    const secret = decryptSecret(user.totpSecretEnc, loadConfig().jwtSecret);
    const totp = input.code ? totpOk(secret, input.code) : false;
    const backup = !totp && input.backupCode ? await this.consumeBackup(user, input.backupCode) : false;
    if (!totp && !backup) {
      this.rateLimit.record(key);
      throw new AuthFailure("unauthorized", "invalid code");
    }
    await this.db.collection<{ _id: string }>("mfa_challenges").deleteOne({ _id: input.challengeId });
    this.rateLimit.reset(key);
    return issueTokens(this.sessions, user._id);
  }

  async passkeyStart(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthFailure("unauthorized", "invalid access token");
    const challenge = randomBytes(32).toString("base64url");
    await this.db.collection<{ _id: string; userId: string; challenge: string; expiresAt: Date }>("webauthn_challenges").insertOne({
      _id: newId(),
      userId,
      challenge,
      expiresAt: new Date(Date.now() + 120_000),
    });
    const origin = loadConfig().appUrl;
    const rpId = new URL(origin).hostname;
    return {
      status: "ok" as const,
      data: {
        challenge,
        rp: { name: "MyLedja", id: rpId },
        user: { id: userId, name: user.email, displayName: user.email },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60_000,
        attestation: "none",
      },
      error: null,
    };
  }

  async passkeyFinish(userId: string, body: Record<string, unknown>) {
    const rawId = typeof body.id === "string" ? body.id : "";
    const clientData = typeof body.clientDataJSON === "string" ? body.clientDataJSON : "";
    if (!rawId || !clientData) throw new AuthFailure("bad_request", "Passkey ceremony incomplete.");
    let parsed: { challenge?: string; type?: string };
    try {
      parsed = JSON.parse(Buffer.from(clientData, "base64url").toString("utf8")) as { challenge?: string; type?: string };
    } catch {
      throw new AuthFailure("bad_request", "Passkey ceremony incomplete.");
    }
    if (parsed.type && parsed.type !== "webauthn.create") {
      throw new AuthFailure("bad_request", "Passkey ceremony incomplete.");
    }
    const open = await this.db
      .collection<{ _id: string; userId: string; challenge: string; expiresAt: Date }>("webauthn_challenges")
      .find({ userId, expiresAt: { $gt: new Date() } })
      .toArray();
    const challenge = open.find((row) => challengeBytesMatch(row.challenge, parsed.challenge ?? ""));
    if (!challenge) {
      throw new AuthFailure("unauthorized", "invalid code");
    }
    await this.db.collection<{ _id: string }>("webauthn_challenges").deleteOne({ _id: challenge._id });
    await this.db
      .collection<{ _id: string; userId: string; credentialId: string; publicKey: string; counter: number }>("webauthn_credentials")
      .insertOne({
      _id: newId(),
      userId,
      credentialId: rawId,
      publicKey: typeof body.publicKey === "string" ? body.publicKey : "",
      counter: 0,
    });
    return { status: "ok" as const, data: { credentialId: rawId }, error: null };
  }

  private async consumeBackup(user: { _id: string; backupCodeHashes?: string[] }, code: string): Promise<boolean> {
    const hashes = user.backupCodeHashes ?? [];
    for (let i = 0; i < hashes.length; i += 1) {
      if (await verify(hashes[i], code)) {
        const next = hashes.filter((_, idx) => idx !== i);
        await this.users.setBackupHashes(user._id, next);
        return true;
      }
    }
    return false;
  }
}

function challengeBytesMatch(stored: string, fromClient: string): boolean {
  if (!stored || !fromClient) return false;
  if (stored === fromClient) return true;
  try {
    return Buffer.from(stored, "base64url").equals(Buffer.from(fromClient.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url"));
  } catch {
    return false;
  }
}

import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import QRCode from 'qrcode';
import type { z } from 'zod';
import type { AppConfig } from '../../config/config.schema.js';
import type { Crypto } from '../../common/crypto/crypto.js';
import { AppError, Errors } from '../../common/errors/errors.js';
import type { RateLimitRepository } from '../../common/http/rate-limit.repository.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { SessionsRepository, UserDoc, UsersRepository } from '../auth/auth.repository.js';
import { type AuthService, type RequestMeta, type SessionResult, waitMessage } from '../auth/auth.service.js';
import type { PasswordHasher } from '../auth/tokens.js';
import type { WorkspacesService } from '../workspaces/workspaces.service.js';
import {
  type ActivityEvent,
  type ChangePasswordBody,
  type DeviceSession,
  type Passkey,
  type PasskeySignInBody,
  RECHECK_WINDOW_MS,
  type RecheckBody,
  type SecurityStatus,
  TRUSTED_DEVICE_DAYS,
  type TwoFactorSignInBody,
} from './security.contract.js';
import { newBackupCodes, newTotpSecret, normaliseBackupCode, otpauthUrl, verifyTotp } from './totp.js';

const CHALLENGE_MS = 10 * 60_000;
const MAX_CODE_FAILURES = 5;
const LOCK_SECONDS = 60;

const MESSAGES = {
  codeWrong: "That code isn't right. Check your authenticator app and try again.",
  backupWrong: "That backup code isn't right, or it was already used.",
  challengeEnded: 'This sign-in has timed out. Sign in again.',
  recheckNeeded: "Confirm it's you to continue.",
  passwordWrong: "That password isn't right.",
  passkeyFailed: "That passkey didn't work. Try again or use your password.",
  passkeysOff: "Passkeys aren't available yet.",
  alreadyOn: 'Two-factor is already on.',
  notOn: 'Two-factor is off.',
  setupFirst: 'Start setting up two-factor again.',
} as const;

type PasskeyChallenge<K extends string> = { kind: K; challenge: string; userId: string | null; exp: number };

type Challenge =
  | { kind: 'two-factor'; userId: string; staySignedIn: boolean; deviceName: string | null; exp: number }
  | PasskeyChallenge<'passkey-sign-in'>
  | PasskeyChallenge<'passkey-add'>
  | PasskeyChallenge<'passkey-recheck'>;

/** Two-factor, passkeys, devices, re-checks and the activity log (build plan B3.1 to B3.4, B3.9). */
export class SecurityService {
  constructor(
    private readonly config: AppConfig,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly auth: AuthService,
    private readonly hasher: PasswordHasher,
    private readonly crypto: Crypto,
    private readonly limits: RateLimitRepository,
    private readonly audit: AuditRepository,
    private readonly workspaces: WorkspacesService,
    private readonly now: () => Date = () => new Date(),
  ) {
    auth.secondStep = (user, body) => this.secondStep(user, body);
  }

  /* ---------- Challenges: opaque, encrypted and short-lived, so nothing is stored for them ---------- */

  private seal(c: Challenge): string {
    return this.crypto.encrypt('two-factor', JSON.stringify(c));
  }

  private open<K extends Challenge['kind']>(token: string, kind: K): Extract<Challenge, { kind: K }> {
    let c: Challenge;
    try {
      c = JSON.parse(this.crypto.decryptText('two-factor', token)) as Challenge;
    } catch {
      throw Errors.unauthorized('challenge_ended', MESSAGES.challengeEnded);
    }
    if (c.kind !== kind || c.exp < this.now().getTime())
      throw Errors.unauthorized('challenge_ended', MESSAGES.challengeEnded);
    return c as Extract<Challenge, { kind: K }>;
  }

  private key(kind: string, value: string) {
    return `${kind}:${this.crypto.hash('token-hash', value)}`;
  }

  /* ---------- Two-factor at sign-in ---------- */

  private async secondStep(
    user: UserDoc,
    body: { staySignedIn: boolean; deviceName?: string | undefined; trustedDeviceToken?: string | undefined },
  ) {
    if (!user.twoFactor) return null;
    if (body.trustedDeviceToken) {
      const hash = this.crypto.hash('token-hash', body.trustedDeviceToken);
      const now = this.now();
      if (user.twoFactor.trusted.some((t) => t.hash === hash && t.expiresAt > now)) return null;
    }
    const challengeToken = this.seal({
      kind: 'two-factor',
      userId: user._id,
      staySignedIn: body.staySignedIn,
      deviceName: body.deviceName ?? null,
      exp: this.now().getTime() + CHALLENGE_MS,
    });
    return { twoFactorRequired: true as const, challengeToken };
  }

  async finishTwoFactor(
    body: z.output<typeof TwoFactorSignInBody>,
  ): Promise<SessionResult & { trustedDeviceToken: string | null }> {
    const c = this.open(body.challengeToken, 'two-factor');
    const lockKey = `two-factor:${c.userId}`;
    const locked = await this.limits.lockedFor(lockKey);
    if (locked > 0) throw Errors.tooMany(locked, waitMessage(locked));
    const user = await this.users.byId(c.userId);
    if (!user?.twoFactor || user.deletedAt) throw Errors.unauthorized('challenge_ended', MESSAGES.challengeEnded);
    const tf = user.twoFactor;

    let ok = false;
    let backupHashes = tf.backupHashes;
    if (body.code) {
      ok = verifyTotp(this.crypto.decryptText('two-factor', tf.secret), body.code, this.now());
    } else if (body.backupCode) {
      const hash = this.crypto.hash('code-hash', normaliseBackupCode(body.backupCode));
      ok = backupHashes.includes(hash);
      backupHashes = backupHashes.filter((h) => h !== hash);
    }
    if (!ok) {
      const lock = await this.limits.fail(lockKey, MAX_CODE_FAILURES, LOCK_SECONDS);
      if (lock > 0) throw Errors.tooMany(lock, waitMessage(lock));
      throw new AppError(401, 'code_wrong', body.code ? MESSAGES.codeWrong : MESSAGES.backupWrong, {
        field: body.code ? 'code' : 'backupCode',
      });
    }
    await this.limits.clear(lockKey);

    let trustedDeviceToken: string | null = null;
    const now = this.now();
    let trusted = tf.trusted.filter((t) => t.expiresAt > now);
    if (body.trustDevice) {
      trustedDeviceToken = randomBytes(24).toString('base64url');
      trusted = [
        ...trusted,
        {
          hash: this.crypto.hash('token-hash', trustedDeviceToken),
          expiresAt: new Date(now.getTime() + TRUSTED_DEVICE_DAYS * 86_400_000),
        },
      ];
    }
    await this.users.setFields(user._id, { twoFactor: { ...tf, backupHashes, trusted } });
    const result = await this.auth.withAudit(
      user,
      body.backupCode ? 'session.signed_in_backup_code' : 'session.signed_in_two_factor',
      {
        staySignedIn: c.staySignedIn || body.staySignedIn,
        deviceName: c.deviceName ?? body.deviceName,
      },
    );
    return { ...result, trustedDeviceToken };
  }

  /* ---------- Passkeys ---------- */

  private rp() {
    const origin = this.config.corsOrigins[0];
    if (!origin) throw new AppError(404, 'passkeys_off', MESSAGES.passkeysOff);
    return { rpID: new URL(origin).hostname, origins: this.config.corsOrigins };
  }

  async passkeySignInOptions(meta: RequestMeta) {
    await this.limits.hit(`passkey-ip:${meta.ip}`, 60, 900);
    const { rpID } = this.rp();
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const challengeToken = this.seal({
      kind: 'passkey-sign-in',
      challenge: options.challenge,
      userId: null,
      exp: this.now().getTime() + CHALLENGE_MS,
    });
    return { challengeToken, options: options as unknown as Record<string, unknown> };
  }

  /** Checks a passkey answer against the stored public key and moves its counter on. */
  private async verifyPasskey(
    response: Record<string, unknown>,
    expectedChallenge: string,
    expectUserId: string | null,
  ): Promise<UserDoc> {
    const credentialId = typeof response.id === 'string' ? response.id : '';
    const user = credentialId ? await this.users.byPasskeyId(credentialId) : null;
    const stored = user?.passkeys?.find((p) => p.id === credentialId);
    if (!user || !stored || (expectUserId && user._id !== expectUserId)) {
      throw Errors.unauthorized('passkey_failed', MESSAGES.passkeyFailed);
    }
    const { rpID, origins } = this.rp();
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        credential: {
          id: stored.id,
          publicKey: Buffer.from(stored.publicKey, 'base64url'),
          counter: stored.counter,
          transports: stored.transports as never,
        },
      });
    } catch {
      throw Errors.unauthorized('passkey_failed', MESSAGES.passkeyFailed);
    }
    if (!verified.verified) throw Errors.unauthorized('passkey_failed', MESSAGES.passkeyFailed);
    const now = this.now();
    await this.users.setFields(user._id, {
      passkeys: (user.passkeys ?? []).map((p) =>
        p.id === stored.id ? { ...p, counter: verified.authenticationInfo.newCounter, lastUsedAt: now } : p,
      ),
    });
    return user;
  }

  async passkeySignIn(body: z.output<typeof PasskeySignInBody>): Promise<SessionResult> {
    const c = this.open(body.challengeToken, 'passkey-sign-in');
    const user = await this.verifyPasskey(body.response, c.challenge, null);
    // A passkey is both factors, so two-factor isn't asked again.
    return this.auth.withAudit(user, 'session.signed_in_passkey', body);
  }

  async passkeyAddOptions(userId: string) {
    const user = await this.mustUser(userId);
    const { rpID } = this.rp();
    const options = await generateRegistrationOptions({
      rpName: 'MyLedja',
      rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user._id),
      attestationType: 'none',
      excludeCredentials: (user.passkeys ?? []).map((p) => ({ id: p.id, transports: p.transports as never })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeToken = this.seal({
      kind: 'passkey-add',
      challenge: options.challenge,
      userId,
      exp: this.now().getTime() + CHALLENGE_MS,
    });
    return { challengeToken, options: options as unknown as Record<string, unknown> };
  }

  async passkeyAdd(
    userId: string,
    sessionId: string,
    body: { challengeToken: string; response: Record<string, unknown>; name: string },
  ): Promise<z.input<typeof Passkey>> {
    const c = this.open(body.challengeToken, 'passkey-add');
    if (c.userId !== userId) throw Errors.unauthorized('challenge_ended', MESSAGES.challengeEnded);
    const user = await this.mustUser(userId);
    const { rpID, origins } = this.rp();
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response as never,
        expectedChallenge: c.challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
      });
    } catch {
      throw Errors.validation('response', MESSAGES.passkeyFailed);
    }
    if (!verified.verified || !verified.registrationInfo) throw Errors.validation('response', MESSAGES.passkeyFailed);
    const cred = verified.registrationInfo.credential;
    const now = this.now();
    const passkey = {
      id: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString('base64url'),
      counter: cred.counter,
      transports: (cred.transports ?? []) as string[],
      name: body.name,
      createdAt: now,
      lastUsedAt: null,
    };
    await this.users.setFields(userId, {
      passkeys: [...(user.passkeys ?? []).filter((p) => p.id !== cred.id), passkey],
    });
    await this.record(userId, sessionId, 'security.passkey_added');
    return { id: passkey.id, name: passkey.name, createdAt: now.toISOString(), lastUsedAt: null };
  }

  async passkeyRemove(userId: string, sessionId: string, passkeyId: string) {
    const user = await this.mustUser(userId);
    if (!(user.passkeys ?? []).some((p) => p.id === passkeyId)) throw Errors.notFound();
    await this.users.setFields(userId, { passkeys: (user.passkeys ?? []).filter((p) => p.id !== passkeyId) });
    await this.record(userId, sessionId, 'security.passkey_removed');
  }

  /* ---------- Re-check before sensitive actions (DESIGN.md 10.6) ---------- */

  /** Throws 403 recheck_needed unless the person signed in or confirmed it was them in the last 15 minutes. */
  async requireRecent(sessionId: string): Promise<void> {
    const s = await this.sessions.byId(sessionId);
    const last = Math.max(s?.createdAt.getTime() ?? 0, s?.recheckedAt?.getTime() ?? 0);
    if (this.now().getTime() - last > RECHECK_WINDOW_MS)
      throw new AppError(403, 'recheck_needed', MESSAGES.recheckNeeded);
  }

  async recheck(userId: string, sessionId: string, body: z.output<typeof RecheckBody>) {
    const lockKey = `recheck:${userId}`;
    const locked = await this.limits.lockedFor(lockKey);
    if (locked > 0) throw Errors.tooMany(locked, waitMessage(locked));
    const user = await this.mustUser(userId);
    if (body.password !== undefined) {
      if (!(await this.hasher.verify(user.passwordHash, body.password))) {
        const lock = await this.limits.fail(lockKey, MAX_CODE_FAILURES, LOCK_SECONDS);
        if (lock > 0) throw Errors.tooMany(lock, waitMessage(lock));
        throw new AppError(401, 'password_wrong', MESSAGES.passwordWrong, { field: 'password' });
      }
    } else {
      const c = this.open(body.challengeToken!, 'passkey-recheck');
      await this.verifyPasskey(body.response!, c.challenge, userId);
    }
    await this.limits.clear(lockKey);
    await this.sessions.markRechecked(sessionId, this.now());
    return this.status(userId, sessionId);
  }

  /** Options for confirming with a passkey instead of the password. */
  async recheckPasskeyOptions(userId: string) {
    const user = await this.mustUser(userId);
    const { rpID } = this.rp();
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      allowCredentials: (user.passkeys ?? []).map((p) => ({ id: p.id, transports: p.transports as never })),
    });
    const challengeToken = this.seal({
      kind: 'passkey-recheck',
      challenge: options.challenge,
      userId,
      exp: this.now().getTime() + CHALLENGE_MS,
    });
    return { challengeToken, options: options as unknown as Record<string, unknown> };
  }

  /* ---------- Settings › Security ---------- */

  async status(userId: string, sessionId: string): Promise<z.input<typeof SecurityStatus>> {
    const user = await this.mustUser(userId);
    const s = await this.sessions.byId(sessionId);
    const last = Math.max(s?.createdAt.getTime() ?? 0, s?.recheckedAt?.getTime() ?? 0);
    const until = last + RECHECK_WINDOW_MS;
    return {
      hasPassword: user.passwordHash !== null,
      twoFactorOn: !!user.twoFactor,
      backupCodesLeft: user.twoFactor?.backupHashes.length ?? 0,
      passkeys: (user.passkeys ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt.toISOString(),
        lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
      })),
      recheckedUntil: until > this.now().getTime() ? new Date(until).toISOString() : null,
    };
  }

  async twoFactorSetup(userId: string) {
    const user = await this.mustUser(userId);
    if (user.twoFactor) throw new AppError(409, 'two_factor_on', MESSAGES.alreadyOn);
    const secret = newTotpSecret();
    await this.users.setFields(userId, {
      twoFactorPending: { secret: this.crypto.encrypt('two-factor', secret), createdAt: this.now() },
    });
    const url = otpauthUrl(secret, user.email);
    return { secret, otpauthUrl: url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1 }) };
  }

  async twoFactorConfirm(userId: string, sessionId: string, code: string) {
    const user = await this.mustUser(userId);
    if (user.twoFactor) throw new AppError(409, 'two_factor_on', MESSAGES.alreadyOn);
    if (!user.twoFactorPending) throw new AppError(409, 'two_factor_setup_needed', MESSAGES.setupFirst);
    const secret = this.crypto.decryptText('two-factor', user.twoFactorPending.secret);
    if (!verifyTotp(secret, code, this.now()))
      throw new AppError(400, 'code_wrong', MESSAGES.codeWrong, { field: 'code' });
    const codes = newBackupCodes();
    await this.users.setFields(userId, {
      twoFactorPending: null,
      twoFactor: {
        secret: user.twoFactorPending.secret,
        enabledAt: this.now(),
        backupHashes: codes.map((c) => this.crypto.hash('code-hash', normaliseBackupCode(c))),
        trusted: [],
      },
    });
    await this.record(userId, sessionId, 'security.two_factor_on');
    return { backupCodes: codes };
  }

  async newBackupCodes(userId: string, sessionId: string) {
    const user = await this.mustUser(userId);
    if (!user.twoFactor) throw new AppError(409, 'two_factor_off', MESSAGES.notOn);
    await this.requireRecent(sessionId);
    const codes = newBackupCodes();
    await this.users.setFields(userId, {
      twoFactor: {
        ...user.twoFactor,
        backupHashes: codes.map((c) => this.crypto.hash('code-hash', normaliseBackupCode(c))),
      },
    });
    await this.record(userId, sessionId, 'security.backup_codes_replaced');
    return { backupCodes: codes };
  }

  async twoFactorOff(userId: string, sessionId: string) {
    await this.requireRecent(sessionId);
    await this.users.setFields(userId, { twoFactor: null, twoFactorPending: null });
    await this.record(userId, sessionId, 'security.two_factor_off');
  }

  async listSessions(userId: string, currentId: string): Promise<{ sessions: z.input<typeof DeviceSession>[] }> {
    const rows = await this.sessions.listForUser(userId, this.now());
    return {
      sessions: rows.map((s) => ({
        id: s._id,
        deviceName: s.deviceName,
        staysSignedIn: s.kind === 'cookie',
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        current: s._id === currentId,
      })),
    };
  }

  async signOutSession(userId: string, currentId: string, sessionId: string) {
    const s = await this.sessions.byId(sessionId);
    if (!s || s.userId !== userId) throw Errors.notFound();
    await this.sessions.revoke(sessionId, 'signed_out_from_settings');
    await this.record(userId, currentId, 'session.signed_out_device');
  }

  async changePassword(userId: string, sessionId: string, body: z.output<typeof ChangePasswordBody>) {
    const user = await this.mustUser(userId);
    const lockKey = `recheck:${userId}`;
    const locked = await this.limits.lockedFor(lockKey);
    if (locked > 0) throw Errors.tooMany(locked, waitMessage(locked));
    if (!(await this.hasher.verify(user.passwordHash, body.currentPassword))) {
      const lock = await this.limits.fail(lockKey, MAX_CODE_FAILURES, LOCK_SECONDS);
      if (lock > 0) throw Errors.tooMany(lock, waitMessage(lock));
      throw new AppError(401, 'password_wrong', MESSAGES.passwordWrong, { field: 'currentPassword' });
    }
    await this.limits.clear(lockKey);
    await this.users.setFields(userId, { passwordHash: await this.hasher.hash(body.newPassword) });
    await this.sessions.revokeAllForUser(userId, 'password_changed', sessionId);
    await this.record(userId, sessionId, 'user.password_changed');
  }

  /* ---------- Activity log (B3.9) ---------- */

  async activity(
    ctx: WorkspaceContext,
    q: { before?: string | undefined; limit: number; action?: string | undefined },
  ) {
    const rows = await this.audit.page(ctx, {
      before: q.before ? new Date(q.before) : undefined,
      limit: q.limit,
      actionPrefix: q.action,
    });
    const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    for (const id of userIds) {
      const u = await this.users.byId(id);
      if (u) names.set(id, u.name);
    }
    const devices = new Map<string, string | null>();
    for (const id of sessionIds) devices.set(id, (await this.sessions.byId(id))?.deviceName ?? null);
    const events: z.input<typeof ActivityEvent>[] = rows.map((r) => ({
      id: r._id,
      at: r.at.toISOString(),
      action: r.action,
      who: r.userId ? (names.get(r.userId) ?? null) : null,
      device: r.sessionId ? (devices.get(r.sessionId) ?? null) : null,
      target: r.target,
    }));
    return { events, nextBefore: rows.length === q.limit ? (rows[rows.length - 1]?.at.toISOString() ?? null) : null };
  }

  /* ---------- helpers ---------- */

  private async mustUser(userId: string): Promise<UserDoc> {
    const user = await this.users.byId(userId);
    if (!user || user.deletedAt) throw Errors.unauthorized();
    return user;
  }

  private async record(userId: string, sessionId: string, action: string) {
    const ctx = await this.workspaces.personalContext(userId, sessionId).catch(() => null);
    if (ctx) await this.audit.record(ctx, { action, target: { collection: 'users', id: userId } });
  }
}

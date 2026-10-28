import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import type { AppConfig } from '../../config/config.schema.js';
import { Crypto } from '../../common/crypto/crypto.js';
import { AppError, Errors } from '../../common/errors/errors.js';
import type { RateLimitRepository } from '../../common/http/rate-limit.repository.js';
import { newId } from '../../common/ids/ids.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { Mailer } from '../notifications/email/email.js';
import type { WorkspacesService } from '../workspaces/workspaces.service.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CODE_RESEND_SECONDS,
  CODE_TTL_SECONDS,
  type GoogleBody,
  type NewPasswordBody,
  type ResendCodeBody,
  type SessionResponse,
  type SignInBody,
  type SignUpBody,
  type Tokens,
  type TwoFactorRequired,
  type VerifyEmailBody,
} from './auth.contract.js';
import type {
  CodePurpose,
  CodesRepository,
  SessionDoc,
  SessionKind,
  SessionsRepository,
  UserDoc,
  UsersRepository,
} from './auth.repository.js';
import {
  type GoogleVerifier,
  newEmailCode,
  newRefreshSecret,
  type PasswordHasher,
  splitRefreshToken,
  type TokenService,
} from './tokens.js';

const DAY = 86_400_000;
/** Web "Stay signed in": 30 days at most, or 7 days without use (DESIGN.md P01-04). */
export const COOKIE_ABSOLUTE_MS = 30 * DAY;
export const COOKIE_IDLE_MS = 7 * DAY;
/** Phone and in-memory web sessions end after 90 days without use (docs/QUESTIONS.md Q-B6). */
export const TOKEN_IDLE_MS = 90 * DAY;
export const MAX_CODE_TRIES = 5;
export const SIGN_IN_MAX_FAILURES = 5;
export const SIGN_IN_LOCK_SECONDS = 60;

export const AUTH_MESSAGES = {
  wrongDetails: 'Email or password is wrong',
  codeWrong: "That code isn't right. Check the email and try again.",
  codeExpired: 'This code has expired. Send a new one.',
  notVerified: 'Check your email for a code to finish creating your account',
  googleOff: "Google sign-in isn't available yet. Use your email and password.",
  googleRefused: "Google couldn't confirm this account. Try again or use your email and password.",
  googleLinkNeeded:
    'This email already has a MyLedja password. Sign in with it, or with an email code, once to link Google.',
  googleLinkInvalid: 'Continue with Google again to link it.',
  googleTaken: 'This Google account is already linked to another MyLedja account.',
  sessionEnded: 'Your session has ended. Sign in again.',
  clientHeaderMissing: 'Update the app and sign in again.',
} as const;

type SessionBody = z.input<typeof SessionResponse> | z.input<typeof TwoFactorRequired>;
export type SessionResult = { body: SessionBody; cookie: string | null };
export type RefreshResult = { body: z.input<typeof Tokens>; cookie: string | null };
export type RequestMeta = { ip: string };

export function waitMessage(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? 'Wait 1 minute' : `Wait ${minutes} minutes`;
}

/** Asks for a second step (two-factor) before a session starts; set by the security module. */
export type SecondStep = (
  user: UserDoc,
  body: { staySignedIn: boolean; deviceName?: string | undefined; trustedDeviceToken?: string | undefined },
) => Promise<z.input<typeof TwoFactorRequired> | null>;

export class AuthService {
  secondStep: SecondStep | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly codes: CodesRepository,
    private readonly limits: RateLimitRepository,
    private readonly audit: AuditRepository,
    private readonly workspaces: WorkspacesService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly crypto: Crypto,
    private readonly mailer: Mailer,
    private readonly google: GoogleVerifier | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(kind: string, value: string) {
    return `${kind}:${this.crypto.hash('token-hash', value)}`;
  }

  private codeSent() {
    return { codeExpiresInSeconds: CODE_TTL_SECONDS, resendAfterSeconds: CODE_RESEND_SECONDS } as const;
  }

  async signUp(body: z.output<typeof SignUpBody>, meta: RequestMeta) {
    await this.limits.hit(this.key('signup-ip', meta.ip), 20, 3600);
    await this.limits.hit(this.key('signup-email', body.email), 5, 3600);
    const passwordHash = await this.hasher.hash(body.password);
    const existing = await this.users.byEmail(body.email);
    const now = this.now();
    if (existing?.emailVerifiedAt) {
      await this.mailer.alreadyRegistered(body.email);
      return this.codeSent();
    }
    if (existing) {
      await this.users.update(existing._id, { name: body.name, passwordHash, termsAcceptedAt: now });
    } else {
      await this.users.insert({
        _id: newId(),
        email: body.email,
        name: body.name,
        passwordHash,
        googleId: null,
        emailVerifiedAt: null,
        termsAcceptedAt: now,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }
    const code = await this.issueCode(body.email, 'sign_up', true);
    if (code) await this.mailer.signUpCode(body.email, body.name, code);
    return this.codeSent();
  }

  async resendCode(body: z.output<typeof ResendCodeBody>, meta: RequestMeta) {
    await this.limits.hit(this.key('code-ip', meta.ip), 30, 3600);
    await this.limits.hit(this.key('code-email', body.email), 10, 3600);
    const user = await this.users.byEmail(body.email);
    const wanted = body.purpose === 'sign_up' ? user && !user.emailVerifiedAt : user?.emailVerifiedAt;
    if (user && wanted) {
      const code = await this.issueCode(body.email, body.purpose, false);
      if (code && body.purpose === 'sign_up') await this.mailer.signUpCode(body.email, user.name, code);
      if (code && body.purpose === 'recover') await this.mailer.recoverCode(body.email, code);
    }
    return this.codeSent();
  }

  /** Makes a new code, unless one was made under 45 seconds ago and `force` is off. */
  private async issueCode(email: string, purpose: CodePurpose, force: boolean): Promise<string | null> {
    const now = this.now();
    const current = await this.codes.find(email, purpose);
    if (!force && current && now.getTime() - current.createdAt.getTime() < CODE_RESEND_SECONDS * 1000) return null;
    const code = newEmailCode();
    await this.codes.put({
      _id: newId(),
      email,
      purpose,
      hash: this.crypto.hash('code-hash', `${purpose}:${email}:${code}`),
      tries: 0,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CODE_TTL_SECONDS * 1000),
    });
    return code;
  }

  /** Checks a code; wrong tries count, and the fifth kills it. Returns the code's id to delete on success. */
  private async checkCode(email: string, purpose: CodePurpose, code: string): Promise<string> {
    const doc = await this.codes.find(email, purpose);
    if (!doc || doc.expiresAt.getTime() <= this.now().getTime()) {
      throw new AppError(400, 'code_expired', AUTH_MESSAGES.codeExpired, { field: 'code' });
    }
    if (!Crypto.equal(doc.hash, this.crypto.hash('code-hash', `${purpose}:${email}:${code}`))) {
      const tries = await this.codes.addTry(doc._id);
      if (tries >= MAX_CODE_TRIES) {
        await this.codes.remove(doc._id);
        throw new AppError(400, 'code_expired', AUTH_MESSAGES.codeExpired, { field: 'code' });
      }
      throw new AppError(400, 'code_wrong', AUTH_MESSAGES.codeWrong, { field: 'code' });
    }
    return doc._id;
  }

  async verifyEmail(body: z.output<typeof VerifyEmailBody>, meta: RequestMeta): Promise<SessionResult> {
    await this.limits.hit(this.key('verify-ip', meta.ip), 30, 900);
    const user = await this.users.byEmail(body.email);
    if (!user || user.emailVerifiedAt)
      throw new AppError(400, 'code_expired', AUTH_MESSAGES.codeExpired, { field: 'code' });
    const codeId = await this.checkCode(body.email, 'sign_up', body.code);
    return this.database.transaction(async (session) => {
      await this.codes.remove(codeId, { session });
      await this.users.update(user._id, { emailVerifiedAt: this.now() }, { session });
      const ctx = await this.workspaces.createPersonal(user._id, session);
      await this.audit.record(
        ctx,
        { action: 'user.signed_up', target: { collection: 'users', id: user._id } },
        { session },
      );
      return this.startSession({ ...user, emailVerifiedAt: this.now() }, body.staySignedIn, body.deviceName, session);
    });
  }

  async signIn(body: z.output<typeof SignInBody>, meta: RequestMeta): Promise<SessionResult> {
    if (body.code && body.googleLinkToken) {
      return this.signInWithEmailCodeLink({ ...body, code: body.code, googleLinkToken: body.googleLinkToken }, meta);
    }

    await this.limits.hit(this.key('signin-ip', meta.ip), 100, 900);
    const lockKey = this.key('signin', body.email);
    const locked = await this.limits.lockedFor(lockKey);
    if (locked > 0) throw Errors.tooMany(locked, waitMessage(locked));

    const user = await this.users.byEmail(body.email);
    const ok = await this.hasher.verify(user?.passwordHash ?? null, body.password ?? '');
    if (!user || !ok) {
      const lock = await this.limits.fail(lockKey, SIGN_IN_MAX_FAILURES, SIGN_IN_LOCK_SECONDS);
      if (lock > 0) throw Errors.tooMany(lock, waitMessage(lock));
      throw Errors.unauthorized('sign_in_wrong', AUTH_MESSAGES.wrongDetails);
    }
    await this.limits.clear(lockKey);

    if (!user.emailVerifiedAt) {
      const code = await this.issueCode(user.email, 'sign_up', false);
      if (code) await this.mailer.signUpCode(user.email, user.name, code);
      throw new AppError(403, 'email_not_verified', AUTH_MESSAGES.notVerified);
    }

    const linked = body.googleLinkToken ? await this.applyGoogleLink(user, body.googleLinkToken) : user;
    const challenge = await this.secondStep?.(linked, body);
    if (challenge) return { body: challenge, cookie: null };

    return this.database.transaction(async (session) => {
      const result = await this.startSession(linked, body.staySignedIn, body.deviceName, session);
      const ctx = await this.workspaces.personalContext(user._id, null, session);
      await this.audit.record(
        ctx,
        {
          action: body.googleLinkToken ? 'user.google_linked' : 'session.signed_in',
          target: { collection: 'users', id: user._id },
          sessionId: result.sessionId,
        },
        { session },
      );
      return result;
    });
  }

  /**
   * B0.8 / TECH-SPEC 5.8: link Google after the person proves the email with a recovery code
   * (POST /v1/auth/recover), without needing the password.
   */
  private async signInWithEmailCodeLink(
    body: z.output<typeof SignInBody> & { code: string; googleLinkToken: string },
    meta: RequestMeta,
  ): Promise<SessionResult> {
    await this.limits.hit(this.key('verify-ip', meta.ip), 30, 900);
    const user = await this.users.byEmail(body.email);
    if (!user?.emailVerifiedAt) {
      throw new AppError(400, 'code_expired', AUTH_MESSAGES.codeExpired, { field: 'code' });
    }
    const codeId = await this.checkCode(body.email, 'recover', body.code);
    const linked = await this.applyGoogleLink(user, body.googleLinkToken);
    await this.limits.clear(this.key('signin', body.email));
    return this.database.transaction(async (session) => {
      await this.codes.remove(codeId, { session });
      const result = await this.startSession(linked, body.staySignedIn, body.deviceName, session);
      const ctx = await this.workspaces.personalContext(user._id, null, session);
      await this.audit.record(
        ctx,
        {
          action: 'user.google_linked',
          target: { collection: 'users', id: user._id },
          sessionId: result.sessionId,
        },
        { session },
      );
      return result;
    });
  }

  private async applyGoogleLink(user: UserDoc, googleLinkToken: string): Promise<UserDoc> {
    const link = await this.tokens.verifyGoogleLink(googleLinkToken);
    if (!link || link.email !== user.email) {
      throw new AppError(400, 'google_link_invalid', AUTH_MESSAGES.googleLinkInvalid, { field: 'googleLinkToken' });
    }
    const other = await this.users.byGoogleId(link.googleId);
    if (other && other._id !== user._id) throw new AppError(409, 'google_taken', AUTH_MESSAGES.googleTaken);
    await this.users.update(user._id, { googleId: link.googleId });
    return { ...user, googleId: link.googleId };
  }

  async signInWithGoogle(body: z.output<typeof GoogleBody>, meta: RequestMeta): Promise<SessionResult> {
    if (!this.google) throw new AppError(404, 'google_off', AUTH_MESSAGES.googleOff);
    await this.limits.hit(this.key('google-ip', meta.ip), 60, 900);
    const id = await this.google.verify(body.idToken);
    if (!id || !id.emailVerified) throw Errors.unauthorized('google_refused', AUTH_MESSAGES.googleRefused);

    const byGoogle = await this.users.byGoogleId(id.googleId);
    if (byGoogle) {
      const challenge = await this.secondStep?.(byGoogle, body);
      if (challenge) return { body: challenge, cookie: null };
      return this.withAudit(byGoogle, 'session.signed_in_google', body);
    }

    const byEmail = await this.users.byEmail(id.email);
    if (byEmail?.emailVerifiedAt && byEmail.passwordHash) {
      throw new AppError(409, 'google_link_needed', AUTH_MESSAGES.googleLinkNeeded, {
        email: id.email,
        linkToken: await this.tokens.googleLink(id.email, id.googleId),
      });
    }

    return this.database.transaction(async (session) => {
      const now = this.now();
      let user: UserDoc;
      if (byEmail) {
        // An unconfirmed sign-up: Google proves the email, so any password set by whoever started it is dropped.
        user = { ...byEmail, passwordHash: null, googleId: id.googleId, emailVerifiedAt: now };
        await this.users.update(
          byEmail._id,
          { passwordHash: null, googleId: id.googleId, emailVerifiedAt: now },
          { session },
        );
        const pending = await this.codes.find(id.email, 'sign_up');
        if (pending) await this.codes.remove(pending._id, { session });
      } else {
        user = {
          _id: newId(),
          email: id.email,
          name: id.name ?? id.email.split('@')[0]!,
          passwordHash: null,
          googleId: id.googleId,
          emailVerifiedAt: now,
          termsAcceptedAt: now,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        await this.users.insert(user, { session });
      }
      const ctx = await this.workspaces.createPersonal(user._id, session);
      await this.audit.record(
        ctx,
        { action: 'user.signed_up_google', target: { collection: 'users', id: user._id } },
        { session },
      );
      return this.startSession(user, body.staySignedIn, body.deviceName, session);
    });
  }

  /** Starts a session and records it; the security module uses it after two-factor or a passkey. */
  withAudit(user: UserDoc, action: string, body: { staySignedIn: boolean; deviceName?: string | undefined }) {
    return this.database.transaction(async (session) => {
      const result = await this.startSession(user, body.staySignedIn, body.deviceName, session);
      const ctx = await this.workspaces.personalContext(user._id, null, session);
      await this.audit.record(
        ctx,
        { action, target: { collection: 'users', id: user._id }, sessionId: result.sessionId },
        { session },
      );
      return result;
    });
  }

  private async startSession(
    user: UserDoc,
    staySignedIn: boolean,
    deviceName: string | undefined,
    session: ClientSession,
  ): Promise<SessionResult & { sessionId: string }> {
    const now = this.now();
    const kind: SessionKind = staySignedIn ? 'cookie' : 'token';
    const secret = newRefreshSecret();
    const doc: SessionDoc = {
      _id: newId(),
      userId: user._id,
      refreshHash: this.crypto.hash('token-hash', secret),
      previousHashes: [],
      kind,
      deviceName: deviceName ?? null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + (kind === 'cookie' ? COOKIE_IDLE_MS : TOKEN_IDLE_MS)),
      absoluteExpiresAt: kind === 'cookie' ? new Date(now.getTime() + COOKIE_ABSOLUTE_MS) : null,
      revokedAt: null,
      revokedReason: null,
    };
    await this.sessions.insert(doc, { session });
    const refreshToken = `${doc._id}.${secret}`;
    const accessToken = await this.tokens.access({ userId: user._id, sessionId: doc._id });
    const userView = await this.workspaces.userView(user, doc._id, session);
    return {
      sessionId: doc._id,
      cookie: kind === 'cookie' ? refreshToken : null,
      body: {
        accessToken,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: kind === 'cookie' ? null : refreshToken,
        user: userView,
      },
    };
  }

  /**
   * Rotates the refresh token. Presenting a token that was already rotated away is reuse: every session
   * for that person ends (TECH-SPEC 10).
   */
  async refresh(token: string, viaCookie: boolean, meta: RequestMeta): Promise<RefreshResult> {
    await this.limits.hit(this.key('refresh-ip', meta.ip), 300, 900);
    const ended = () => Errors.unauthorized('session_ended', AUTH_MESSAGES.sessionEnded);
    const parts = splitRefreshToken(token);
    if (!parts) throw ended();
    const s = await this.sessions.byId(parts.sessionId);
    if (!s) throw ended();
    const presented = this.crypto.hash('token-hash', parts.secret);
    if (!Crypto.equal(s.refreshHash, presented)) {
      if (s.previousHashes.some((h) => Crypto.equal(h, presented))) {
        await this.sessions.revokeAllForUser(s.userId, 'refresh_reused');
        await this.auditFor(s.userId, 'session.refresh_reused', s._id);
      }
      throw ended();
    }
    const now = this.now();
    const user = await this.users.byId(s.userId);
    if (
      !user ||
      s.revokedAt ||
      s.expiresAt.getTime() <= now.getTime() ||
      (s.absoluteExpiresAt && s.absoluteExpiresAt.getTime() <= now.getTime()) ||
      (viaCookie && s.kind !== 'cookie')
    ) {
      throw ended();
    }
    const secret = newRefreshSecret();
    const idle = s.kind === 'cookie' ? COOKIE_IDLE_MS : TOKEN_IDLE_MS;
    let expiresAt = new Date(now.getTime() + idle);
    if (s.absoluteExpiresAt && s.absoluteExpiresAt < expiresAt) expiresAt = s.absoluteExpiresAt;
    const rotated = await this.sessions.rotate(
      s._id,
      s.refreshHash,
      this.crypto.hash('token-hash', secret),
      now,
      expiresAt,
    );
    if (!rotated) throw ended();
    const refreshToken = `${s._id}.${secret}`;
    return {
      cookie: s.kind === 'cookie' ? refreshToken : null,
      body: {
        accessToken: await this.tokens.access({ userId: s.userId, sessionId: s._id }),
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: s.kind === 'cookie' ? null : refreshToken,
      },
    };
  }

  /** Checks an access token's session on every request, so a sign-out takes effect at once. */
  async authenticate(bearer: string): Promise<{ userId: string; sessionId: string } | null> {
    const claims = await this.tokens.verifyAccess(bearer);
    if (!claims) return null;
    const s = await this.sessions.byId(claims.sessionId);
    const now = this.now().getTime();
    if (!s || s.revokedAt || s.userId !== claims.userId || s.expiresAt.getTime() <= now) return null;
    return claims;
  }

  async signOut(userId: string, sessionId: string) {
    await this.sessions.revoke(sessionId, 'signed_out');
    await this.auditFor(userId, 'session.signed_out', sessionId);
  }

  async signOutOthers(userId: string, sessionId: string) {
    const signedOut = await this.sessions.revokeAllForUser(userId, 'signed_out_by_other', sessionId);
    await this.auditFor(userId, 'session.signed_out_others', sessionId);
    return { signedOut };
  }

  async recover(email: string, meta: RequestMeta) {
    await this.limits.hit(this.key('recover-ip', meta.ip), 20, 3600);
    await this.limits.hit(this.key('recover-email', email), 5, 3600);
    const user = await this.users.byEmail(email);
    if (user?.emailVerifiedAt) {
      const code = await this.issueCode(email, 'recover', true);
      if (code) await this.mailer.recoverCode(email, code);
    }
    return this.codeSent();
  }

  async newPassword(body: z.output<typeof NewPasswordBody>, meta: RequestMeta) {
    await this.limits.hit(this.key('verify-ip', meta.ip), 30, 900);
    const user = await this.users.byEmail(body.email);
    if (!user?.emailVerifiedAt) throw new AppError(400, 'code_expired', AUTH_MESSAGES.codeExpired, { field: 'code' });
    const codeId = await this.checkCode(body.email, 'recover', body.code);
    const passwordHash = await this.hasher.hash(body.newPassword);
    await this.database.transaction(async (session) => {
      await this.codes.remove(codeId, { session });
      await this.users.update(user._id, { passwordHash }, { session });
      await this.sessions.revokeAllForUser(user._id, 'password_changed', null, { session });
      const ctx = await this.workspaces.personalContext(user._id, null, session);
      await this.audit.record(
        ctx,
        { action: 'user.password_changed', target: { collection: 'users', id: user._id } },
        { session },
      );
    });
    await this.limits.clear(this.key('signin', body.email));
    await this.mailer.passwordChanged(user.email);
  }

  async me(userId: string, sessionId: string) {
    const user = await this.users.byId(userId);
    if (!user) throw Errors.unauthorized();
    return this.workspaces.userView(user, sessionId);
  }

  private async auditFor(userId: string, action: string, sessionId: string) {
    const ctx = await this.workspaces.personalContext(userId, sessionId).catch(() => null);
    if (ctx) await this.audit.record(ctx, { action, target: { collection: 'sessions', id: sessionId } });
  }

  get cookieSecure(): boolean {
    return this.config.appUrl.startsWith('https://');
  }
}

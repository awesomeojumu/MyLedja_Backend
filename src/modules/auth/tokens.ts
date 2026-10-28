import { randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.contract.js';

const ISSUER = 'myledja';
const AUDIENCE = 'myledja-app';

export type AccessClaims = { userId: string; sessionId: string };

/** Access tokens: 15 minutes, HS256 with JWT_SECRET, which is used for nothing else (TECH-SPEC 10). */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    jwtSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.key = new TextEncoder().encode(jwtSecret);
  }

  async access(claims: AccessClaims): Promise<string> {
    const iat = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({ sid: claims.sessionId, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
        currentDate: this.now(),
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      return { userId: payload.sub, sessionId: payload.sid };
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) return null;
      throw e;
    }
  }

  /** A short-lived proof that Google vouched for this email, used to link Google after a password sign-in. */
  async googleLink(email: string, googleId: string): Promise<string> {
    const iat = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({ typ: 'google-link', email, gid: googleId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 600)
      .sign(this.key);
  }

  async verifyGoogleLink(token: string): Promise<{ email: string; googleId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
        currentDate: this.now(),
      });
      if (payload.typ !== 'google-link' || typeof payload.email !== 'string' || typeof payload.gid !== 'string') {
        return null;
      }
      return { email: payload.email, googleId: payload.gid };
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) return null;
      throw e;
    }
  }
}

/** A refresh token is `<sessionId>.<secret>`; only a keyed hash of the secret is stored. */
export function newRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function splitRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return m ? { sessionId: m[1]!, secret: m[2]! } : null;
}

export function newEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export type HasherOptions = { memoryCost: number; timeCost: number; parallelism: number };

/** OWASP's Argon2id minimum: 19 MiB, 2 passes. */
export const DEFAULT_HASHER: HasherOptions = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/** Argon2id (TECH-SPEC 10). `@node-rs/argon2` uses Argon2id by default. */
export class PasswordHasher {
  private dummy: Promise<string> | null = null;

  constructor(private readonly options: HasherOptions = DEFAULT_HASHER) {}

  hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  async verify(stored: string | null, password: string): Promise<boolean> {
    if (!stored) {
      // Same work when there's no account, so timing doesn't reveal who has one.
      this.dummy ??= this.hash(randomBytes(16).toString('hex'));
      await verify(await this.dummy, password).catch(() => false);
      return false;
    }
    try {
      return await verify(stored, password);
    } catch {
      return false;
    }
  }
}

export type GoogleIdentity = { googleId: string; email: string; emailVerified: boolean; name: string | null };

export interface GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity | null>;
}

/** Checks a Google ID token's signature, issuer, audience and expiry against Google's published keys. */
export class JoseGoogleVerifier implements GoogleVerifier {
  private readonly jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

  constructor(private readonly clientId: string) {}

  async verify(idToken: string): Promise<GoogleIdentity | null> {
    try {
      const { payload } = await jwtVerify(idToken, this.jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.clientId,
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
      return {
        googleId: payload.sub,
        email: payload.email.toLowerCase(),
        emailVerified: payload.email_verified === true,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch {
      return null;
    }
  }
}

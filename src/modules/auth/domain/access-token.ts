import { jwtVerify, SignJWT } from "jose";
import { AuthFailure } from "@/modules/auth/domain/auth-failure";

export const ACCESS_TTL_SECONDS = 15 * 60;

const ALGORITHM = "HS256";

export interface AccessClaims {
  userId: string;
  sid: string;
}

function keyFrom(secret: string): Uint8Array {
  if (secret.length < 32) {
    throw new Error("JWT_SECRET is required");
  }
  return new TextEncoder().encode(secret);
}

/** Signed with jose, a maintained JOSE library; no hand-written token crypto (ADR-0004). */
export async function signAccessToken(
  claims: AccessClaims,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TTL_SECONDS)
    .sign(keyFrom(secret));
}

export async function readAccessToken(token: string, secret: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, keyFrom(secret), { algorithms: [ALGORITHM] });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      throw new AuthFailure("unauthorized", "invalid access token");
    }
    return { userId: payload.sub, sid: payload.sid };
  } catch {
    throw new AuthFailure("unauthorized", "invalid access token");
  }
}

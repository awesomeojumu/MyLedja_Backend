import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { loadConfig } from "../../../config/env";
import { AccessClaims, readAccessToken } from "../domain/access-token";
import { AuthFailure } from "../domain/auth-failure";
import { SessionsRepository } from "../repositories/sessions.repository";

export const AUTH_CONTEXT = "authContext";

export function getAuth(req: Request): AccessClaims {
  const auth = (req as Request & { [AUTH_CONTEXT]?: AccessClaims })[AUTH_CONTEXT];
  if (!auth) {
    throw new AuthFailure("unauthorized", "invalid access token");
  }
  return auth;
}

/** Checks the token and that its session is still live, so logout and password reset take effect at once. */
@Injectable()
export class RequireAccessToken implements CanActivate {
  constructor(private readonly sessions: SessionsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { [AUTH_CONTEXT]?: AccessClaims }>();
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException({ status: "error", error: "invalid access token" });
    }
    try {
      const claims = await readAccessToken(header.slice("Bearer ".length), loadConfig().jwtSecret);
      const session = await this.sessions.findById(claims.sid);
      const now = new Date();
      if (
        !session ||
        session.userId !== claims.userId ||
        session.revokedAt ||
        session.absoluteExpiresAt <= now
      ) {
        throw new AuthFailure("unauthorized", "invalid access token");
      }
      req[AUTH_CONTEXT] = claims;
      return true;
    } catch {
      throw new UnauthorizedException({ status: "error", error: "invalid access token" });
    }
  }
}

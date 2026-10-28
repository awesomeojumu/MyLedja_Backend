import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Errors } from '../errors/errors.js';
import { type ContractRequest, routeOf } from '../http/contract.interceptor.js';
import { Uuid } from '../http/schemas.js';
import { memberContext, type WorkspaceContext } from '../workspace/workspace-context.js';
import { roleAllows } from './roles.js';

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');
export const MEMBERSHIPS = Symbol('MEMBERSHIPS');

export interface Authenticator {
  authenticate(bearer: string): Promise<{ userId: string; sessionId: string } | null>;
}
export interface Memberships {
  of(userId: string, workspaceId: string): Promise<{ role: import('./roles.js').Role } | null>;
}

export type AuthedRequest = ContractRequest & {
  auth?: { userId: string; sessionId: string };
  ctx?: WorkspaceContext;
};

/**
 * Every request: signed in → member of the workspace → role allows it → then the module (TECH-SPEC 5.5).
 * A non-member gets 404, so workspace ids can't be probed.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    @Inject(MEMBERSHIPS) private readonly memberships: Memberships,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = routeOf(context);
    if (!route || route.access.kind === 'public') return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const auth = bearer ? await this.authenticator.authenticate(bearer) : null;
    if (!auth) throw Errors.unauthorized();
    req.auth = auth;

    if (route.access.kind === 'workspace') {
      const workspaceId = (req.params as Record<string, string> | undefined)?.workspaceId;
      if (!workspaceId || !Uuid.safeParse(workspaceId).success) throw Errors.notFound();
      const membership = await this.memberships.of(auth.userId, workspaceId.toLowerCase());
      if (!membership) throw Errors.notFound();
      if (!roleAllows(membership.role, route.access.minRole)) throw Errors.forbidden();
      req.ctx = memberContext({
        workspaceId: workspaceId.toLowerCase(),
        userId: auth.userId,
        sessionId: auth.sessionId,
        role: membership.role,
      });
    }
    return true;
  }
}

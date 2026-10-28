import { Controller, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import type { SessionResult } from '../auth/auth.service.js';
import { securityRoutes as r } from './security.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class SecurityController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private session(result: SessionResult, req: Req, reply: FastifyReply) {
    if (result.cookie) {
      this.s.writeCookie(reply, result.cookie);
      req.issuedCookie = result.cookie;
    }
    return result.body;
  }

  @Route(r.twoFactorSignIn)
  async twoFactorSignIn(
    @In() i: Input<typeof r.twoFactorSignIn>,
    @Req() req: Req,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Output<typeof r.twoFactorSignIn>> {
    const result = await this.s.security.finishTwoFactor(i.body);
    const body = this.session(result, req, reply) as Output<typeof r.passkeySignIn>;
    return { ...body, trustedDeviceToken: result.trustedDeviceToken };
  }

  @Route(r.passkeySignInOptions)
  passkeySignInOptions(@Req() req: Req): Promise<Output<typeof r.passkeySignInOptions>> {
    return this.s.security.passkeySignInOptions({ ip: req.ip });
  }

  @Route(r.passkeySignIn)
  async passkeySignIn(
    @In() i: Input<typeof r.passkeySignIn>,
    @Req() req: Req,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Output<typeof r.passkeySignIn>> {
    return this.session(await this.s.security.passkeySignIn(i.body), req, reply) as Output<typeof r.passkeySignIn>;
  }

  @Route(r.recheck)
  recheck(@In() i: Input<typeof r.recheck>, @Req() req: Req): Promise<Output<typeof r.recheck>> {
    return this.s.security.recheck(req.auth!.userId, req.auth!.sessionId, i.body);
  }

  @Route(r.recheckPasskeyOptions)
  recheckPasskeyOptions(@Req() req: Req): Promise<Output<typeof r.recheckPasskeyOptions>> {
    return this.s.security.recheckPasskeyOptions(req.auth!.userId);
  }

  @Route(r.status)
  status(@Req() req: Req): Promise<Output<typeof r.status>> {
    return this.s.security.status(req.auth!.userId, req.auth!.sessionId);
  }

  @Route(r.twoFactorSetup)
  twoFactorSetup(@Req() req: Req): Promise<Output<typeof r.twoFactorSetup>> {
    return this.s.security.twoFactorSetup(req.auth!.userId);
  }

  @Route(r.twoFactorConfirm)
  twoFactorConfirm(
    @In() i: Input<typeof r.twoFactorConfirm>,
    @Req() req: Req,
  ): Promise<Output<typeof r.twoFactorConfirm>> {
    return this.s.security.twoFactorConfirm(req.auth!.userId, req.auth!.sessionId, i.body.code);
  }

  @Route(r.backupCodes)
  backupCodes(@Req() req: Req): Promise<Output<typeof r.backupCodes>> {
    return this.s.security.newBackupCodes(req.auth!.userId, req.auth!.sessionId);
  }

  @Route(r.twoFactorOff)
  twoFactorOff(@Req() req: Req): Promise<void> {
    return this.s.security.twoFactorOff(req.auth!.userId, req.auth!.sessionId);
  }

  @Route(r.passkeyAddOptions)
  passkeyAddOptions(@Req() req: Req): Promise<Output<typeof r.passkeyAddOptions>> {
    return this.s.security.passkeyAddOptions(req.auth!.userId);
  }

  @Route(r.passkeyAdd)
  passkeyAdd(@In() i: Input<typeof r.passkeyAdd>, @Req() req: Req): Promise<Output<typeof r.passkeyAdd>> {
    return this.s.security.passkeyAdd(req.auth!.userId, req.auth!.sessionId, i.body);
  }

  @Route(r.passkeyRemove)
  passkeyRemove(@In() i: Input<typeof r.passkeyRemove>, @Req() req: Req): Promise<void> {
    return this.s.security.passkeyRemove(req.auth!.userId, req.auth!.sessionId, i.params.passkeyId);
  }

  @Route(r.sessions)
  sessions(@Req() req: Req): Promise<Output<typeof r.sessions>> {
    return this.s.security.listSessions(req.auth!.userId, req.auth!.sessionId);
  }

  @Route(r.signOutSession)
  signOutSession(@In() i: Input<typeof r.signOutSession>, @Req() req: Req): Promise<void> {
    return this.s.security.signOutSession(req.auth!.userId, req.auth!.sessionId, i.params.sessionId);
  }

  @Route(r.changePassword)
  changePassword(@In() i: Input<typeof r.changePassword>, @Req() req: Req): Promise<void> {
    return this.s.security.changePassword(req.auth!.userId, req.auth!.sessionId, i.body);
  }

  @Route(r.activity)
  activity(@In() i: Input<typeof r.activity>, @Req() req: Req): Promise<Output<typeof r.activity>> {
    return this.s.security.activity(req.ctx!, i.query);
  }
}

import { Controller, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { REFRESH_COOKIE, SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { AppError } from '../../common/errors/errors.js';
import { CLIENT_HEADER, type Input, type Output, Route } from '../../common/http/contract.js';
import { In } from '../../common/http/contract.interceptor.js';
import { authRoutes, meRoutes } from './auth.contract.js';
import { AUTH_MESSAGES, type SessionResult } from './auth.service.js';

const r = authRoutes;

@Controller()
export class AuthController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private meta(req: AuthedRequest) {
    return { ip: req.ip };
  }

  private session(result: SessionResult, req: AuthedRequest, reply: FastifyReply) {
    if (result.cookie) {
      this.s.writeCookie(reply, result.cookie);
      req.issuedCookie = result.cookie;
    }
    return result.body;
  }

  @Route(r.signUp)
  signUp(@In() i: Input<typeof r.signUp>, @Req() req: AuthedRequest): Promise<Output<typeof r.signUp>> {
    return this.s.auth.signUp(i.body, this.meta(req));
  }

  @Route(r.resendCode)
  resendCode(@In() i: Input<typeof r.resendCode>, @Req() req: AuthedRequest): Promise<Output<typeof r.resendCode>> {
    return this.s.auth.resendCode(i.body, this.meta(req));
  }

  @Route(r.verifyEmail)
  async verifyEmail(
    @In() i: Input<typeof r.verifyEmail>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Output<typeof r.verifyEmail>> {
    // Verifying the email always starts a session; two-factor isn't on yet for a new account.
    return this.session(await this.s.auth.verifyEmail(i.body, this.meta(req)), req, reply) as Output<
      typeof r.verifyEmail
    >;
  }

  @Route(r.signIn)
  async signIn(
    @In() i: Input<typeof r.signIn>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Output<typeof r.signIn>> {
    return this.session(await this.s.auth.signIn(i.body, this.meta(req)), req, reply);
  }

  @Route(r.google)
  async google(
    @In() i: Input<typeof r.google>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Output<typeof r.google>> {
    return this.session(await this.s.auth.signInWithGoogle(i.body, this.meta(req)), req, reply);
  }

  @Route(r.refresh)
  async refresh(
    @In() i: Input<typeof r.refresh>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Output<typeof r.refresh>> {
    const csrf = () => new AppError(403, 'client_header_missing', AUTH_MESSAGES.clientHeaderMissing);
    if (!req.headers[CLIENT_HEADER]) throw csrf();
    let token = i.body.refreshToken;
    const viaCookie = !token;
    if (viaCookie) {
      const origin = req.headers.origin;
      if (!origin || !this.s.config.corsOrigins.includes(origin)) throw csrf();
      token = req.cookies?.[REFRESH_COOKIE];
    }
    if (!token) throw new AppError(401, 'session_ended', AUTH_MESSAGES.sessionEnded);
    try {
      const result = await this.s.auth.refresh(token, viaCookie, this.meta(req));
      if (result.cookie) this.s.writeCookie(reply, result.cookie);
      return result.body;
    } catch (e) {
      if (viaCookie) this.s.clearCookie(reply);
      throw e;
    }
  }

  @Route(r.signOut)
  async signOut(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.s.auth.signOut(req.auth!.userId, req.auth!.sessionId);
    this.s.clearCookie(reply);
  }

  @Route(r.signOutOthers)
  signOutOthers(@Req() req: AuthedRequest): Promise<Output<typeof r.signOutOthers>> {
    return this.s.auth.signOutOthers(req.auth!.userId, req.auth!.sessionId);
  }

  @Route(r.recover)
  recover(@In() i: Input<typeof r.recover>, @Req() req: AuthedRequest): Promise<Output<typeof r.recover>> {
    return this.s.auth.recover(i.body.email, this.meta(req));
  }

  @Route(r.newPassword)
  async newPassword(@In() i: Input<typeof r.newPassword>, @Req() req: AuthedRequest): Promise<void> {
    await this.s.auth.newPassword(i.body, this.meta(req));
  }

  @Route(meRoutes.me)
  me(@Req() req: AuthedRequest): Promise<Output<typeof meRoutes.me>> {
    return this.s.auth.me(req.auth!.userId, req.auth!.sessionId);
  }
}

import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { In } from '../../common/http/contract.interceptor.js';
import { workspaceRoutes } from './workspaces.contract.js';

@Controller()
export class WorkspacesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(workspaceRoutes.get)
  get(@Req() req: AuthedRequest): Promise<Output<typeof workspaceRoutes.get>> {
    return this.s.workspaces.get(req.ctx!);
  }

  @Route(workspaceRoutes.setup)
  async setup(
    @In() i: Input<typeof workspaceRoutes.setup>,
    @Req() req: AuthedRequest,
  ): Promise<Output<typeof workspaceRoutes.setup>> {
    await this.s.workspaces.setup(req.ctx!, i.body);
    return this.s.auth.me(req.auth!.userId, req.auth!.sessionId);
  }
}

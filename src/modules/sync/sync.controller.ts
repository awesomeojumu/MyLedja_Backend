import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { syncRoutes as r } from './sync.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class SyncController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.push)
  push(@In() i: Input<typeof r.push>, @Req() req: Req): Promise<Output<typeof r.push>> {
    return this.s.sync.push(req.ctx!, i.body);
  }

  @Route(r.pull)
  pull(@In() i: Input<typeof r.pull>, @Req() req: Req): Promise<Output<typeof r.pull>> {
    return this.s.sync.pull(req.ctx!, i.query);
  }
}

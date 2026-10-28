import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Output, Route } from '../../common/http/contract.js';
import type { ContractRequest } from '../../common/http/contract.interceptor.js';
import { ruleRoutes as r } from './rules.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class RulesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.rules.list(req.ctx!);
  }
}

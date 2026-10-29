import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { ruleRoutes as r } from './rules.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class RulesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.rules.list(req.ctx!);
  }

  @Route(r.upsert)
  upsert(@In() i: Input<typeof r.upsert>, @Req() req: Req): Promise<Output<typeof r.upsert>> {
    const { baseVersion, ...body } = i.body;
    return this.s.rules.upsert(req.ctx!, i.params.ruleId, body, baseVersion ?? null);
  }

  @Route(r.remove)
  remove(@In() i: Input<typeof r.remove>, @Req() req: Req): Promise<Output<typeof r.remove>> {
    return this.s.rules.remove(req.ctx!, i.params.ruleId);
  }
}

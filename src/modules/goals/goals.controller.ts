import { Controller, Inject, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { SERVICES, type Services } from '../../app.services.js';
import { goalRoutes as r } from './goals.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class GoalsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@In() i: Input<typeof r.list>, @Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.goals.list(req.ctx!, i.query.status);
  }

  @Route(r.create)
  create(@In() i: Input<typeof r.create>, @Req() req: Req): Promise<Output<typeof r.create>> {
    return this.s.goals.create(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.get)
  get(@In() i: Input<typeof r.get>, @Req() req: Req): Promise<Output<typeof r.get>> {
    return this.s.goals.get(req.ctx!, i.params.goalId);
  }

  @Route(r.update)
  update(@In() i: Input<typeof r.update>, @Req() req: Req): Promise<Output<typeof r.update>> {
    return this.s.goals.update(req.ctx!, i.params.goalId, i.body);
  }

  @Route(r.allocate)
  allocate(@In() i: Input<typeof r.allocate>, @Req() req: Req): Promise<Output<typeof r.allocate>> {
    return this.s.goals.allocate(req.ctx!, i.params.goalId, i.body, req.operationId!);
  }

  @Route(r.setSchedule)
  setSchedule(@In() i: Input<typeof r.setSchedule>, @Req() req: Req): Promise<Output<typeof r.setSchedule>> {
    return this.s.goals.setSchedule(req.ctx!, i.params.goalId, i.body);
  }
}

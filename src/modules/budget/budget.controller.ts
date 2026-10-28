import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { budgetRoutes as b, dashboardRoutes as d } from './budget.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class BudgetController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(b.get)
  get(@In() i: Input<typeof b.get>, @Req() req: Req): Promise<Output<typeof b.get>> {
    return this.s.budget.get(req.ctx!, i.params.month, i.query.months);
  }

  @Route(b.assign)
  assign(@In() i: Input<typeof b.assign>, @Req() req: Req): Promise<Output<typeof b.assign>> {
    return this.s.budget.assign(req.ctx!, i.params.month, i.params.categoryId, i.body);
  }

  @Route(b.move)
  move(@In() i: Input<typeof b.move>, @Req() req: Req): Promise<Output<typeof b.move>> {
    return this.s.budget.move(req.ctx!, i.params.month, i.body);
  }

  @Route(b.cover)
  cover(@In() i: Input<typeof b.cover>, @Req() req: Req): Promise<Output<typeof b.cover>> {
    return this.s.budget.cover(req.ctx!, i.params.month, i.body);
  }
}

@Controller()
export class DashboardController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(d.get)
  get(@In() i: Input<typeof d.get>, @Req() req: Req): Promise<Output<typeof d.get>> {
    return this.s.budget.dashboard(req.ctx!, i.query.month);
  }
}

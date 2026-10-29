import { Controller, Inject, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { SERVICES, type Services } from '../../app.services.js';
import { investmentRoutes as r } from './investments.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class InvestmentsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.portfolio)
  portfolio(@In() i: Input<typeof r.portfolio>, @Req() req: Req): Promise<Output<typeof r.portfolio>> {
    return this.s.investments.portfolio(req.ctx!, i.query.range, i.query.archived);
  }

  @Route(r.create)
  create(@In() i: Input<typeof r.create>, @Req() req: Req): Promise<Output<typeof r.create>> {
    return this.s.investments.create(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.get)
  get(@In() i: Input<typeof r.get>, @Req() req: Req): Promise<Output<typeof r.get>> {
    return this.s.investments.get(req.ctx!, i.params.holdingId, i.query.range);
  }

  @Route(r.update)
  update(@In() i: Input<typeof r.update>, @Req() req: Req): Promise<Output<typeof r.update>> {
    return this.s.investments.update(req.ctx!, i.params.holdingId, i.body);
  }

  @Route(r.archive)
  archive(@In() i: Input<typeof r.archive>, @Req() req: Req): Promise<Output<typeof r.archive>> {
    return this.s.investments.archive(req.ctx!, i.params.holdingId);
  }

  @Route(r.setPrices)
  setPrices(@In() i: Input<typeof r.setPrices>, @Req() req: Req): Promise<Output<typeof r.setPrices>> {
    return this.s.investments.setPrices(req.ctx!, i.body);
  }

  @Route(r.deletePrice)
  deletePrice(@In() i: Input<typeof r.deletePrice>, @Req() req: Req): Promise<Output<typeof r.deletePrice>> {
    return this.s.investments.deletePrice(req.ctx!, i.params.holdingId, i.params.date);
  }
}

import { Controller, Inject, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { SERVICES, type Services } from '../../app.services.js';
import { currencyRoutes as r } from './currencies.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class CurrenciesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@In() i: Input<typeof r.list>, @Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.currencies.list(req.ctx!, i.query.currency);
  }

  @Route(r.set)
  set(@In() i: Input<typeof r.set>, @Req() req: Req): Promise<Output<typeof r.set>> {
    return this.s.currencies.set(req.ctx!, i.body);
  }

  @Route(r.remove)
  remove(@In() i: Input<typeof r.remove>, @Req() req: Req): Promise<Output<typeof r.remove>> {
    return this.s.currencies.remove(req.ctx!, i.params.currency, i.params.date);
  }
}

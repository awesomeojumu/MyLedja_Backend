import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { bankingRoutes as r } from './banking.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class BankingController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.link)
  link(@In() i: Input<typeof r.link>, @Req() req: Req): Promise<Output<typeof r.link>> {
    return this.s.banking.link(req.ctx!, i.body);
  }

  @Route(r.list)
  list(@Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.banking.list(req.ctx!);
  }

  @Route(r.sync)
  sync(@In() i: Input<typeof r.sync>, @Req() req: Req): Promise<Output<typeof r.sync>> {
    return this.s.banking.sync(req.ctx!, i.params.linkId);
  }

  @Route(r.disconnect)
  disconnect(@In() i: Input<typeof r.disconnect>, @Req() req: Req): Promise<void> {
    return this.s.banking.disconnect(req.ctx!, i.params.linkId);
  }

  @Route(r.webhook)
  webhook(@In() i: Input<typeof r.webhook>, @Req() req: Req): Promise<Output<typeof r.webhook>> {
    const header = req.headers['mono-webhook-secret'];
    return this.s.banking.webhook(typeof header === 'string' ? header : undefined, i.body);
  }
}

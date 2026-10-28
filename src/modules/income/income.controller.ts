import { Controller, Inject, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { SERVICES, type Services } from '../../app.services.js';
import { incomeRoutes as r } from './income.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class IncomeController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.getMonth)
  getMonth(@In() i: Input<typeof r.getMonth>, @Req() req: Req): Promise<Output<typeof r.getMonth>> {
    return this.s.income.getMonth(req.ctx!, i.params.month);
  }

  @Route(r.createStream)
  createStream(@In() i: Input<typeof r.createStream>, @Req() req: Req): Promise<Output<typeof r.createStream>> {
    return this.s.income.createStream(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.updateStream)
  updateStream(@In() i: Input<typeof r.updateStream>, @Req() req: Req): Promise<Output<typeof r.updateStream>> {
    return this.s.income.updateStream(req.ctx!, i.params.streamId, i.body);
  }

  @Route(r.linkTransaction)
  linkTransaction(
    @In() i: Input<typeof r.linkTransaction>,
    @Req() req: Req,
  ): Promise<Output<typeof r.linkTransaction>> {
    return this.s.income.linkTransaction(req.ctx!, i.params.streamId, i.body);
  }

  @Route(r.markOneOff)
  markOneOff(@In() i: Input<typeof r.markOneOff>, @Req() req: Req): Promise<Output<typeof r.markOneOff>> {
    return this.s.income.markOneOff(req.ctx!, i.params.transactionId);
  }
}

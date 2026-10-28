import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { reconcileRoutes as r } from './reconcile.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class ReconcileController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.start)
  start(@In() i: Input<typeof r.start>, @Req() req: Req): Promise<Output<typeof r.start>> {
    return this.s.reconcile.start(req.ctx!, i.params.accountId, i.body);
  }

  @Route(r.history)
  history(@In() i: Input<typeof r.history>, @Req() req: Req): Promise<Output<typeof r.history>> {
    return this.s.reconcile.history(req.ctx!, i.params.accountId);
  }

  @Route(r.get)
  get(@In() i: Input<typeof r.get>, @Req() req: Req): Promise<Output<typeof r.get>> {
    return this.s.reconcile.get(req.ctx!, i.params.reconciliationId);
  }

  @Route(r.tick)
  tick(@In() i: Input<typeof r.tick>, @Req() req: Req): Promise<Output<typeof r.tick>> {
    return this.s.reconcile.tick(req.ctx!, i.params.reconciliationId, i.body);
  }

  @Route(r.finish)
  finish(@In() i: Input<typeof r.finish>, @Req() req: Req): Promise<Output<typeof r.finish>> {
    return this.s.reconcile.finish(req.ctx!, i.params.reconciliationId, i.body, req.operationId!);
  }

  @Route(r.cancel)
  cancel(@In() i: Input<typeof r.cancel>, @Req() req: Req): Promise<Output<typeof r.cancel>> {
    return this.s.reconcile.cancel(req.ctx!, i.params.reconciliationId);
  }
}

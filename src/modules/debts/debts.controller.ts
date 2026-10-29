import { Controller, Inject, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { SERVICES, type Services } from '../../app.services.js';
import { debtRoutes as r } from './debts.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class DebtsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@In() i: Input<typeof r.list>, @Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.debts.list(req.ctx!, i.query);
  }

  @Route(r.get)
  get(@In() i: Input<typeof r.get>, @Req() req: Req): Promise<Output<typeof r.get>> {
    return this.s.debts.get(req.ctx!, i.params.debtId);
  }

  @Route(r.lend)
  lend(@In() i: Input<typeof r.lend>, @Req() req: Req): Promise<Output<typeof r.lend>> {
    return this.s.debts.lend(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.borrow)
  borrow(@In() i: Input<typeof r.borrow>, @Req() req: Req): Promise<Output<typeof r.borrow>> {
    return this.s.debts.borrow(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.update)
  update(@In() i: Input<typeof r.update>, @Req() req: Req): Promise<Output<typeof r.update>> {
    return this.s.debts.update(req.ctx!, i.params.debtId, i.body);
  }

  @Route(r.recordPayment)
  recordPayment(@In() i: Input<typeof r.recordPayment>, @Req() req: Req): Promise<Output<typeof r.recordPayment>> {
    return this.s.debts.recordPayment(req.ctx!, i.params.debtId, i.body, req.operationId!);
  }

  @Route(r.setSchedule)
  setSchedule(@In() i: Input<typeof r.setSchedule>, @Req() req: Req): Promise<Output<typeof r.setSchedule>> {
    return this.s.debts.setSchedule(req.ctx!, i.params.debtId, i.body.instalments, i.body.baseVersion);
  }

  @Route(r.writeOff)
  writeOff(@In() i: Input<typeof r.writeOff>, @Req() req: Req): Promise<Output<typeof r.writeOff>> {
    return this.s.debts.writeOff(
      req.ctx!,
      i.params.debtId,
      i.body.date,
      i.body.baseVersion,
      req.operationId!,
      i.body.reason,
    );
  }

  @Route(r.settle)
  settle(@In() i: Input<typeof r.settle>, @Req() req: Req): Promise<Output<typeof r.settle>> {
    return this.s.debts.settle(req.ctx!, i.params.debtId, i.body.baseVersion);
  }

  @Route(r.moneyBackSuggestions)
  moneyBackSuggestions(
    @In() i: Input<typeof r.moneyBackSuggestions>,
    @Req() req: Req,
  ): Promise<Output<typeof r.moneyBackSuggestions>> {
    return this.s.debts.listMoneyBackSuggestions(req.ctx!, i.query);
  }

  @Route(r.confirmMoneyBack)
  confirmMoneyBack(
    @In() i: Input<typeof r.confirmMoneyBack>,
    @Req() req: Req,
  ): Promise<Output<typeof r.confirmMoneyBack>> {
    return this.s.debts.confirmMoneyBack(req.ctx!, i.params.suggestionId, i.body, req.operationId!);
  }
}

import { Controller, Inject, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { SERVICES, type Services } from '../../app.services.js';
import { exchangeRateRoutes as er, investmentRoutes as r } from './investments.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class InvestmentsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.listHoldings)
  listHoldings(@Req() req: Req): Promise<Output<typeof r.listHoldings>> {
    return this.s.investments.listHoldings(req.ctx!);
  }

  @Route(r.createHolding)
  createHolding(@In() i: Input<typeof r.createHolding>, @Req() req: Req): Promise<Output<typeof r.createHolding>> {
    return this.s.investments.createHolding(req.ctx!, i.body);
  }

  @Route(r.listLots)
  listLots(@In() i: Input<typeof r.listLots>, @Req() req: Req): Promise<Output<typeof r.listLots>> {
    return this.s.investments.listLots(req.ctx!, i.params.holdingId);
  }

  @Route(r.buy)
  buy(@In() i: Input<typeof r.buy>, @Req() req: Req): Promise<Output<typeof r.buy>> {
    return this.s.investments.buy(req.ctx!, { ...i.body, operationId: i.body.operationId ?? req.operationId });
  }

  @Route(r.sell)
  sell(@In() i: Input<typeof r.sell>, @Req() req: Req): Promise<Output<typeof r.sell>> {
    return this.s.investments.sell(req.ctx!, { ...i.body, operationId: i.body.operationId ?? req.operationId });
  }

  @Route(r.dividend)
  dividend(@In() i: Input<typeof r.dividend>, @Req() req: Req): Promise<Output<typeof r.dividend>> {
    return this.s.investments.dividend(req.ctx!, { ...i.body, operationId: i.body.operationId ?? req.operationId });
  }

  @Route(r.savePrices)
  savePrices(@In() i: Input<typeof r.savePrices>, @Req() req: Req): Promise<Output<typeof r.savePrices>> {
    return this.s.investments.savePrices(req.ctx!, i.body);
  }

  @Route(r.listPrices)
  listPrices(@In() i: Input<typeof r.listPrices>, @Req() req: Req): Promise<Output<typeof r.listPrices>> {
    return this.s.investments.listPrices(req.ctx!, i.params.holdingId);
  }

  @Route(er.listRates)
  listRates(@Req() req: Req): Promise<Output<typeof er.listRates>> {
    return this.s.investments.listRates(req.ctx!);
  }

  @Route(er.saveRate)
  saveRate(@In() i: Input<typeof er.saveRate>, @Req() req: Req): Promise<Output<typeof er.saveRate>> {
    return this.s.investments.saveRate(req.ctx!, i.body);
  }
}

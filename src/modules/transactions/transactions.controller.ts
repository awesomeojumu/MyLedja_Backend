import { Controller, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { transactionRoutes as r } from './transactions.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class TransactionsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@In() i: Input<typeof r.list>, @Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.transactions.list(req.ctx!, i.query);
  }

  @Route(r.transferSuggestions)
  transferSuggestions(@Req() req: Req): Promise<Output<typeof r.transferSuggestions>> {
    return this.s.transactions.transferSuggestions(req.ctx!);
  }

  @Route(r.linkTransfer)
  linkTransfer(@In() i: Input<typeof r.linkTransfer>, @Req() req: Req): Promise<Output<typeof r.linkTransfer>> {
    return this.s.transactions.linkTransfer(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.dismissTransfer)
  async dismissTransfer(
    @In() i: Input<typeof r.dismissTransfer>,
    @Req() req: Req,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.s.transactions.dismissTransfer(req.ctx!, i.body);
    void reply.status(204);
  }

  @Route(r.bulk)
  bulk(@In() i: Input<typeof r.bulk>, @Req() req: Req): Promise<Output<typeof r.bulk>> {
    return this.s.transactions.bulk(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.get)
  get(@In() i: Input<typeof r.get>, @Req() req: Req): Promise<Output<typeof r.get>> {
    return this.s.transactions.get(req.ctx!, i.params.transactionId);
  }

  @Route(r.create)
  create(@In() i: Input<typeof r.create>, @Req() req: Req): Promise<Output<typeof r.create>> {
    return this.s.transactions.create(req.ctx!, i.body, req.operationId!, null);
  }

  @Route(r.update)
  update(@In() i: Input<typeof r.update>, @Req() req: Req): Promise<Output<typeof r.update>> {
    return this.s.transactions.update(req.ctx!, i.params.transactionId, i.body);
  }

  @Route(r.correct)
  correct(@In() i: Input<typeof r.correct>, @Req() req: Req): Promise<Output<typeof r.correct>> {
    return this.s.transactions.correct(req.ctx!, i.params.transactionId, i.body, req.operationId!, null);
  }

  @Route(r.reverse)
  reverse(@In() i: Input<typeof r.reverse>, @Req() req: Req): Promise<Output<typeof r.reverse>> {
    return this.s.transactions.reverse(req.ctx!, i.params.transactionId, i.body, req.operationId!, null);
  }

  @Route(r.unlock)
  unlock(@In() i: Input<typeof r.unlock>, @Req() req: Req): Promise<Output<typeof r.unlock>> {
    void i.body;
    return this.s.transactions.unlock(req.ctx!, i.params.transactionId);
  }
}

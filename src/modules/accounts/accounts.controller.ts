import { Controller, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { institutionRoutes } from '../institutions/institutions.contract.js';
import { institutionList } from '../institutions/institutions.js';
import { accountRoutes as r } from './accounts.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class AccountsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.accounts.list(req.ctx!);
  }

  @Route(r.create)
  create(@In() i: Input<typeof r.create>, @Req() req: Req): Promise<Output<typeof r.create>> {
    return this.s.accounts.create(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.get)
  get(@In() i: Input<typeof r.get>, @Req() req: Req): Promise<Output<typeof r.get>> {
    return this.s.accounts.get(req.ctx!, i.params.accountId);
  }

  @Route(r.update)
  update(@In() i: Input<typeof r.update>, @Req() req: Req): Promise<Output<typeof r.update>> {
    return this.s.accounts.update(req.ctx!, i.params.accountId, i.body);
  }

  @Route(r.archive)
  archive(@In() i: Input<typeof r.archive>, @Req() req: Req): Promise<Output<typeof r.archive>> {
    return this.s.accounts.archive(req.ctx!, i.params.accountId, i.body, req.operationId!);
  }

  @Route(r.restore)
  restore(@In() i: Input<typeof r.restore>, @Req() req: Req): Promise<Output<typeof r.restore>> {
    return this.s.accounts.restore(req.ctx!, i.params.accountId);
  }

  @Route(r.updateValue)
  updateValue(@In() i: Input<typeof r.updateValue>, @Req() req: Req): Promise<Output<typeof r.updateValue>> {
    return this.s.accounts.updateValue(req.ctx!, i.params.accountId, i.body, req.operationId!);
  }

  @Route(r.reorder)
  reorder(@In() i: Input<typeof r.reorder>, @Req() req: Req): Promise<Output<typeof r.reorder>> {
    return this.s.accounts.reorder(req.ctx!, i.body.accountIds);
  }
}

@Controller()
export class InstitutionsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(institutionRoutes.list)
  list(@Res({ passthrough: true }) reply: FastifyReply): Output<typeof institutionRoutes.list> {
    void reply.header('Cache-Control', 'public, max-age=86400');
    return institutionList(this.s.config);
  }
}

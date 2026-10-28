import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { importRoutes as r } from './imports.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class ImportsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.upload)
  upload(@In() i: Input<typeof r.upload>, @Req() req: Req): Promise<Output<typeof r.upload>> {
    return this.s.imports.upload(req.ctx!, i.body);
  }

  @Route(r.uploadStatement)
  uploadStatement(
    @In() i: Input<typeof r.uploadStatement>,
    @Req() req: Req,
  ): Promise<Output<typeof r.uploadStatement>> {
    return this.s.statements.upload(req.ctx!, i.body);
  }

  @Route(r.get)
  get(@In() i: Input<typeof r.get>, @Req() req: Req): Promise<Output<typeof r.get>> {
    return this.s.imports.get(req.ctx!, i.params.importId);
  }

  @Route(r.map)
  map(@In() i: Input<typeof r.map>, @Req() req: Req): Promise<Output<typeof r.map>> {
    return this.s.imports.map(req.ctx!, i.params.importId, i.body.mapping);
  }

  @Route(r.post)
  post(@In() i: Input<typeof r.post>, @Req() req: Req): Promise<Output<typeof r.post>> {
    return this.s.imports.post(req.ctx!, i.params.importId, i.body, req.operationId!);
  }

  @Route(r.undo)
  undo(@In() i: Input<typeof r.undo>, @Req() req: Req): Promise<Output<typeof r.undo>> {
    return this.s.imports.undo(req.ctx!, i.params.importId, req.operationId!);
  }
}

import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { fileRoutes as r } from './files.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class FilesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.upload)
  upload(@In() i: Input<typeof r.upload>, @Req() req: Req): Promise<Output<typeof r.upload>> {
    return this.s.filesHttp.upload(req.ctx!, i.body);
  }

  @Route(r.viewUrl)
  viewUrl(@In() i: Input<typeof r.viewUrl>, @Req() req: Req): Promise<Output<typeof r.viewUrl>> {
    return this.s.filesHttp.viewUrl(req.ctx!, i.params.fileId);
  }
}

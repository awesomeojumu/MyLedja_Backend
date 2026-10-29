import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { exportRoutes as r } from './exports.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class ExportsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.exportCsv)
  exportCsv(@In() i: Input<typeof r.exportCsv>, @Req() req: Req): Promise<Output<typeof r.exportCsv>> {
    return this.s.exports.exportCsv(req.ctx!, req.auth!.sessionId, i.body ?? {});
  }

  @Route(r.backup)
  backup(@Req() req: Req): Promise<Output<typeof r.backup>> {
    return this.s.exports.backup(req.ctx!, req.auth!.sessionId);
  }

  @Route(r.restorePreview)
  restorePreview(@In() i: Input<typeof r.restorePreview>): Promise<Output<typeof r.restorePreview>> {
    return this.s.exports.restorePreview(i.body.content);
  }

  @Route(r.restore)
  restore(@In() i: Input<typeof r.restore>, @Req() req: Req): Promise<Output<typeof r.restore>> {
    return this.s.exports.restore(req.auth!.userId, req.auth!.sessionId, i.body.content, i.body.workspaceName);
  }

  @Route(r.deleteAccount)
  deleteAccount(@Req() req: Req): Promise<Output<typeof r.deleteAccount>> {
    return this.s.exports.deleteAccount(req.auth!.userId, req.auth!.sessionId);
  }
}

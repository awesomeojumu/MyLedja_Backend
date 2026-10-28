import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { notificationRoutes as r } from './notifications.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class NotificationsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@In() i: Input<typeof r.list>, @Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.notifications.list(req.ctx!, i.query);
  }

  @Route(r.markRead)
  markRead(@In() i: Input<typeof r.markRead>, @Req() req: Req): Promise<Output<typeof r.markRead>> {
    return this.s.notifications.markRead(req.ctx!, i.params.notificationId);
  }

  @Route(r.markAllRead)
  markAllRead(@Req() req: Req): Promise<Output<typeof r.markAllRead>> {
    return this.s.notifications.markAllRead(req.ctx!);
  }

  @Route(r.dismiss)
  dismiss(@In() i: Input<typeof r.dismiss>, @Req() req: Req): Promise<Output<typeof r.dismiss>> {
    return this.s.notifications.dismiss(req.ctx!, i.params.notificationId);
  }
}

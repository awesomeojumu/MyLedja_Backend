import { Controller, Inject, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { SERVICES, type Services } from '../../app.services.js';
import { scheduleRoutes as r } from './schedules.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class SchedulesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.list)
  list(@In() i: Input<typeof r.list>, @Req() req: Req): Promise<Output<typeof r.list>> {
    return this.s.schedules.list(req.ctx!, i.query);
  }

  @Route(r.create)
  create(@In() i: Input<typeof r.create>, @Req() req: Req): Promise<Output<typeof r.create>> {
    return this.s.schedules.create(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.get)
  get(@In() i: Input<typeof r.get>, @Req() req: Req): Promise<Output<typeof r.get>> {
    return this.s.schedules.get(req.ctx!, i.params.scheduleId);
  }

  @Route(r.update)
  update(@In() i: Input<typeof r.update>, @Req() req: Req): Promise<Output<typeof r.update>> {
    return this.s.schedules.update(req.ctx!, i.params.scheduleId, i.body);
  }

  @Route(r.cancel)
  cancel(@In() i: Input<typeof r.cancel>, @Req() req: Req): Promise<Output<typeof r.cancel>> {
    return this.s.schedules.cancel(req.ctx!, i.params.scheduleId, i.body.baseVersion);
  }

  @Route(r.listOccurrences)
  listOccurrences(
    @In() i: Input<typeof r.listOccurrences>,
    @Req() req: Req,
  ): Promise<Output<typeof r.listOccurrences>> {
    return this.s.schedules.listOccurrences(req.ctx!, i.params.month, i.query.scheduleId);
  }

  @Route(r.markPaid)
  markPaid(@In() i: Input<typeof r.markPaid>, @Req() req: Req): Promise<Output<typeof r.markPaid>> {
    return this.s.schedules.markPaid(req.ctx!, i.params.occurrenceId, i.body, req.operationId!);
  }

  @Route(r.markReceived)
  markReceived(@In() i: Input<typeof r.markReceived>, @Req() req: Req): Promise<Output<typeof r.markReceived>> {
    return this.s.schedules.markReceived(req.ctx!, i.params.occurrenceId, i.body, req.operationId!);
  }

  @Route(r.unmark)
  unmark(@In() i: Input<typeof r.unmark>, @Req() req: Req): Promise<Output<typeof r.unmark>> {
    return this.s.schedules.unmark(req.ctx!, i.params.occurrenceId);
  }

  @Route(r.findRecurring)
  findRecurring(@In() i: Input<typeof r.findRecurring>, @Req() req: Req): Promise<Output<typeof r.findRecurring>> {
    return this.s.schedules.findRecurring(req.ctx!, i.body);
  }

  @Route(r.planSummary)
  planSummary(@In() i: Input<typeof r.planSummary>, @Req() req: Req): Promise<Output<typeof r.planSummary>> {
    return this.s.schedules.planSummary(req.ctx!, i.params.month);
  }
}

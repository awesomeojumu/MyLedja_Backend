import { Controller, Inject, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { SERVICES, type Services } from '../../app.services.js';
import { reportRoutes as r } from './reports.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class ReportsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(r.run)
  run(@In() i: Input<typeof r.run>, @Req() req: Req): Promise<Output<typeof r.run>> {
    return this.s.reports.run(req.ctx!, i.body);
  }

  @Route(r.listDashboards)
  listDashboards(@Req() req: Req): Promise<Output<typeof r.listDashboards>> {
    return this.s.reports.listDashboards(req.ctx!);
  }

  @Route(r.createDashboard)
  createDashboard(
    @In() i: Input<typeof r.createDashboard>,
    @Req() req: Req,
  ): Promise<Output<typeof r.createDashboard>> {
    return this.s.reports.createDashboard(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.updateDashboard)
  updateDashboard(
    @In() i: Input<typeof r.updateDashboard>,
    @Req() req: Req,
  ): Promise<Output<typeof r.updateDashboard>> {
    return this.s.reports.updateDashboard(req.ctx!, i.params.dashboardId, i.body);
  }

  @Route(r.deleteDashboard)
  deleteDashboard(
    @In() i: Input<typeof r.deleteDashboard>,
    @Req() req: Req,
  ): Promise<Output<typeof r.deleteDashboard>> {
    return this.s.reports.deleteDashboard(req.ctx!, i.params.dashboardId);
  }

  @Route(r.listSaved)
  listSaved(@Req() req: Req): Promise<Output<typeof r.listSaved>> {
    return this.s.reports.listSaved(req.ctx!);
  }

  @Route(r.createSaved)
  createSaved(@In() i: Input<typeof r.createSaved>, @Req() req: Req): Promise<Output<typeof r.createSaved>> {
    return this.s.reports.createSaved(req.ctx!, i.body, req.operationId!);
  }

  @Route(r.updateSaved)
  updateSaved(@In() i: Input<typeof r.updateSaved>, @Req() req: Req): Promise<Output<typeof r.updateSaved>> {
    return this.s.reports.updateSaved(req.ctx!, i.params.reportId, i.body);
  }

  @Route(r.deleteSaved)
  deleteSaved(@In() i: Input<typeof r.deleteSaved>, @Req() req: Req): Promise<Output<typeof r.deleteSaved>> {
    return this.s.reports.deleteSaved(req.ctx!, i.params.reportId);
  }

  @Route(r.cashFlow)
  cashFlow(@In() i: Input<typeof r.cashFlow>, @Req() req: Req): Promise<Output<typeof r.cashFlow>> {
    return this.s.reports.cashFlow(req.ctx!, i.query);
  }

  @Route(r.health)
  health(@In() i: Input<typeof r.health>, @Req() req: Req): Promise<Output<typeof r.health>> {
    return this.s.reports.healthPage(req.ctx!, i.params.month);
  }

  @Route(r.healthSettings)
  healthSettings(@In() i: Input<typeof r.healthSettings>, @Req() req: Req): Promise<Output<typeof r.healthSettings>> {
    return this.s.reports.setHealthSettings(req.ctx!, i.body);
  }
}

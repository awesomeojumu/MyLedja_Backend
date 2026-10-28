import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { aiRoutes as r } from './ai.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class AiController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private async settings(req: Req): Promise<Output<typeof r.get>> {
    const consent = await this.s.ai.consent(req.ctx!);
    return {
      available: this.s.ai.available(),
      consent: { ...consent, updatedAt: consent.updatedAt?.toISOString() ?? null },
    };
  }

  @Route(r.get)
  get(@Req() req: Req): Promise<Output<typeof r.get>> {
    return this.settings(req);
  }

  @Route(r.setConsent)
  async setConsent(@In() i: Input<typeof r.setConsent>, @Req() req: Req): Promise<Output<typeof r.setConsent>> {
    await this.s.ai.setConsent(req.ctx!, i.body);
    return this.settings(req);
  }

  @Route(r.categorize)
  async categorize(@In() i: Input<typeof r.categorize>, @Req() req: Req): Promise<Output<typeof r.categorize>> {
    const cats = (await this.s.categoriesRepo.live(req.ctx!)).filter((c) => !c.system);
    const categoryIds = await this.s.ai.categorize(
      req.ctx!,
      i.body.items.map((x) => ({ description: x.description, amountMinor: BigInt(x.amount), date: x.date })),
      cats.map((c) => ({ id: c._id, name: c.name, kind: c.kind })),
    );
    return { categoryIds };
  }
}

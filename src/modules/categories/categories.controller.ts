import { Controller, Inject, Req } from '@nestjs/common';
import { SERVICES, type Services } from '../../app.services.js';
import type { AuthedRequest } from '../../common/auth/access.guard.js';
import { type Input, type Output, Route } from '../../common/http/contract.js';
import { type ContractRequest, In } from '../../common/http/contract.interceptor.js';
import { categoryRoutes as c, payeeRoutes as p, tagRoutes as t } from './categories.contract.js';

type Req = AuthedRequest & ContractRequest;

@Controller()
export class CategoriesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(c.list)
  list(@Req() req: Req): Promise<Output<typeof c.list>> {
    return this.s.categories.tree(req.ctx!);
  }

  @Route(c.create)
  create(@In() i: Input<typeof c.create>, @Req() req: Req): Promise<Output<typeof c.create>> {
    return this.s.categories.create(req.ctx!, i.body);
  }

  @Route(c.update)
  update(@In() i: Input<typeof c.update>, @Req() req: Req): Promise<Output<typeof c.update>> {
    return this.s.categories.update(req.ctx!, i.params.categoryId, i.body);
  }

  @Route(c.remove)
  remove(@In() i: Input<typeof c.remove>, @Req() req: Req): Promise<Output<typeof c.remove>> {
    return this.s.categories.remove(req.ctx!, i.params.categoryId, i.body.moveTo, req.operationId!);
  }

  @Route(c.undoRemove)
  undoRemove(@In() i: Input<typeof c.undoRemove>, @Req() req: Req): Promise<Output<typeof c.undoRemove>> {
    return this.s.categories.undoRemove(req.ctx!, i.params.undoId, req.operationId!);
  }

  @Route(c.createGroup)
  createGroup(@In() i: Input<typeof c.createGroup>, @Req() req: Req): Promise<Output<typeof c.createGroup>> {
    return this.s.categories.createGroup(req.ctx!, i.body);
  }

  @Route(c.updateGroup)
  updateGroup(@In() i: Input<typeof c.updateGroup>, @Req() req: Req): Promise<Output<typeof c.updateGroup>> {
    return this.s.categories.updateGroup(req.ctx!, i.params.groupId, i.body);
  }

  @Route(c.removeGroup)
  removeGroup(@In() i: Input<typeof c.removeGroup>, @Req() req: Req): Promise<Output<typeof c.removeGroup>> {
    return this.s.categories.removeGroup(req.ctx!, i.params.groupId);
  }
}

@Controller()
export class TagsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(t.list)
  list(@Req() req: Req): Promise<Output<typeof t.list>> {
    return this.s.categories.listTags(req.ctx!);
  }

  @Route(t.create)
  create(@In() i: Input<typeof t.create>, @Req() req: Req): Promise<Output<typeof t.create>> {
    return this.s.categories.createTag(req.ctx!, i.body);
  }

  @Route(t.update)
  update(@In() i: Input<typeof t.update>, @Req() req: Req): Promise<Output<typeof t.update>> {
    return this.s.categories.updateTag(req.ctx!, i.params.tagId, i.body);
  }

  @Route(t.remove)
  remove(@In() i: Input<typeof t.remove>, @Req() req: Req): Promise<Output<typeof t.remove>> {
    return this.s.categories.removeTag(req.ctx!, i.params.tagId);
  }
}

@Controller()
export class PayeesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Route(p.list)
  list(@In() i: Input<typeof p.list>, @Req() req: Req): Promise<Output<typeof p.list>> {
    return this.s.categories.listPayees(req.ctx!, i.query);
  }

  @Route(p.get)
  get(@In() i: Input<typeof p.get>, @Req() req: Req): Promise<Output<typeof p.get>> {
    return this.s.categories.getPayee(req.ctx!, i.params.payeeId);
  }

  @Route(p.create)
  create(@In() i: Input<typeof p.create>, @Req() req: Req): Promise<Output<typeof p.create>> {
    return this.s.categories.createPayee(req.ctx!, i.body);
  }

  @Route(p.update)
  update(@In() i: Input<typeof p.update>, @Req() req: Req): Promise<Output<typeof p.update>> {
    return this.s.categories.updatePayee(req.ctx!, i.params.payeeId, i.body);
  }

  @Route(p.merge)
  merge(@In() i: Input<typeof p.merge>, @Req() req: Req): Promise<Output<typeof p.merge>> {
    return this.s.categories.mergePayees(req.ctx!, i.body);
  }

  @Route(p.undoMerge)
  undoMerge(@In() i: Input<typeof p.undoMerge>, @Req() req: Req): Promise<Output<typeof p.undoMerge>> {
    return this.s.categories.undoMerge(req.ctx!, i.params.mergeId);
  }

  @Route(p.remove)
  remove(@In() i: Input<typeof p.remove>, @Req() req: Req): Promise<Output<typeof p.remove>> {
    return this.s.categories.deletePayee(req.ctx!, i.params.payeeId);
  }
}

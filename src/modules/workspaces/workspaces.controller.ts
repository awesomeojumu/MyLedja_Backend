import { Controller } from '@nestjs/common';
import { Errors } from '../../common/errors/errors.js';
import { Route } from '../../common/http/contract.js';
import { workspaceRoutes } from './workspaces.contract.js';

@Controller()
export class WorkspacesController {
  @Route(workspaceRoutes.get)
  get() {
    throw Errors.notImplemented();
  }

  @Route(workspaceRoutes.setup)
  setup() {
    throw Errors.notImplemented();
  }
}

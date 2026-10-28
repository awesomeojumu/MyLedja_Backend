import type { RouteDef } from './common/http/contract.js';
import { authRoutes, meRoutes } from './modules/auth/auth.contract.js';
import { healthRoutes } from './modules/health/health.contract.js';
import { workspaceRoutes } from './modules/workspaces/workspaces.contract.js';

/** Every route the API serves. `npm run openapi` writes openapi.json from this list. */
export const ALL_ROUTES: RouteDef[] = [healthRoutes, authRoutes, meRoutes, workspaceRoutes].flatMap(
  (group) => Object.values(group) as RouteDef[],
);

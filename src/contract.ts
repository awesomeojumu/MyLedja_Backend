import type { RouteDef } from './common/http/contract.js';
import { accountRoutes } from './modules/accounts/accounts.contract.js';
import { authRoutes, meRoutes } from './modules/auth/auth.contract.js';
import { budgetRoutes, dashboardRoutes } from './modules/budget/budget.contract.js';
import { categoryRoutes, payeeRoutes, tagRoutes } from './modules/categories/categories.contract.js';
import { healthRoutes } from './modules/health/health.contract.js';
import { importRoutes } from './modules/imports/imports.contract.js';
import { institutionRoutes } from './modules/institutions/institutions.contract.js';
import { reconcileRoutes } from './modules/reconcile/reconcile.contract.js';
import { syncRoutes } from './modules/sync/sync.contract.js';
import { transactionRoutes } from './modules/transactions/transactions.contract.js';
import { workspaceRoutes } from './modules/workspaces/workspaces.contract.js';

/** Every route the API serves. `npm run openapi` writes openapi.json from this list. */
export const ALL_ROUTES: RouteDef[] = [
  healthRoutes,
  authRoutes,
  meRoutes,
  workspaceRoutes,
  institutionRoutes,
  accountRoutes,
  categoryRoutes,
  tagRoutes,
  payeeRoutes,
  transactionRoutes,
  budgetRoutes,
  dashboardRoutes,
  reconcileRoutes,
  importRoutes,
  syncRoutes,
].flatMap((group) => Object.values(group) as RouteDef[]);

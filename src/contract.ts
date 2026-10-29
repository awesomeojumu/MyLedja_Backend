import type { RouteDef } from './common/http/contract.js';
import { accountRoutes } from './modules/accounts/accounts.contract.js';
import { authRoutes, meRoutes } from './modules/auth/auth.contract.js';
import { budgetRoutes, dashboardRoutes } from './modules/budget/budget.contract.js';
import { categoryRoutes, payeeRoutes, tagRoutes } from './modules/categories/categories.contract.js';
import { healthRoutes } from './modules/health/health.contract.js';
import { importRoutes } from './modules/imports/imports.contract.js';
import { institutionRoutes } from './modules/institutions/institutions.contract.js';
import { reconcileRoutes } from './modules/reconcile/reconcile.contract.js';
import { debtRoutes } from './modules/debts/debts.contract.js';
import { goalRoutes } from './modules/goals/goals.contract.js';
import { incomeRoutes } from './modules/income/income.contract.js';
import { notificationRoutes } from './modules/notifications/notifications.contract.js';
import { scheduleRoutes } from './modules/schedules/schedules.contract.js';
import { syncRoutes } from './modules/sync/sync.contract.js';
import { transactionRoutes } from './modules/transactions/transactions.contract.js';
import { workspaceRoutes } from './modules/workspaces/workspaces.contract.js';
import { securityRoutes } from './modules/security/security.contract.js';
import { exportRoutes } from './modules/exports/exports.contract.js';
import { aiRoutes } from './modules/ai/ai.contract.js';
import { ruleRoutes } from './modules/rules/rules.contract.js';
import { bankingRoutes } from './modules/banking/banking.contract.js';
import { investmentRoutes } from './modules/investments/investments.contract.js';
import { currencyRoutes } from './modules/currencies/currencies.contract.js';
import { reportRoutes } from './modules/reports/reports.contract.js';

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
  scheduleRoutes,
  goalRoutes,
  debtRoutes,
  incomeRoutes,
  notificationRoutes,
  securityRoutes,
  exportRoutes,
  aiRoutes,
  ruleRoutes,
  bankingRoutes,
  investmentRoutes,
  currencyRoutes,
  reportRoutes,
].flatMap((group) => Object.values(group) as RouteDef[]);

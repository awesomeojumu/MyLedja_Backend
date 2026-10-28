import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SERVICES, type Services } from './app.services.js';
import { ConfigModule } from './config/config.module.js';
import { AccessGuard, AUTHENTICATOR, MEMBERSHIPS } from './common/auth/access.guard.js';
import { COOKIE_WRITER, ContractInterceptor, CRYPTO, IDEMPOTENCY } from './common/http/contract.interceptor.js';
import { ErrorFilter } from './common/http/error.filter.js';
import { AccountsController, InstitutionsController } from './modules/accounts/accounts.controller.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { BudgetController, DashboardController } from './modules/budget/budget.controller.js';
import { CategoriesController, PayeesController, TagsController } from './modules/categories/categories.controller.js';
import { HealthController } from './modules/health/health.controller.js';
import { ImportsController } from './modules/imports/imports.controller.js';
import { ReconcileController } from './modules/reconcile/reconcile.controller.js';
import { SyncController } from './modules/sync/sync.controller.js';
import { TransactionsController } from './modules/transactions/transactions.controller.js';
import { WorkspacesController } from './modules/workspaces/workspaces.controller.js';

@Module({})
export class AppModule {
  static forRoot(services: Services): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(services.config)],
      controllers: [
        HealthController,
        AuthController,
        WorkspacesController,
        CategoriesController,
        TagsController,
        PayeesController,
        AccountsController,
        InstitutionsController,
        TransactionsController,
        ReconcileController,
        BudgetController,
        DashboardController,
        ImportsController,
        SyncController,
      ],
      providers: [
        { provide: SERVICES, useValue: services },
        { provide: AUTHENTICATOR, useValue: services.auth },
        { provide: MEMBERSHIPS, useValue: services.memberships },
        { provide: IDEMPOTENCY, useValue: services.idempotency },
        { provide: CRYPTO, useValue: services.crypto },
        { provide: COOKIE_WRITER, useValue: services.writeCookie },
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_INTERCEPTOR, useClass: ContractInterceptor },
      ],
    };
  }
}

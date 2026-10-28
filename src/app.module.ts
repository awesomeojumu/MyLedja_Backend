import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/config.schema.js';
import { ContractInterceptor } from './common/http/contract.interceptor.js';
import { ErrorFilter } from './common/http/error.filter.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { HealthController } from './modules/health/health.controller.js';
import { WorkspacesController } from './modules/workspaces/workspaces.controller.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config)],
      controllers: [HealthController, AuthController, WorkspacesController],
      providers: [
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: ContractInterceptor },
      ],
    };
  }
}

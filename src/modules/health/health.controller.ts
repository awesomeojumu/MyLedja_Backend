import { Controller, Inject } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/config.schema.js';
import { Route, type Output } from '../../common/http/contract.js';
import { healthRoutes } from './health.contract.js';

@Controller()
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Route(healthRoutes.health)
  health(): Output<typeof healthRoutes.health> {
    return { status: 'ok', env: this.config.appEnv };
  }

  @Route(healthRoutes.publicConfig)
  publicConfig(): Output<typeof healthRoutes.publicConfig> {
    const c = this.config;
    return {
      env: c.appEnv,
      google: { enabled: c.google !== null, clientId: c.google?.clientId ?? null },
      services: {
        bankConnections: c.mono !== null,
        files: c.cloudinary !== null,
        ai: c.anthropicApiKey !== null || c.geminiApiKey !== null,
      },
    };
  }
}

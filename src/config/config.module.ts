import { Global, Module } from '@nestjs/common';
import { type AppConfig, parseConfig } from './config.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** The only reader of process.env (TECH-SPEC 2.3 rule 1). */
export function loadConfigFromEnv(): AppConfig {
  return parseConfig(process.env);
}

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig) {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

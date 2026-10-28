import 'reflect-metadata';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { buildServices, type ServiceOverrides, type Services } from './app.services.js';
import type { AppConfig } from './config/config.schema.js';
import { CLIENT_HEADER, OPERATION_ID_HEADER } from './common/http/contract.js';
import type { Database } from './db/client.js';

export type CreateAppOptions = ServiceOverrides & { quiet?: boolean };

export async function createApp(
  config: AppConfig,
  database: Database,
  options: CreateAppOptions = {},
): Promise<{ app: NestFastifyApplication; services: Services }> {
  const services = buildServices(config, database, options);
  const adapter = new FastifyAdapter({
    // Fastify trusts the nth hop when given a number; its types omit that form.
    trustProxy: config.trustProxy as boolean,
    bodyLimit: 1_048_576,
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(services), adapter, {
    logger: options.quiet ? false : config.appEnv === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
  });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', OPERATION_ID_HEADER, CLIENT_HEADER],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, services };
}

import 'reflect-metadata';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/config.schema.js';
import { CLIENT_HEADER, OPERATION_ID_HEADER } from './common/http/contract.js';

export async function createApp(config: AppConfig, options: { quiet?: boolean } = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // Fastify trusts the nth hop when given a number; its types omit that form.
    trustProxy: config.trustProxy as boolean,
    bodyLimit: 1_048_576,
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(config), adapter, {
    logger: options.quiet ? false : config.appEnv === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
  });
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
  return app;
}

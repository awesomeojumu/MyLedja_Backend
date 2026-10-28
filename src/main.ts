import { Logger } from '@nestjs/common';
import { createApp } from './app.factory.js';
import { loadConfigFromEnv } from './config/config.module.js';
import { ConfigError, serviceStatus } from './config/config.schema.js';
import { Database } from './db/client.js';
import { migrate } from './db/migrations/index.js';

async function main() {
  const logger = new Logger('MyLedja');
  let config;
  try {
    config = loadConfigFromEnv();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const database = await Database.connect(config.mongodbUri, config.mongodbDb, config.dnsServers);
  const applied = await migrate(database.db);
  if (applied.length) logger.log(JSON.stringify({ event: 'migrated', applied }));

  const { app, services } = await createApp(config, database);
  services.jobs.start();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const status = serviceStatus(config);
  logger.log(JSON.stringify({ event: 'started', env: config.appEnv, port: config.port, services: status }));
  if (status.email === 'off' && config.appEnv !== 'development') {
    logger.warn(JSON.stringify({ event: 'email_off', note: 'set RESEND_API_KEY or SMTP_HOST so codes can be sent' }));
  }

  const shutdown = async () => {
    services.jobs.stop();
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void main();

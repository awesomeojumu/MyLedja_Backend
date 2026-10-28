import { Logger } from '@nestjs/common';
import { createApp } from './app.factory.js';
import { loadConfigFromEnv } from './config/config.module.js';
import { ConfigError, serviceStatus } from './config/config.schema.js';

async function main() {
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
  const app = await createApp(config);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  new Logger('MyLedja').log(
    JSON.stringify({ event: 'started', env: config.appEnv, port: config.port, services: serviceStatus(config) }),
  );
}

void main();

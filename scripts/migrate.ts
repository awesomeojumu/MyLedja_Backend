// npm run migrate: applies database migrations in order. Safe to run twice.
import { loadConfigFromEnv } from '../src/config/config.module.js';
import { Database } from '../src/db/client.js';
import { migrate } from '../src/db/migrations/index.js';

const config = loadConfigFromEnv();
const database = await Database.connect(config.mongodbUri, config.mongodbDb, config.dnsServers);
try {
  const applied = await migrate(database.db);
  console.log(applied.length ? `migrate: applied ${applied.join(', ')}` : 'migrate: nothing to apply');
} finally {
  await database.close();
}

// npm run seed:dev: creates Ada and her Personal workspace (build plan 2.7). Development only.
// Accounts, categories and a month of transactions are added here once the ledger ships (Phase 1).
import { loadConfigFromEnv } from '../src/config/config.module.js';
import { buildServices } from '../src/app.services.js';
import { Database } from '../src/db/client.js';
import { migrate } from '../src/db/migrations/index.js';
import { OffSender } from '../src/modules/notifications/email/email.js';
import { newId } from '../src/common/ids/ids.js';

const ADA = { name: 'Ada', email: 'ada@example.test', password: 'ada-dev-only-passphrase' };

const config = loadConfigFromEnv();
if (config.appEnv !== 'development') {
  console.error('seed:dev runs only with APP_ENV=development.');
  process.exit(1);
}
const database = await Database.connect(config.mongodbUri, config.mongodbDb, config.dnsServers);
try {
  await migrate(database.db);
  const s = buildServices(config, database, { emailSender: new OffSender() });
  const { UsersRepository } = await import('../src/modules/auth/auth.repository.js');
  const users = new UsersRepository(database.db);
  if (await users.byEmail(ADA.email)) {
    console.log('seed:dev: Ada already exists.');
  } else {
    const { PasswordHasher } = await import('../src/modules/auth/tokens.js');
    const now = new Date();
    const userId = newId();
    await database.transaction(async (session) => {
      await users.insert(
        {
          _id: userId,
          email: ADA.email,
          name: ADA.name,
          passwordHash: await new PasswordHasher().hash(ADA.password),
          googleId: null,
          emailVerifiedAt: now,
          termsAcceptedAt: now,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      await s.workspaces.createPersonal(userId, session);
    });
    console.log(`seed:dev: created ${ADA.email} with password ${ADA.password} (development only).`);
  }
} finally {
  await database.close();
}

import { DynamicModule, Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Db, MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { configureApp } from "@/app.setup";
import { connectMongo } from "@/database/mongo/connect";
import { MONGO_CLIENT, MONGO_DB } from "@/database/mongo/mongo.constants";
import { AccountsModule } from "@/modules/accounts/accounts.module";
import { AuthModule } from "@/modules/auth/auth.module";
import { CaptureMailer, MAILER } from "@/modules/auth/domain/mailer";
import { TestApp } from "@/modules/auth/tests/test-app";
import { CategoriesMerchantsModule } from "@/modules/categories-merchants/categories-merchants.module";
import { TransactionsModule } from "@/modules/transactions/transactions.module";
import { UsersModule } from "@/modules/users/users.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { randomFillSync } from "node:crypto";

export function testId(): string {
  const bytes = Buffer.alloc(16);
  randomFillSync(bytes);
  const ms = BigInt(Date.now());
  bytes.writeUInt32BE(Number(ms >> 16n), 0);
  bytes.writeUInt16BE(Number(ms & 0xffffn), 4);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

@Global()
@Module({})
class TestMongoModule {
  static forRoot(client: MongoClient, db: Db): DynamicModule {
    return {
      module: TestMongoModule,
      global: true,
      providers: [
        { provide: MONGO_CLIENT, useValue: client },
        { provide: MONGO_DB, useValue: db },
      ],
      exports: [MONGO_CLIENT, MONGO_DB],
    };
  }
}

export async function startLedgerApp(): Promise<TestApp> {
  process.env.APP_ENV = "test";
  process.env.JWT_SECRET = "a".repeat(32);
  process.env.ACCOUNT_NUMBER_KEY = "ab".repeat(32);
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = await connectMongo(replSet.getUri());
  const db = client.db(`myledja_ledger_${Date.now()}`);
  const mailer = new CaptureMailer();
  const moduleRef = await Test.createTestingModule({
    imports: [
      TestMongoModule.forRoot(client, db),
      UsersModule,
      WorkspacesModule,
      AuthModule,
      AccountsModule,
      CategoriesMerchantsModule,
      TransactionsModule,
    ],
  })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.listen(0);
  return {
    app,
    db,
    mailer,
    stop: async () => {
      await app.close();
      await db.dropDatabase();
      await client.close();
      await replSet.stop();
    },
  };
}

export { http, registerAndVerify, TEST_PASSWORD } from "@/modules/auth/tests/test-app";

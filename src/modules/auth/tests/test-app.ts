import { DynamicModule, Global, INestApplication, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Db, MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { configureApp } from "@/app.setup";
import { connectMongo } from "@/database/mongo/connect";
import { MONGO_CLIENT, MONGO_DB } from "@/database/mongo/mongo.constants";
import { AuthModule } from "@/modules/auth/auth.module";
import { CaptureMailer, MAILER } from "@/modules/auth/domain/mailer";
import { UsersModule } from "@/modules/users/users.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";

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

export interface TestApp {
  app: INestApplication;
  db: Db;
  mailer: CaptureMailer;
  stop: () => Promise<void>;
}

export async function startAuthApp(): Promise<TestApp> {
  process.env.APP_ENV = "test";
  process.env.JWT_SECRET = "a".repeat(32);
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = await connectMongo(replSet.getUri());
  const db = client.db(`myledja_test_${Date.now()}`);
  const mailer = new CaptureMailer();
  const moduleRef = await Test.createTestingModule({
    imports: [TestMongoModule.forRoot(client, db), UsersModule, WorkspacesModule, AuthModule],
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

export async function http(
  app: INestApplication,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ code: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${await app.getUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { code: res.status, json: text.length === 0 ? null : JSON.parse(text) };
}

export const TEST_PASSWORD = "correct-horse-battery";

export async function registerAndVerify(
  app: INestApplication,
  mailer: CaptureMailer,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<{ userId: string; workspaceId: string }> {
  const registered = await http(app, "POST", "/v1/auth/register", { email, password });
  expect(registered.code).toBe(202);
  const code = mailer.lastCode(email, "verify");
  expect(code).toBeDefined();
  const verified = await http(app, "POST", "/v1/auth/verify", { email, code });
  expect(verified.code).toBe(200);
  const body = verified.json as { userId: string; workspaceId: string };
  return { userId: body.userId, workspaceId: body.workspaceId };
}

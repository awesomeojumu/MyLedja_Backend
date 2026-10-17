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
import { BankIntegrationsModule } from "@/modules/bank-integrations/bank-integrations.module";
import { MONO_FETCH } from "@/modules/bank-integrations/domain/mono-client";

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

export interface TestLinkApp {
  app: INestApplication;
  db: Db;
  mailer: CaptureMailer;
  monoCalls: { url: string; method: string; body: unknown }[];
  stop: () => Promise<void>;
}

export async function startLinkApp(
  monoHandler?: (url: string, body: unknown) => unknown,
  options: { configured?: boolean } = {},
): Promise<TestLinkApp> {
  process.env.APP_ENV = "test";
  process.env.JWT_SECRET = "a".repeat(32);
  process.env.MONO_SEC_KEY = options.configured === false ? "" : "test_sk_fake";
  process.env.MONO_APP_ID = "6a2800772814c9ea0ed20b5e";
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = await connectMongo(replSet.getUri());
  const db = client.db(`myledja_test_${Date.now()}`);
  const mailer = new CaptureMailer();
  const monoCalls: TestLinkApp["monoCalls"] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    monoCalls.push({ url, method: init?.method ?? "GET", body });
    const payload = monoHandler ? monoHandler(url, body) : defaultMono(url);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const moduleRef = await Test.createTestingModule({
    imports: [TestMongoModule.forRoot(client, db), UsersModule, WorkspacesModule, AuthModule, BankIntegrationsModule],
  })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .overrideProvider(MONO_FETCH)
    .useValue(fetchImpl)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.listen(0);
  return {
    app,
    db,
    mailer,
    monoCalls,
    stop: async () => {
      await app.close();
      await db.dropDatabase();
      await client.close();
      await replSet.stop();
    },
  };
}

function defaultMono(url: string): unknown {
  if (url.endsWith("/v2/accounts/initiate")) {
    return { data: { mono_url: "https://connect.mono.co/sandbox" } };
  }
  if (url.endsWith("/v2/accounts/auth")) {
    return { id: "acc_gtb" };
  }
  if (url.includes("/v2/accounts/")) {
    return {
      account: {
        id: "acc_gtb",
        name: "Ada Okonkwo",
        accountNumber: "0131883465",
        balance: 20000,
        currency: "NGN",
        institution: { name: "GTBank" },
      },
    };
  }
  return {};
}

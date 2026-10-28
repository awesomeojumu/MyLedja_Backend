import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from 'mongodb';
import { inject } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.factory.js';
import type { Services } from '../../src/app.services.js';
import { Database } from '../../src/db/client.js';
import { migrate } from '../../src/db/migrations/index.js';
import type { GoogleIdentity, GoogleVerifier } from '../../src/modules/auth/tokens.js';
import type { EmailMessage, EmailSender } from '../../src/modules/notifications/email/email.js';
import { testConfig } from './test-config.js';

export class Outbox implements EmailSender {
  readonly provider = 'smtp' as const;
  messages: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.messages.push(m);
    return { id: `test-${this.messages.length}` };
  }
  to(email: string) {
    return this.messages.filter((m) => m.to === email);
  }
  lastCode(email: string): string {
    const m = [...this.to(email)].reverse().find((x) => /\b\d{6}\b/.test(x.text));
    const code = m?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code emailed to ${email}`);
    return code;
  }
}

export class FakeGoogle implements GoogleVerifier {
  tokens = new Map<string, GoogleIdentity>();
  async verify(idToken: string) {
    return this.tokens.get(idToken) ?? null;
  }
}

export type TestApp = {
  app: NestFastifyApplication;
  services: Services;
  db: Db;
  database: Database;
  outbox: Outbox;
  google: FakeGoogle;
  clock: { now: Date; advance(ms: number): void };
  close(): Promise<void>;
};

let counter = 0;

/** A fresh database on the shared in-memory replica set, migrated, with a fake email outbox. */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const dbName = `t_${process.pid}_${Date.now()}_${counter++}`;
  const config = testConfig({ MONGODB_URI: inject('mongoUri'), MONGODB_DB: dbName, ...env });
  const database = await Database.connect(config.mongodbUri, config.mongodbDb);
  await migrate(database.db);
  const outbox = new Outbox();
  const google = new FakeGoogle();
  const clock = {
    now: new Date(),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const { app, services } = await createApp(config, database, {
    quiet: true,
    emailSender: outbox,
    google: env.GOOGLE_CLIENT_ID ? google : null,
    hasher: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
    now: () => clock.now,
  });
  return {
    app,
    services,
    db: database.db,
    database,
    outbox,
    google,
    clock,
    async close() {
      await app.close();
      await database.db.dropDatabase();
      await database.close();
    },
  };
}

export const op = () => ({ 'x-operation-id': uuidv7() });

export type SignedIn = {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  workspaceId: string;
  auth: Record<string, string>;
};

let people = 0;

/** Signs up and confirms a new person; returns their tokens and Personal workspace. */
export async function signUp(t: TestApp, name = 'Ada'): Promise<SignedIn> {
  const n = people++;
  const email = `${name.toLowerCase()}.${n}@example.test`;
  const password = 'a-long-unusual-passphrase';
  // Unique IP so bulk six-pack suites don't trip signup-ip / verify-ip rate limits.
  const remoteAddress = `10.${Math.floor(n / 250) % 256}.${n % 250}.${1 + (n % 200)}`;
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-up',
    remoteAddress,
    headers: op(),
    payload: { name, email, password, termsAccepted: true },
  });
  if (res.statusCode !== 202) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
  const verified = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    remoteAddress,
    headers: op(),
    payload: { email, code: t.outbox.lastCode(email), deviceName: 'Test phone' },
  });
  if (verified.statusCode !== 200) throw new Error(`verify failed: ${verified.statusCode} ${verified.body}`);
  const body = verified.json();
  return {
    email,
    password,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    workspaceId: body.user.workspaceId,
    auth: { authorization: `Bearer ${body.accessToken}` },
  };
}

/** Two people, each with their own workspace: A's data must never reach B (build plan 3.3 test 4). */
export async function twoWorkspaces(t: TestApp) {
  return { a: await signUp(t, 'Ada'), b: await signUp(t, 'Bola') };
}

/** Adds `who` to `workspaceId` with `role`, for role tests (invitations ship later). */
export async function addMember(t: TestApp, workspaceId: string, userId: string, role: 'admin' | 'editor' | 'viewer') {
  const now = new Date();
  // Test-only shortcut: invitations aren't built yet, so the membership is written directly.
  await t.db
    .collection('memberships')
    .insertOne({ _id: uuidv7() as never, workspaceId, userId, role, createdAt: now, updatedAt: now, version: 1 });
}

/** A workspace for service-level tests, made the way sign-up makes one but without the HTTP limits. */
export async function newWorkspace(t: TestApp) {
  const userId = uuidv7();
  const ctx = await t.database.transaction((session) => t.services.workspaces.createPersonal(userId, session));
  return { userId, workspaceId: ctx.workspaceId, ctx };
}

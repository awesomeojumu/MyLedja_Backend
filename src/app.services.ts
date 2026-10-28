import type { FastifyReply } from 'fastify';
import type { AppConfig } from './config/config.schema.js';
import { Crypto } from './common/crypto/crypto.js';
import { IdempotencyRepository } from './common/http/idempotency.repository.js';
import { RateLimitRepository } from './common/http/rate-limit.repository.js';
import type { Database } from './db/client.js';
import { JobRunner } from './jobs/runner.js';
import { cleanExpiredJob } from './jobs/clean-expired.job.js';
import { JobsRepository } from './jobs/jobs.repository.js';
import {
  AccountBalancesRepository,
  ChangesRepository,
  LedgerAccountsRepository,
  PeriodTotalsRepository,
  TransactionsRepository,
  WorkspaceIndex,
} from './modules/ledger/ledger.repository.js';
import { LedgerService } from './modules/ledger/ledger.service.js';
import { BalanceCheck, balanceCheckJob, BalanceChecksRepository } from './modules/ledger/balance-check.js';
import {
  CategoriesRepository,
  GroupsRepository,
  PayeeMergesRepository,
  PayeesRepository,
  TagsRepository,
} from './modules/categories/categories.repository.js';
import { CategoriesService } from './modules/categories/categories.service.js';
import { AuditRepository } from './modules/audit/audit.repository.js';
import { CodesRepository, SessionsRepository, UsersRepository } from './modules/auth/auth.repository.js';
import { AuthService, COOKIE_ABSOLUTE_MS } from './modules/auth/auth.service.js';
import {
  DEFAULT_HASHER,
  type GoogleVerifier,
  type HasherOptions,
  JoseGoogleVerifier,
  PasswordHasher,
  TokenService,
} from './modules/auth/tokens.js';
import { type EmailSender, Mailer, pickSender } from './modules/notifications/email/email.js';
import {
  CountersRepository,
  MembershipLookup,
  MembershipsRepository,
  WorkspacesRepository,
} from './modules/workspaces/workspaces.repository.js';
import { WorkspacesService } from './modules/workspaces/workspaces.service.js';

export const SERVICES = Symbol('SERVICES');
export const REFRESH_COOKIE = 'myledja_refresh';
export const REFRESH_COOKIE_PATH = '/v1/auth/refresh';

export type ServiceOverrides = {
  emailSender?: EmailSender;
  google?: GoogleVerifier | null;
  hasher?: HasherOptions;
  now?: () => Date;
};

/** Builds every module's pieces from the config and the one database connection. */
export function buildServices(config: AppConfig, database: Database, o: ServiceOverrides = {}) {
  const db = database.db;
  const crypto = new Crypto(config.accountNumberKey);
  const now = o.now ?? (() => new Date());
  const webAppUrl = config.corsOrigins[0] ?? config.appUrl;
  const mailer = new Mailer(o.emailSender ?? pickSender(config), webAppUrl);
  const audit = new AuditRepository(db);
  const memberships = new MembershipLookup(db);
  const counters = new CountersRepository(db);
  const ledger = new LedgerService(
    database,
    new LedgerAccountsRepository(db),
    new TransactionsRepository(db),
    new AccountBalancesRepository(db),
    new PeriodTotalsRepository(db),
    new ChangesRepository(db),
    counters,
    audit,
    now,
  );
  const workspacesRepo = new WorkspacesRepository(db);
  const categories = new CategoriesService(
    database,
    new CategoriesRepository(db),
    new GroupsRepository(db),
    new TagsRepository(db),
    new PayeesRepository(db),
    new PayeeMergesRepository(db),
    ledger,
    audit,
    async (ctx, session) => (await workspacesRepo.get(ctx, { session }))?.currency ?? 'NGN',
    now,
  );
  const workspaces = new WorkspacesService(
    database,
    workspacesRepo,
    new MembershipsRepository(db),
    memberships,
    counters,
    audit,
    ledger,
    categories,
  );
  const google =
    o.google !== undefined ? o.google : config.google ? new JoseGoogleVerifier(config.google.clientId) : null;
  const sessions = new SessionsRepository(db);
  const codes = new CodesRepository(db);
  const limits = new RateLimitRepository(db, now);
  const idempotency = new IdempotencyRepository(db);
  const auth = new AuthService(
    config,
    database,
    new UsersRepository(db),
    sessions,
    codes,
    limits,
    audit,
    workspaces,
    new PasswordHasher(o.hasher ?? DEFAULT_HASHER),
    new TokenService(config.jwtSecret, now),
    crypto,
    mailer,
    google,
    now,
  );
  const secure = config.appUrl.startsWith('https://');
  const writeCookie = (reply: FastifyReply, token: string) => {
    void reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: Math.floor(COOKIE_ABSOLUTE_MS / 1000),
    });
  };
  const clearCookie = (reply: FastifyReply) => {
    void reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH, httpOnly: true, secure, sameSite: 'strict' });
  };
  const jobs = new JobRunner(new JobsRepository(db), mailer, config.contactEmail, now);
  jobs.register(cleanExpiredJob({ sessions, codes, limits }));
  const balanceCheck = new BalanceCheck(
    new WorkspaceIndex(db),
    ledger,
    new BalanceChecksRepository(db),
    mailer,
    config.contactEmail,
    now,
  );
  jobs.register(balanceCheckJob(balanceCheck));

  return {
    config,
    database,
    crypto,
    mailer,
    audit,
    memberships,
    workspaces,
    ledger,
    categories,
    balanceCheck,
    auth,
    idempotency,
    limits,
    jobs,
    writeCookie,
    clearCookie,
  };
}

export type Services = ReturnType<typeof buildServices>;

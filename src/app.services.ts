import type { FastifyReply } from 'fastify';
import type { ClientSession } from 'mongodb';
import type { WorkspaceContext } from './common/workspace/workspace-context.js';
import { AccountsService } from './modules/accounts/accounts.service.js';
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
import { TransferDismissalsRepository, TransactionsService } from './modules/transactions/transactions.service.js';
import { BudgetMonthsRepository } from './modules/budget/budget.repository.js';
import { BudgetService } from './modules/budget/budget.service.js';
import { ReconciliationsRepository } from './modules/reconcile/reconcile.repository.js';
import { ReconcileService } from './modules/reconcile/reconcile.service.js';
import { ImportsRepository } from './modules/imports/imports.repository.js';
import { ImportsService } from './modules/imports/imports.service.js';
import { SyncService } from './modules/sync/sync.service.js';
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
  const changes = new ChangesRepository(db);
  const ledger = new LedgerService(
    database,
    new LedgerAccountsRepository(db),
    new TransactionsRepository(db),
    new AccountBalancesRepository(db),
    new PeriodTotalsRepository(db),
    changes,
    counters,
    audit,
    now,
  );
  const workspacesRepo = new WorkspacesRepository(db);
  const categoriesRepo = new CategoriesRepository(db);
  const payeesRepo = new PayeesRepository(db);
  const categories = new CategoriesService(
    database,
    categoriesRepo,
    new GroupsRepository(db),
    new TagsRepository(db),
    payeesRepo,
    new PayeeMergesRepository(db),
    ledger,
    audit,
    async (ctx, session) => (await workspacesRepo.get(ctx, { session }))?.currency ?? 'NGN',
    now,
  );
  const currencyOf = async (ctx: WorkspaceContext, session?: ClientSession) =>
    (await workspacesRepo.get(ctx, { session }))?.currency ?? 'NGN';
  const accounts = new AccountsService(database, ledger, audit, currencyOf, now);
  const transactions = new TransactionsService(
    database,
    ledger,
    new TransferDismissalsRepository(db),
    categoriesRepo,
    payeesRepo,
    audit,
    now,
  );
  const reconcile = new ReconcileService(
    database,
    new ReconciliationsRepository(db),
    ledger,
    accounts,
    transactions,
    audit,
    now,
  );
  transactions.onUnlock = (ctx, reconciliationId, transactionId, session) =>
    reconcile.recordUnlock(ctx, reconciliationId, transactionId, session);
  const budget = new BudgetService(
    database,
    new BudgetMonthsRepository(db),
    ledger,
    categories,
    categoriesRepo,
    workspacesRepo,
    transactions,
    audit,
    now,
  );
  const imports = new ImportsService(
    database,
    new ImportsRepository(db),
    ledger,
    accounts,
    categoriesRepo,
    audit,
    config,
    now,
  );
  const sync = new SyncService(counters, changes, ledger, transactions, accounts, categories, budget, now);
  const workspaces = new WorkspacesService(
    database,
    workspacesRepo,
    new MembershipsRepository(db),
    memberships,
    counters,
    audit,
    ledger,
    categories,
    accounts,
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
    accounts,
    transactions,
    reconcile,
    budget,
    imports,
    sync,
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

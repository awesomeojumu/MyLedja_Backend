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
import { billRemindersJob, recurringDailyJob } from './jobs/planning.job.js';
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
import { BudgetMonthsRepository, BudgetTemplatesRepository } from './modules/budget/budget.repository.js';
import { BudgetService } from './modules/budget/budget.service.js';
import { ReconciliationsRepository } from './modules/reconcile/reconcile.repository.js';
import { ReconcileService } from './modules/reconcile/reconcile.service.js';
import { ImportsRepository } from './modules/imports/imports.repository.js';
import { ImportsService } from './modules/imports/imports.service.js';
import { SyncService } from './modules/sync/sync.service.js';
import { SchedulesRepository, OccurrencesRepository } from './modules/schedules/schedules.repository.js';
import { SchedulesService } from './modules/schedules/schedules.service.js';
import { DebtsRepository } from './modules/debts/debts.repository.js';
import { DebtsService } from './modules/debts/debts.service.js';
import { GoalsRepository, GoalAllocationsRepository } from './modules/goals/goals.repository.js';
import { GoalsService } from './modules/goals/goals.service.js';
import { IncomeStreamsRepository } from './modules/income/income.repository.js';
import { IncomeService } from './modules/income/income.service.js';
import { NotificationsRepository } from './modules/notifications/notifications.repository.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import {
  CountersRepository,
  MembershipLookup,
  MembershipsRepository,
  WorkspacesRepository,
} from './modules/workspaces/workspaces.repository.js';
import { WorkspacesService } from './modules/workspaces/workspaces.service.js';
import { SecurityService } from './modules/security/security.service.js';
import { ExportsRepository } from './modules/exports/exports.repository.js';
import { ExportsService } from './modules/exports/exports.service.js';
import { fileStoreFor } from './modules/files/cloudinary.js';
import { deleteAccountJob, nightlyBackupJob } from './jobs/trust.jobs.js';
import { AiService } from './modules/ai/ai.service.js';
import { providersFor } from './modules/ai/ai.providers.js';
import { StatementsService } from './modules/imports/statements/statements.service.js';
import { RulesRepository } from './modules/rules/rules.repository.js';
import { RulesService } from './modules/rules/rules.service.js';
import { BankLinkIndex, BankLinksRepository } from './modules/banking/banking.repository.js';
import { BankingService } from './modules/banking/banking.service.js';
import { MonoProvider } from './modules/banking/mono.js';

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
  const goalAllocationsRepo = new GoalAllocationsRepository(db);
  const budget = new BudgetService(
    database,
    new BudgetMonthsRepository(db),
    new BudgetTemplatesRepository(db),
    ledger,
    categories,
    categoriesRepo,
    workspacesRepo,
    transactions,
    goalAllocationsRepo,
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
  const notifications = new NotificationsService(database, new NotificationsRepository(db), ledger, now);
  const schedules = new SchedulesService(
    database,
    new SchedulesRepository(db),
    new OccurrencesRepository(db),
    ledger,
    transactions,
    audit,
    notifications,
    now,
  );
  const debts = new DebtsService(
    database,
    new DebtsRepository(db),
    payeesRepo,
    ledger,
    transactions,
    audit,
    currencyOf,
    now,
  );
  const goals = new GoalsService(database, new GoalsRepository(db), goalAllocationsRepo, ledger, audit, now);
  const income = new IncomeService(
    database,
    new IncomeStreamsRepository(db),
    schedules,
    transactions,
    ledger,
    audit,
    now,
  );
  const sync = new SyncService(
    counters,
    changes,
    ledger,
    transactions,
    accounts,
    categories,
    budget,
    schedules,
    debts,
    goals,
    income,
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
    accounts,
  );
  const google =
    o.google !== undefined ? o.google : config.google ? new JoseGoogleVerifier(config.google.clientId) : null;
  const sessions = new SessionsRepository(db);
  const codes = new CodesRepository(db);
  const limits = new RateLimitRepository(db, now);
  const idempotency = new IdempotencyRepository(db);
  const users = new UsersRepository(db);
  const hasher = new PasswordHasher(o.hasher ?? DEFAULT_HASHER);
  const auth = new AuthService(
    config,
    database,
    users,
    sessions,
    codes,
    limits,
    audit,
    workspaces,
    hasher,
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
  const workspaceIndex = new WorkspaceIndex(db);
  jobs.register(billRemindersJob({ workspaces: workspaceIndex, workspaceDocs: workspacesRepo, schedules, now }));
  jobs.register(recurringDailyJob({ workspaces: workspaceIndex, schedules, now }));
  const files = fileStoreFor(config);
  const security = new SecurityService(
    config,
    users,
    sessions,
    auth,
    hasher,
    crypto,
    limits,
    audit,
    workspaces,
    now,
    notifications,
    mailer,
  );
  const exports = new ExportsService(
    database,
    new ExportsRepository(db),
    security,
    ledger,
    users,
    sessions,
    audit,
    jobs,
    crypto,
    files,
    now,
  );
  jobs.register(nightlyBackupJob(exports));
  jobs.register(deleteAccountJob(exports));
  const ai = new AiService(providersFor(config), workspacesRepo, now);
  const statements = new StatementsService(imports, ai, users, categoriesRepo, files);
  const rules = new RulesService(database, new RulesRepository(db), ledger, audit, now);
  imports.rules = rules;
  sync.rules = rules;
  const banking = new BankingService(
    config.mono ? new MonoProvider(config.mono) : null,
    config.mono?.webhookSecret ?? null,
    new BankLinksRepository(db),
    new BankLinkIndex(db),
    imports,
    crypto,
    audit,
    jobs,
    now,
  );
  jobs.register({
    name: 'bank-sync',
    everySeconds: 86_400,
    maxAttempts: 3,
    run: (job) => banking.runSync(job.payload),
  });

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
    schedules,
    debts,
    goals,
    income,
    notifications,
    sync,
    balanceCheck,
    auth,
    security,
    exports,
    files,
    ai,
    statements,
    rules,
    banking,
    categoriesRepo,
    idempotency,
    limits,
    jobs,
    writeCookie,
    clearCookie,
  };
}

export type Services = ReturnType<typeof buildServices>;

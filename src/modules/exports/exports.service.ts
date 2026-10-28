import { createHash } from 'node:crypto';
import { BSON, type Document } from 'mongodb';
import type { z } from 'zod';
import type { Crypto } from '../../common/crypto/crypto.js';
import { AppError } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { memberContext, type WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { JobRunner } from '../../jobs/runner.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { SessionsRepository, UsersRepository } from '../auth/auth.repository.js';
import type { FileStore } from '../files/cloudinary.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { SecurityService } from '../security/security.service.js';
import { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, type RestorePreview } from './exports.contract.js';
import { type ExportsRepository, WORKSPACE_DATA } from './exports.repository.js';

const { EJSON } = BSON;

const MESSAGES = {
  damaged: "This backup file is damaged or was changed after it was made. MyLedja can't restore it.",
  newer: 'This backup was made by a newer version of MyLedja. Update the app and try again.',
  notBackup: "This isn't a MyLedja backup file.",
} as const;

type BackupFile = {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  createdAt: string;
  workspace: { name: string; currency: string; timeZone: string; budgetStyle: string; weekStart: string };
  data: Record<string, Document[]>;
  checksum: string;
};

/** Collections the app's change feed knows, with the feed's name and how a record's feed id is made. */
const FEED: [string, string, (d: Document) => string | null][] = [
  ['category_groups', 'category_groups', (d) => String(d._id)],
  ['categories', 'categories', (d) => String(d._id)],
  ['ledger_accounts', 'accounts', (d) => (d.accountType ? String(d._id) : null)],
  ['payees', 'payees', (d) => String(d._id)],
  ['tags', 'tags', (d) => String(d._id)],
  ['transactions', 'transactions', (d) => String(d._id)],
  ['budget_months', 'budget_months', (d) => `${d.categoryId}:${d.month}`],
  ['schedules', 'schedules', (d) => String(d._id)],
  ['occurrences', 'occurrences', (d) => String(d._id)],
  ['debts', 'debts', (d) => String(d._id)],
  ['goals', 'goals', (d) => String(d._id)],
  ['goal_allocations', 'goal_allocations', (d) => String(d._id)],
  ['income_streams', 'income_streams', (d) => String(d._id)],
];

/** Spreadsheet formula injection: a cell starting with =, +, - or @ is read as text (TECH-SPEC 10). */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function minorToText(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

const toBig = (v: unknown) => BigInt(String(v ?? 0));

/** Replaces every string that is a known id, anywhere in a document, with its new id. */
function remap(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remap(v, ids));
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, ids)]));
  }
  return value;
}

export class ExportsService {
  constructor(
    private readonly database: Database,
    private readonly repo: ExportsRepository,
    private readonly security: SecurityService,
    private readonly ledger: LedgerService,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly audit: AuditRepository,
    private readonly jobs: JobRunner,
    private readonly crypto: Crypto,
    private readonly files: FileStore | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async exportCsv(ctx: WorkspaceContext, sessionId: string) {
    await this.security.requireRecent(sessionId);
    const data = await this.repo.dumpWorkspace(ctx.workspaceId);
    const accounts = new Map((data.ledger_accounts ?? []).map((a) => [String(a._id), a]));
    const categories = new Map((data.categories ?? []).map((c) => [String(c._id), String(c.name)]));
    const payees = new Map((data.payees ?? []).map((p) => [String(p._id), String(p.name)]));
    const rows = [['Date', 'Type', 'Account', 'Category', 'Payee', 'Amount', 'Currency', 'Notes', 'Status']];
    const txs = [...(data.transactions ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const tx of txs) {
      const lines = (tx.lines as Document[]) ?? [];
      const real = lines.filter((l) => accounts.get(String(l.ledgerAccountId))?.accountType);
      const amount = real.reduce((s, l) => s + toBig(l.amountMinor), 0n);
      const cats = [
        ...new Set(lines.map((l) => (l.categoryId ? categories.get(String(l.categoryId)) : undefined)).filter(Boolean)),
      ];
      rows.push([
        String(tx.date),
        String(tx.type),
        real.map((l) => String(accounts.get(String(l.ledgerAccountId))?.name ?? '')).join(' → '),
        cats.join(' + '),
        tx.payeeId ? (payees.get(String(tx.payeeId)) ?? '') : '',
        minorToText(amount),
        String(lines[0]?.currency ?? 'NGN'),
        String(tx.notes ?? ''),
        String(tx.status),
      ]);
    }
    await this.audit.record(ctx, { action: 'export.csv', target: { collection: 'workspaces', id: ctx.workspaceId } });
    const day = this.now().toISOString().slice(0, 10);
    return {
      filename: `myledja-transactions-${day}.csv`,
      mimeType: 'text/csv',
      content: rows.map((r) => r.map(csvCell).join(',')).join('\n'),
    };
  }

  async backup(ctx: WorkspaceContext, sessionId: string) {
    await this.security.requireRecent(sessionId);
    const ws = await this.repo.workspaceDoc(ctx.workspaceId);
    const data = await this.repo.dumpWorkspace(ctx.workspaceId);
    const body = EJSON.stringify(data, { relaxed: false });
    const file = {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: this.now().toISOString(),
      workspace: {
        name: String(ws?.name ?? 'Personal'),
        currency: String(ws?.currency ?? 'NGN'),
        timeZone: String(ws?.timeZone ?? 'Africa/Lagos'),
        budgetStyle: String(ws?.budgetStyle ?? 'tracking'),
        weekStart: String(ws?.weekStart ?? 'monday'),
      },
      data: JSON.parse(body) as Record<string, Document[]>,
      checksum: createHash('sha256').update(body).digest('hex'),
    };
    await this.audit.record(ctx, {
      action: 'export.backup',
      target: { collection: 'workspaces', id: ctx.workspaceId },
    });
    const day = this.now().toISOString().slice(0, 10);
    return { filename: `myledja-backup-${day}.json`, mimeType: 'application/json', content: JSON.stringify(file) };
  }

  /** Reads and checks a backup file. Nothing is written until this passes. */
  private read(content: string): BackupFile & { docs: Record<string, Document[]> } {
    let file: BackupFile;
    try {
      file = JSON.parse(content) as BackupFile;
    } catch {
      throw new AppError(400, 'backup_unreadable', MESSAGES.notBackup, { field: 'content' });
    }
    if (file?.format !== BACKUP_FORMAT || !file.data || typeof file.checksum !== 'string') {
      throw new AppError(400, 'backup_unreadable', MESSAGES.notBackup, { field: 'content' });
    }
    if (file.schemaVersion > BACKUP_SCHEMA_VERSION)
      throw new AppError(400, 'backup_newer', MESSAGES.newer, { field: 'content' });
    const body = JSON.stringify(file.data);
    if (createHash('sha256').update(body).digest('hex') !== file.checksum) {
      throw new AppError(400, 'backup_damaged', MESSAGES.damaged, { field: 'content' });
    }
    return { ...file, docs: EJSON.parse(body, { relaxed: false }) as Record<string, Document[]> };
  }

  async restorePreview(content: string): Promise<z.input<typeof RestorePreview>> {
    const f = this.read(content);
    const dates = (f.docs.transactions ?? []).map((t) => String(t.date)).sort();
    return {
      workspaceName: f.workspace.name,
      createdAt: f.createdAt,
      accounts: (f.docs.ledger_accounts ?? []).filter((a) => a.accountType).length,
      transactions: (f.docs.transactions ?? []).length,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      categories: (f.docs.categories ?? []).filter((c) => !c.system).length,
      goals: (f.docs.goals ?? []).length,
      debts: (f.docs.debts ?? []).length,
      bills: (f.docs.schedules ?? []).length,
    };
  }

  /** Restores into a new workspace with new ids; the person's current workspace is never touched (TECH-SPEC 11). */
  async restore(userId: string, sessionId: string, content: string) {
    await this.security.requireRecent(sessionId);
    const f = this.read(content);
    const workspaceId = newId();
    const ids = new Map<string, string>();
    for (const name of WORKSPACE_DATA) for (const d of f.docs[name] ?? []) ids.set(String(d._id), newId());
    const data: Record<string, Document[]> = {};
    for (const name of WORKSPACE_DATA) data[name] = (f.docs[name] ?? []).map((d) => remap(d, ids) as Document);

    const now = this.now();
    const day = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: f.workspace.timeZone,
    }).format(now);
    const name = `${f.workspace.name} (restored ${day})`.slice(0, 60);
    const ctx = memberContext({ workspaceId, userId, sessionId, role: 'owner' });
    await this.database.transaction(async (session) => {
      await this.repo.insertRaw(
        'workspaces',
        {
          _id: workspaceId,
          workspaceId,
          name,
          type: 'personal',
          currency: f.workspace.currency,
          timeZone: f.workspace.timeZone,
          weekStart: f.workspace.weekStart,
          budgetStyle: f.workspace.budgetStyle,
          setupComplete: true,
          skippedSteps: [],
          features: [],
          ownerId: userId,
          setupDraft: null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      await this.repo.insertRaw(
        'memberships',
        { _id: newId(), workspaceId, userId, role: 'owner', createdAt: now, updatedAt: now, version: 1 },
        { session },
      );
      await this.repo.insertRaw('counters', { _id: workspaceId, workspaceId, seq: 0n }, { session });
      await this.repo.insertWorkspace(workspaceId, data, { session });
      // A device opening the restored workspace downloads it through the change feed.
      const items = FEED.flatMap(([raw, feed, idOf]) =>
        (data[raw] ?? [])
          .map((d) => idOf(d))
          .filter((x): x is string => x !== null)
          .map((docId) => ({ collection: feed, docId, op: 'upsert' as const })),
      );
      if (items.length) await this.ledger.feed(ctx, items, session);
      await this.audit.record(
        ctx,
        { action: 'workspace.restored', target: { collection: 'workspaces', id: workspaceId } },
        { session },
      );
    });
    return { workspaceId, workspaceName: name };
  }

  async deleteAccount(userId: string, sessionId: string) {
    await this.security.requireRecent(sessionId);
    const workspaces = await this.repo.soleOwnedWorkspaces(userId);
    // Signing in is refused from now on; the job clears the data.
    await this.users.setFields(userId, { deletedAt: this.now() });
    await this.sessions.revokeAllForUser(userId, 'account_deleted', null);
    await this.jobs.enqueue('delete-account', this.now(), 10, { userId });
    return { deletingWorkspaces: workspaces.length };
  }

  /** The job: every collection and file for the person's workspaces, then the person (B3.7). */
  async runDeletion(userId: string) {
    const user = await this.users.byIdIncludingDeleted(userId);
    if (!user) return;
    for (const workspaceId of await this.repo.soleOwnedWorkspaces(userId)) {
      if (this.files) {
        for (const f of await this.files.list(`workspaces/${workspaceId}`).catch(() => []))
          await this.files.destroy(f.publicId);
      }
      await this.repo.deleteWorkspace(workspaceId);
    }
    await this.repo.deletePerson(userId, user.email);
  }

  /** Nightly: every collection, encrypted with the "backup" key, to Cloudinary, kept 30 days (TECH-SPEC 5.10). */
  async nightlyBackup() {
    if (!this.files) return;
    const now = this.now();
    const content = EJSON.stringify(await this.repo.dumpAll(), { relaxed: false });
    const sealed = this.crypto.encrypt('backup', Buffer.from(content));
    await this.files.upload(`backups/${now.toISOString().slice(0, 10)}`, Buffer.from(sealed));
    const cutoff = now.getTime() - 30 * 86_400_000;
    for (const f of await this.files.list('backups')) {
      if (f.createdAt.getTime() < cutoff) await this.files.destroy(f.publicId);
    }
  }
}

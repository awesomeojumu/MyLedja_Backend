import { timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { Crypto } from '../../common/crypto/crypto.js';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { systemContext, type WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { JobRunner } from '../../jobs/runner.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { ImportsService } from '../imports/imports.service.js';
import type { BankLink } from './banking.contract.js';
import type { BankLinkDoc, BankLinkIndex, BankLinksRepository } from './banking.repository.js';
import type { BankProvider } from './mono.js';

const MESSAGES = {
  off: "Bank connections aren't available yet. Import a statement instead.",
  failed: "MyLedja couldn't reach your bank. Try again later.",
} as const;

const FIRST_SYNC_DAYS = 90;

const toText = (minor: bigint) => {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
};
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Bank connections through the provider interface (build plan B4.6). Synced transactions go to the same review as an
 * import, where a bank transaction matching a manual one is marked as a duplicate and isn't posted twice, and rules,
 * AI suggestions and money-back prompts apply before anything posts.
 */
export class BankingService {
  private readonly logger = new Logger('Banking');

  constructor(
    private readonly provider: BankProvider | null,
    private readonly webhookSecret: string | null,
    private readonly links: BankLinksRepository,
    private readonly index: BankLinkIndex,
    private readonly imports: ImportsService,
    private readonly crypto: Crypto,
    private readonly audit: AuditRepository,
    private readonly jobs: JobRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private need(): BankProvider {
    if (!this.provider) throw new AppError(404, 'bank_off', MESSAGES.off);
    return this.provider;
  }

  private view(d: BankLinkDoc): z.input<typeof BankLink> {
    return {
      id: d._id,
      accountId: d.accountId,
      provider: d.provider,
      institution: d.institution,
      last4: d.last4,
      status: d.status,
      lastSyncedAt: d.lastSyncedAt?.toISOString() ?? null,
    };
  }

  async link(ctx: WorkspaceContext, body: { id?: string | undefined; accountId: string; code: string }) {
    const provider = this.need();
    let providerId: string;
    let info;
    try {
      providerId = await provider.exchange(body.code);
      info = await provider.account(providerId);
    } catch {
      throw new AppError(502, 'bank_unreachable', MESSAGES.failed);
    }
    const now = this.now();
    const doc: Omit<BankLinkDoc, 'workspaceId'> = {
      _id: body.id ?? newId(),
      accountId: body.accountId,
      provider: 'mono',
      providerAccount: this.crypto.encrypt('bank-link', providerId),
      providerAccountHash: this.crypto.hash('token-hash', providerId),
      institution: info.institution,
      last4: info.last4,
      status: 'active',
      lastSyncedAt: null,
      lastSyncedDate: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await this.links.insertOne(ctx, doc);
    await this.audit.record(ctx, { action: 'bank.linked', target: { collection: 'bank_links', id: doc._id } });
    return this.view({ ...doc, workspaceId: ctx.workspaceId });
  }

  async list(ctx: WorkspaceContext) {
    const rows = await this.links.find(ctx, { status: { $ne: 'disconnected' } });
    return { links: rows.map((d) => this.view(d)), available: this.provider !== null };
  }

  /** Pulls transactions since the last sync into a review import. Nothing posts until the person reviews it. */
  async sync(ctx: WorkspaceContext, linkId: string) {
    const provider = this.need();
    const link = await this.links.findOne(ctx, { _id: linkId });
    if (!link || link.status === 'disconnected') throw Errors.notFound();
    const since =
      link.lastSyncedDate ?? new Date(this.now().getTime() - FIRST_SYNC_DAYS * 86_400_000).toISOString().slice(0, 10);
    let txs;
    try {
      txs = await provider.transactions(this.crypto.decryptText('bank-link', link.providerAccount), since);
    } catch {
      await this.links.updateOne(ctx, { _id: linkId }, { $set: { status: 'needs_reauth', updatedAt: this.now() } });
      throw new AppError(502, 'bank_unreachable', MESSAGES.failed);
    }
    const now = this.now();
    await this.links.updateOne(
      ctx,
      { _id: linkId },
      {
        $set: { lastSyncedAt: now, lastSyncedDate: now.toISOString().slice(0, 10), status: 'active', updatedAt: now },
        $inc: { version: 1 },
      },
    );
    if (txs.length === 0) return { import: null, newTransactions: 0 };
    const id = newId();
    const csv = [
      'Date,Description,Amount',
      ...txs.map((t) => [t.date, csvCell(t.narration), toText(t.amountMinor)].join(',')),
    ].join('\n');
    await this.imports.upload(ctx, {
      id,
      accountId: link.accountId,
      fileName: `${link.institution} ${now.toISOString().slice(0, 10)}`,
      content: csv,
    });
    const view = await this.imports.map(ctx, id, {
      date: 0,
      description: 1,
      amount: 2,
      moneyIn: null,
      moneyOut: null,
      payee: null,
      notes: null,
      dateFormat: 'YYYY-MM-DD',
      hasHeader: true,
    });
    await this.audit.record(ctx, { action: 'bank.synced', target: { collection: 'bank_links', id: linkId } });
    return { import: { ...view, reader: 'parser' as const, bank: null }, newTransactions: view.counts.new };
  }

  async disconnect(ctx: WorkspaceContext, linkId: string) {
    const link = await this.links.findOne(ctx, { _id: linkId });
    if (!link) throw Errors.notFound();
    if (this.provider)
      await this.provider.unlink(this.crypto.decryptText('bank-link', link.providerAccount)).catch(() => undefined);
    await this.links.updateOne(
      ctx,
      { _id: linkId },
      { $set: { status: 'disconnected', updatedAt: this.now() }, $inc: { version: 1 } },
    );
    await this.audit.record(ctx, { action: 'bank.disconnected', target: { collection: 'bank_links', id: linkId } });
  }

  /** Mono's webhook is read only after its secret header matches MONO_WEBHOOK_SECRET (TECH-SPEC 5.8). */
  async webhook(secretHeader: string | undefined, body: Record<string, unknown>) {
    const expected = this.webhookSecret;
    const ok =
      !!expected &&
      !!secretHeader &&
      secretHeader.length === expected.length &&
      timingSafeEqual(Buffer.from(secretHeader), Buffer.from(expected));
    if (!ok) throw Errors.unauthorized('webhook_refused', 'Webhook refused.');
    const data = (body.data ?? {}) as { account?: { _id?: string; id?: string } | string };
    const accountId = typeof data.account === 'string' ? data.account : (data.account?._id ?? data.account?.id);
    if (!accountId) return { ok: true as const };
    const link = await this.index.byProviderHash(this.crypto.hash('token-hash', accountId));
    if (link) await this.jobs.enqueue('bank-sync', this.now(), 3, { workspaceId: link.workspaceId, linkId: link._id });
    return { ok: true as const };
  }

  /** The job: one link (from the webhook), or every active link as the daily back-stop. */
  async runSync(payload?: Record<string, string>) {
    if (!this.provider) return;
    const targets = payload?.linkId
      ? [{ workspaceId: payload.workspaceId!, _id: payload.linkId }]
      : (await this.index.active()).map((l) => ({ workspaceId: l.workspaceId, _id: l._id }));
    for (const t of targets) {
      const ctx = systemContext(t.workspaceId);
      await this.sync(ctx, t._id).catch(() =>
        this.logger.warn(JSON.stringify({ event: 'bank_sync_failed', linkId: t._id })),
      );
    }
  }
}

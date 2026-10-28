import { Logger } from '@nestjs/common';
import type { Db } from 'mongodb';
import { newId } from '../../common/ids/ids.js';
import { toMinorString } from '../../common/money/money.js';
import { BaseRepository } from '../../common/repository/base.repository.js';
import { systemContext, type WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { JobHandler } from '../../jobs/runner.js';
import type { Mailer } from '../notifications/email/email.js';
import type { WorkspaceIndex } from './ledger.repository.js';
import type { LedgerService } from './ledger.service.js';

export type Mismatch =
  | { kind: 'balance'; ledgerAccountId: string; currency: string; stored: string; fromLines: string }
  | { kind: 'unbalanced'; currency: string; total: string };

export type BalanceCheckDoc = {
  _id: string;
  workspaceId: string;
  at: Date;
  ok: boolean;
  mismatches: Mismatch[];
};

export class BalanceChecksRepository extends BaseRepository<BalanceCheckDoc> {
  constructor(db: Db) {
    super(db, 'balance_checks');
  }

  latest(ctx: WorkspaceContext) {
    return this.find(ctx, {}, { sort: { at: -1 }, limit: 1 }).then((r) => r[0] ?? null);
  }
}

/**
 * The nightly check (TECH-SPEC 5.4, build plan B1.14): every stored balance must equal the sum of its
 * lines, and every workspace's lines must add up to zero per currency. A mismatch is recorded and
 * emailed to CONTACT_EMAIL. It is never silently overwritten.
 */
export class BalanceCheck {
  private readonly logger = new Logger('BalanceCheck');

  constructor(
    private readonly workspaces: WorkspaceIndex,
    private readonly ledger: LedgerService,
    private readonly checks: BalanceChecksRepository,
    private readonly mailer: Mailer,
    private readonly contactEmail: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runAll(): Promise<{ checked: number; failed: number }> {
    let failed = 0;
    const ids = await this.workspaces.ids();
    for (const id of ids) if (!(await this.check(systemContext(id))).ok) failed += 1;
    return { checked: ids.length, failed };
  }

  async check(ctx: WorkspaceContext): Promise<BalanceCheckDoc> {
    const sums = await this.ledger.transactions.aggregate<{ _id: { a: string; c: string }; total: bigint }>(ctx, [
      { $unwind: '$lines' },
      { $group: { _id: { a: '$lines.ledgerAccountId', c: '$lines.currency' }, total: { $sum: '$lines.amountMinor' } } },
    ]);
    const stored = await this.ledger.balances.all(ctx);
    const fromLines = new Map(sums.map((s) => [`${s._id.a}:${s._id.c}`, BigInt(s.total)]));
    const mismatches: Mismatch[] = [];
    const keys = new Set([...fromLines.keys(), ...stored.map((b) => `${b.ledgerAccountId}:${b.currency}`)]);
    const storedByKey = new Map(stored.map((b) => [`${b.ledgerAccountId}:${b.currency}`, b.balanceMinor]));
    const perCurrency = new Map<string, bigint>();
    for (const key of keys) {
      const [ledgerAccountId, currency] = key.split(':') as [string, string];
      const a = storedByKey.get(key) ?? 0n;
      const b = fromLines.get(key) ?? 0n;
      perCurrency.set(currency, (perCurrency.get(currency) ?? 0n) + b);
      if (a !== b)
        mismatches.push({
          kind: 'balance',
          ledgerAccountId,
          currency,
          stored: toMinorString(a),
          fromLines: toMinorString(b),
        });
    }
    for (const [currency, total] of perCurrency)
      if (total !== 0n) mismatches.push({ kind: 'unbalanced', currency, total: toMinorString(total) });

    const doc = await this.checks.insertOne(ctx, {
      _id: newId(),
      at: this.now(),
      ok: mismatches.length === 0,
      mismatches,
    });
    if (!doc.ok) {
      this.logger.error(
        JSON.stringify({ event: 'balance_mismatch', workspaceId: ctx.workspaceId, count: mismatches.length }),
      );
      if (this.contactEmail) await this.mailer.balanceMismatch(this.contactEmail, ctx.workspaceId, mismatches.length);
    }
    return doc;
  }
}

export function balanceCheckJob(check: BalanceCheck): JobHandler {
  return {
    name: 'check-balances',
    everySeconds: 86_400,
    async run() {
      await check.runAll();
    },
  };
}

import { Decimal128 } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { convert } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { ExchangeRate } from './currencies.contract.js';
import type { ExchangeRateDoc, ExchangeRatesRepository } from './currencies.repository.js';

/** Converts an amount into the workspace currency on a date, or null with no rate (TECH-SPEC 6.5, 6.7). */
export type Converter = (amount: bigint, from: string, date: string) => bigint | null;

/** "1550.2500" → "1550.25": Decimal128 keeps trailing zeros. */
const tidy = (rate: string) => (rate.includes('.') ? rate.replace(/0+$/, '').replace(/\.$/, '') : rate);

const toView = (d: ExchangeRateDoc): z.input<typeof ExchangeRate> => ({
  id: d._id,
  currency: d.currency,
  date: d.date,
  rate: tidy(d.rate.toString()),
  source: d.source,
  version: d.version,
});

/**
 * The rate for a date is the latest one entered on or before it. With none, the balance is left out and the
 * figure shows "Partial" (TECH-SPEC 6.7). Pure, so the app does the same.
 */
export function converterOf(
  rates: readonly { currency: string; date: string; rate: string }[],
  home: string,
): Converter {
  const byCurrency = new Map<string, { date: string; rate: string }[]>();
  for (const r of rates) {
    const list = byCurrency.get(r.currency) ?? [];
    list.push(r);
    byCurrency.set(r.currency, list);
  }
  for (const list of byCurrency.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return (amount, from, date) => {
    if (from === home) return amount;
    const list = byCurrency.get(from);
    if (!list) return null;
    let best: string | null = null;
    for (const r of list) {
      if (r.date > date) break;
      best = r.rate;
    }
    return best === null ? null : convert(amount, from, home, best);
  };
}

/** Exchange rates typed in by hand (build plan B5.5, TECH-SPEC 6.13 decision 4). */
export class CurrenciesService {
  constructor(
    private readonly database: Database,
    private readonly rates: ExchangeRatesRepository,
    private readonly ledger: LedgerService,
    private readonly audit: AuditRepository,
    private readonly currencyOf: (ctx: WorkspaceContext) => Promise<string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async converterFor(ctx: WorkspaceContext): Promise<Converter> {
    const [docs, home] = await Promise.all([this.rates.find(ctx, {}), this.currencyOf(ctx)]);
    return converterOf(
      docs.map((d) => ({ currency: d.currency, date: d.date, rate: tidy(d.rate.toString()) })),
      home,
    );
  }

  async list(ctx: WorkspaceContext, currency?: string) {
    const home = await this.currencyOf(ctx);
    const docs = await this.rates.find(ctx, currency ? { currency } : {}, { sort: { date: -1, currency: 1 } });
    const all = currency ? await this.rates.find(ctx, {}) : docs;
    const have = new Set(all.map((d) => d.currency));
    const used = await this.ledger.accounts.find(
      ctx,
      { currency: { $ne: home }, systemKey: null, categoryId: null, archivedAt: null },
      { projection: { currency: 1 } },
    );
    const needed = [...new Set(used.map((a) => a.currency))].filter((c) => !have.has(c)).sort();
    return { currency: home, rates: docs.map(toView), needed };
  }

  async set(ctx: WorkspaceContext, body: { currency: string; date: string; rate: string }) {
    const home = await this.currencyOf(ctx);
    if (body.currency === home) {
      throw new AppError(400, 'invalid_input', `${home} is this workspace's own currency. Choose another one.`, {
        field: 'currency',
      });
    }
    const doc = await this.database.transaction(async (session) => {
      const now = this.now();
      const saved = await this.rates.findOneAndUpdate(
        ctx,
        { currency: body.currency, date: body.date },
        {
          $set: { rate: Decimal128.fromString(body.rate), source: 'manual', updatedAt: now },
          $inc: { version: 1 },
          $setOnInsert: { _id: newId(), createdAt: now },
        },
        { session, upsert: true },
      );
      await this.ledger.feed(ctx, [{ collection: 'exchange_rates', docId: saved!._id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        {
          action: 'exchange_rate.set',
          target: { collection: 'exchange_rates', id: saved!._id },
          after: { currency: body.currency, date: body.date, rate: body.rate },
        },
        { session },
      );
      return saved!;
    });
    return toView(doc);
  }

  async remove(ctx: WorkspaceContext, currency: string, date: string): Promise<void> {
    await this.database.transaction(async (session) => {
      const doc = await this.rates.findOne(ctx, { currency, date }, { session });
      if (!doc) throw Errors.notFound();
      await this.rates.deleteOne(ctx, { _id: doc._id }, { session });
      await this.ledger.feed(ctx, [{ collection: 'exchange_rates', docId: doc._id, op: 'tombstone' }], session);
      await this.audit.record(
        ctx,
        { action: 'exchange_rate.deleted', target: { collection: 'exchange_rates', id: doc._id } },
        { session },
      );
    });
  }

  async get(ctx: WorkspaceContext, id: string) {
    const doc = await this.rates.findOne(ctx, { _id: id });
    return doc ? toView(doc) : null;
  }
}

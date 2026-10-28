import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { divRoundHalfAwayFromZero, parseMinor, toMinorString } from '../../common/money/money.js';
import { localDateString } from '../../common/time/workspace-clock.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { Converter } from '../currencies/currencies.service.js';
import {
  formatUnits,
  type Lot as LotState,
  latestPrice,
  parseUnits,
  position,
  type Position,
  type Price,
  UNIT_PLACES,
  valueOf,
} from '../ledger/investments.js';
import type { TransactionDoc } from '../ledger/ledger.repository.js';
import { lotsOf, type LedgerService } from '../ledger/ledger.service.js';
import {
  type CreateHoldingBody,
  HOLDING_ACCOUNT_TYPES,
  type Holding,
  type HoldingDetail,
  type Portfolio,
  type PriceEntry,
  type RANGES,
  type SetPricesBody,
  type Trade,
  type UpdateHoldingBody,
} from './investments.contract.js';
import type { HoldingDoc, HoldingsRepository, PriceDoc, PricesRepository } from './investments.repository.js';

type Range = (typeof RANGES)[number];

export type WorkspaceInfo = { currency: string; timeZone: string };

const InvestmentErrors = {
  notInvestmentAccount: () =>
    new AppError(400, 'wrong_account', 'Choose an investment, pension or fixed deposit account.', {
      field: 'accountId',
    }),
  hasUnits: () =>
    new AppError(409, 'holding_has_units', 'This holding still has units. Sell them first, then remove it.'),
  stale: (current: z.input<typeof Holding>) =>
    new AppError(409, 'already_changed', 'This was already changed on another device.', { current }),
};

/** Everything a valuation needs, loaded once. */
type Book = { holdings: HoldingDoc[]; events: TransactionDoc[]; prices: Price[]; priceDocs: PriceDoc[] };

const toPrice = (p: PriceDoc): Price => ({
  holdingId: p.holdingId,
  date: p.date,
  priceMinor: parseMinor(p.priceMinor),
});

const toPriceEntry = (p: PriceDoc): z.input<typeof PriceEntry> => ({
  holdingId: p.holdingId,
  date: p.date,
  price: p.priceMinor,
  version: p.version,
});

/** Days are UTC calendar days here: dates are already local (TECH-SPEC 6.4). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** The first day a range covers, ending today. */
export function rangeStart(range: Range, today: string, first: string | null): string {
  switch (range) {
    case '1M':
      return addDays(today, -30);
    case '3M':
      return addDays(today, -91);
    case '1Y':
      return addDays(today, -365);
    case 'All':
      return first && first < today ? first : today;
  }
}

/** Points for a value line: weekly for 1M and 3M, month ends for longer ranges, always ending today. */
export function seriesDates(range: Range, today: string, first: string | null): string[] {
  const start = rangeStart(range, today, first);
  const out: string[] = [];
  if (range === '1M' || range === '3M') {
    for (let d = today; d >= start; d = addDays(d, -7)) out.unshift(d);
    return out;
  }
  let month = today.slice(0, 7);
  out.unshift(today);
  for (let i = 0; i < 120; i++) {
    month = addMonths(month, -1);
    const end = monthEnd(month);
    if (end < start.slice(0, 7) + '-01') break;
    out.unshift(end);
  }
  return out;
}

const investmentIncome = (e: TransactionDoc) =>
  e.investment && (e.investment.kind === 'dividend' || e.investment.kind === 'reinvest')
    ? -(e.lines.find((l) => l.amountMinor < 0n)?.amountMinor ?? 0n)
    : 0n;

/** A sale's proceeds after fees and its realised gain. */
function saleOf(e: TransactionDoc): { proceeds: bigint; gain: bigint } | null {
  if (e.investment?.kind !== 'sell') return null;
  const proceeds = e.lines.find((l) => l.amountMinor > 0n && l.ledgerAccountId !== e.links.holdingId)?.amountMinor;
  const cost = e.investment.lots.reduce((s, l) => s + BigInt(l.cost), 0n);
  return { proceeds: proceeds ?? 0n, gain: (proceeds ?? 0n) - cost };
}

/** Holdings, lots, prices and dividends (TECH-SPEC 6.8, build plan B5.1). */
export class InvestmentsService {
  constructor(
    private readonly database: Database,
    private readonly holdings: HoldingsRepository,
    private readonly prices: PricesRepository,
    private readonly ledger: LedgerService,
    private readonly audit: AuditRepository,
    private readonly workspaceOf: (ctx: WorkspaceContext) => Promise<WorkspaceInfo>,
    private readonly now: () => Date = () => new Date(),
    /** Set once exchange rates exist; until then other currencies are left out ("Partial"). */
    public converterFor: (ctx: WorkspaceContext) => Promise<Converter> = async () => () => null,
  ) {}

  private async book(ctx: WorkspaceContext, holdingId?: string): Promise<Book> {
    const holdings = await this.holdings.find(ctx, holdingId ? { _id: holdingId } : {}, { sort: { createdAt: 1 } });
    const events = await this.ledger.transactions.find(
      ctx,
      { investment: { $ne: null }, ...(holdingId ? { 'links.holdingId': holdingId } : {}) },
      { sort: { date: 1, _id: 1 } },
    );
    const priceDocs = await this.prices.find(ctx, holdingId ? { holdingId } : {}, { sort: { date: 1 } });
    return { holdings, events, prices: priceDocs.map(toPrice), priceDocs };
  }

  private async today(ctx: WorkspaceContext): Promise<{ today: string } & WorkspaceInfo> {
    const ws = await this.workspaceOf(ctx);
    return { ...ws, today: localDateString(this.now(), ws.timeZone) };
  }

  /** Each holding's position on a date, from the events up to that date. */
  private positionsOn(book: Book, date: string): Map<string, { lots: LotState[]; position: Position }> {
    const lots = lotsOf(book.events.filter((e) => e.date <= date));
    const out = new Map<string, { lots: LotState[]; position: Position }>();
    for (const h of book.holdings) {
      const held = lots.get(h._id) ?? [];
      out.set(h._id, { lots: held, position: position(held, book.prices, h._id, date) });
    }
    return out;
  }

  /**
   * Market value and cost of every holding on a date, for net worth and reports (TECH-SPEC 6.7): net worth
   * counts holdings at market value, so it includes unrealised gains.
   */
  async valuation(ctx: WorkspaceContext, date?: string) {
    const { today } = await this.today(ctx);
    const book = await this.book(ctx);
    const on = date ?? today;
    const positions = this.positionsOn(book, on);
    return book.holdings.map((h) => ({ holding: h, position: positions.get(h._id)!.position }));
  }

  private holdingView(h: HoldingDoc, p: Position): z.input<typeof Holding> {
    return {
      id: h._id,
      name: h.name,
      symbol: h.symbol,
      type: h.type,
      accountId: h.accountId,
      currency: h.currency,
      archived: h.archivedAt !== null,
      units: formatUnits(p.units),
      cost: toMinorString(p.cost),
      averageCost:
        p.units > 0n ? toMinorString(divRoundHalfAwayFromZero(p.cost * 10n ** BigInt(UNIT_PLACES), p.units)) : null,
      price: p.price ? toMinorString(p.price.priceMinor) : null,
      priceDate: p.price?.date ?? null,
      value: toMinorString(p.value),
      unrealised: toMinorString(p.unrealised),
      realised: toMinorString(p.realised),
      version: h.version,
    };
  }

  private async view(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Holding>> {
    const book = await this.book(ctx, id);
    const h = book.holdings[0];
    if (!h) throw Errors.notFound();
    const { today } = await this.today(ctx);
    return this.holdingView(h, this.positionsOn(book, today).get(id)!.position);
  }

  async portfolio(ctx: WorkspaceContext, range: Range, archived = false): Promise<z.input<typeof Portfolio>> {
    const { today, currency } = await this.today(ctx);
    const book = await this.book(ctx);
    const convert = await this.converterFor(ctx);
    const partial = new Set<string>();
    const toHome = (amount: bigint, from: string, date: string) => {
      if (from === currency) return amount;
      const v = convert(amount, from, date);
      if (v === null) partial.add(from);
      return v ?? 0n;
    };
    const now = this.positionsOn(book, today);
    const shown = book.holdings.filter((h) => archived || h.archivedAt === null);
    let value = 0n;
    let cost = 0n;
    const byType = new Map<string, bigint>();
    const byAccount = new Map<string, bigint>();
    for (const h of shown) {
      const p = now.get(h._id)!.position;
      const v = toHome(p.value, h.currency, today);
      value += v;
      cost += toHome(p.cost, h.currency, today);
      byType.set(h.type, (byType.get(h.type) ?? 0n) + v);
      byAccount.set(h.accountId, (byAccount.get(h.accountId) ?? 0n) + v);
    }
    const first = book.events[0]?.date ?? null;
    const start = rangeStart(range, today, first);
    const currencyOf = new Map(book.holdings.map((h) => [h._id, h.currency]));
    let realised = 0n;
    let dividends = 0n;
    for (const e of book.events) {
      if (e.status !== 'posted' || e.date < start || e.date > today) continue;
      const from = currencyOf.get(e.links.holdingId ?? '') ?? currency;
      const sale = saleOf(e);
      if (sale) realised += toHome(sale.gain, from, e.date);
      dividends += toHome(investmentIncome(e), from, e.date);
    }
    const series = seriesDates(range, today, first).map((date) => {
      const at = this.positionsOn(book, date);
      let v = 0n;
      let c = 0n;
      for (const h of shown) {
        const p = at.get(h._id)!.position;
        v += toHome(p.value, h.currency, date);
        c += toHome(p.cost, h.currency, date);
      }
      return { date, value: toMinorString(v), cost: toMinorString(c) };
    });
    const byValue = (a: [string, bigint], b: [string, bigint]) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0);
    return {
      asOf: today,
      currency,
      value: toMinorString(value),
      cost: toMinorString(cost),
      unrealised: toMinorString(value - cost),
      realised: toMinorString(realised),
      dividends: toMinorString(dividends),
      partial: [...partial].sort(),
      holdings: shown.map((h) => this.holdingView(h, now.get(h._id)!.position)),
      byType: [...byType]
        .sort(byValue)
        .map(([type, v]) => ({ type: type as HoldingDoc['type'], value: toMinorString(v) })),
      byAccount: [...byAccount].sort(byValue).map(([accountId, v]) => ({ accountId, value: toMinorString(v) })),
      series,
    };
  }

  async get(ctx: WorkspaceContext, id: string, range: Range = '1Y'): Promise<z.input<typeof HoldingDetail>> {
    const book = await this.book(ctx, id);
    const h = book.holdings[0];
    if (!h) throw Errors.notFound();
    const { today } = await this.today(ctx);
    const { lots, position: p } = this.positionsOn(book, today).get(id)!;
    const price = latestPrice(book.prices, id, today);
    const lotViews = lots.map((l) => {
      const value = price ? valueOf(l.units, price.priceMinor) : l.cost;
      return {
        lotId: l.lotId,
        date: l.date,
        units: formatUnits(l.boughtUnits),
        unitsHeld: formatUnits(l.units),
        costPerUnit: toMinorString(
          divRoundHalfAwayFromZero(l.boughtCost * 10n ** BigInt(UNIT_PLACES), l.boughtUnits || 1n),
        ),
        cost: toMinorString(l.cost),
        value: toMinorString(value),
        gain: toMinorString(value - l.cost),
        realised: toMinorString(l.realised),
        sold: l.units === 0n,
      };
    });
    const live = book.events.filter((e) => e.status === 'posted');
    const trades = live.flatMap((e): z.input<typeof Trade>[] => {
      const m = e.investment!;
      if (m.kind === 'buy') {
        const amount = e.lines.find((l) => l.ledgerAccountId === id)?.amountMinor ?? 0n;
        return [
          {
            transactionId: e._id,
            date: e.date,
            kind: 'buy' as const,
            units: m.units,
            price: m.price,
            fees: m.fees,
            amount: toMinorString(amount),
            gain: null,
          },
        ];
      }
      if (m.kind === 'sell') {
        const sale = saleOf(e)!;
        return [
          {
            transactionId: e._id,
            date: e.date,
            kind: 'sell' as const,
            units: m.units,
            price: m.price,
            fees: m.fees,
            amount: toMinorString(sale.proceeds),
            gain: toMinorString(sale.gain),
          },
        ];
      }
      return [];
    });
    const dividends = live
      .filter((e) => e.investment?.kind === 'dividend' || e.investment?.kind === 'reinvest')
      .map((e) => ({
        transactionId: e._id,
        date: e.date,
        amount: toMinorString(investmentIncome(e)),
        accountId:
          e.investment!.kind === 'dividend' ? (e.lines.find((l) => l.amountMinor > 0n)?.ledgerAccountId ?? null) : null,
        reinvested: e.investment!.kind === 'reinvest',
      }));
    const year = today.slice(0, 4);
    const dividendsThisYear = dividends
      .filter((d) => d.date.startsWith(year))
      .reduce((s, d) => s + parseMinor(d.amount), 0n);
    const first = book.events[0]?.date ?? null;
    const series = seriesDates(range, today, first).map((date) => {
      const at = this.positionsOn(book, date).get(id)!.position;
      return { date, value: toMinorString(at.value), cost: toMinorString(at.cost) };
    });
    return {
      holding: this.holdingView(h, p),
      lots: lotViews,
      trades: trades.reverse(),
      dividends: dividends.reverse(),
      dividendsThisYear: toMinorString(dividendsThisYear),
      prices: [...book.priceDocs].reverse().map(toPriceEntry),
      series,
    };
  }

  async create(
    ctx: WorkspaceContext,
    body: z.output<typeof CreateHoldingBody>,
    operationId: string,
  ): Promise<z.input<typeof Holding>> {
    if (body.id && (await this.holdings.findOne(ctx, { _id: body.id }))) return this.view(ctx, body.id);
    const dup = await this.holdings.findOne(ctx, { operationId });
    if (dup) return this.view(ctx, dup._id);
    const { today } = await this.today(ctx);
    const id = await this.database.transaction(async (session) => {
      const [account] = await this.ledger.accounts.byIds(ctx, [body.accountId], { session });
      if (
        !account ||
        account.kind !== 'asset' ||
        account.archivedAt !== null ||
        !(HOLDING_ACCOUNT_TYPES as readonly string[]).includes(account.accountType ?? '')
      ) {
        throw InvestmentErrors.notInvestmentAccount();
      }
      const now = this.now();
      const currency = account.currency;
      const ledgerAccount = await this.ledger.openAccount(
        ctx,
        {
          id: body.id ?? newId(),
          kind: 'asset',
          accountType: null,
          name: body.name,
          currency,
          onBudget: false,
          holdingOf: account._id,
        },
        session,
      );
      const holding = await this.holdings.insertOne(
        ctx,
        {
          _id: ledgerAccount._id,
          name: body.name,
          symbol: body.symbol ?? null,
          type: body.type,
          accountId: account._id,
          currency,
          archivedAt: null,
          operationId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      const changed = [{ collection: 'holdings', docId: holding._id, op: 'upsert' as const }];
      if (body.price) {
        const price = await this.upsertPrice(ctx, holding._id, body.priceDate ?? today, body.price, session);
        changed.push({ collection: 'prices', docId: price._id, op: 'upsert' });
      }
      await this.ledger.feed(ctx, changed, session);
      await this.audit.record(
        ctx,
        { action: 'holding.created', target: { collection: 'holdings', id: holding._id } },
        { session },
      );
      return holding._id;
    });
    return this.view(ctx, id);
  }

  async update(
    ctx: WorkspaceContext,
    id: string,
    body: z.output<typeof UpdateHoldingBody>,
  ): Promise<z.input<typeof Holding>> {
    await this.database.transaction(async (session) => {
      const before = await this.holdings.findOne(ctx, { _id: id }, { session });
      if (!before) throw Errors.notFound();
      const set: Partial<HoldingDoc> = { updatedAt: this.now() };
      if (body.name !== undefined) set.name = body.name;
      if (body.symbol !== undefined) set.symbol = body.symbol;
      if (body.type !== undefined) set.type = body.type;
      const after = await this.holdings.findOneAndUpdate(
        ctx,
        { _id: id, version: body.baseVersion },
        { $set: set, $inc: { version: 1 } },
        { session },
      );
      if (!after) throw InvestmentErrors.stale(await this.view(ctx, id));
      if (body.name !== undefined) {
        await this.ledger.accounts.updateOne(
          ctx,
          { _id: id },
          { $set: { name: body.name, updatedAt: this.now() }, $inc: { version: 1 } },
          { session },
        );
      }
      await this.ledger.feed(ctx, [{ collection: 'holdings', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: 'holding.updated', target: { collection: 'holdings', id }, after: set },
        { session },
      );
    });
    return this.view(ctx, id);
  }

  /** Removes a holding with no units; its history stays and it no longer shows. */
  async archive(ctx: WorkspaceContext, id: string): Promise<z.input<typeof Holding>> {
    const current = await this.view(ctx, id);
    if (parseUnits(current.units) > 0n) throw InvestmentErrors.hasUnits();
    if (current.archived) return current;
    await this.database.transaction(async (session) => {
      const now = this.now();
      await this.holdings.updateOne(
        ctx,
        { _id: id },
        { $set: { archivedAt: now, updatedAt: now }, $inc: { version: 1 } },
        { session },
      );
      await this.ledger.accounts.updateOne(
        ctx,
        { _id: id },
        { $set: { archivedAt: now, updatedAt: now }, $inc: { version: 1 } },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'holdings', docId: id, op: 'upsert' }], session);
      await this.audit.record(ctx, { action: 'holding.archived', target: { collection: 'holdings', id } }, { session });
    });
    return this.view(ctx, id);
  }

  private async upsertPrice(
    ctx: WorkspaceContext,
    holdingId: string,
    date: string,
    price: string,
    session: ClientSession,
  ): Promise<PriceDoc> {
    const now = this.now();
    const doc = await this.prices.findOneAndUpdate(
      ctx,
      { holdingId, date },
      {
        $set: { priceMinor: price, updatedAt: now },
        $inc: { version: 1 },
        $setOnInsert: { _id: newId(), createdAt: now },
      },
      { session, upsert: true },
    );
    return doc!;
  }

  /** "Update prices": one price per holding for the date; entering one again replaces it (P17-04). */
  async setPrices(ctx: WorkspaceContext, body: z.output<typeof SetPricesBody>) {
    const ids = [...new Set(body.prices.map((p) => p.holdingId))];
    const docs = await this.database.transaction(async (session) => {
      const found = await this.holdings.find(ctx, { _id: { $in: ids } }, { session });
      if (found.length !== ids.length) throw Errors.notFound();
      const out: PriceDoc[] = [];
      for (const p of body.prices) out.push(await this.upsertPrice(ctx, p.holdingId, body.date, p.price, session));
      await this.ledger.feed(
        ctx,
        out.map((d) => ({ collection: 'prices', docId: d._id, op: 'upsert' as const })),
        session,
      );
      await this.audit.record(
        ctx,
        { action: 'prices.updated', after: { date: body.date, holdings: ids.length } },
        { session },
      );
      return out;
    });
    return { prices: docs.map(toPriceEntry) };
  }

  async deletePrice(ctx: WorkspaceContext, holdingId: string, date: string): Promise<void> {
    await this.database.transaction(async (session) => {
      const doc = await this.prices.findOne(ctx, { holdingId, date }, { session });
      if (!doc) throw Errors.notFound();
      await this.prices.deleteOne(ctx, { _id: doc._id }, { session });
      await this.ledger.feed(ctx, [{ collection: 'prices', docId: doc._id, op: 'tombstone' }], session);
    });
  }

  /** The change feed's copy of a holding or a price. */
  async getHolding(ctx: WorkspaceContext, id: string) {
    return this.view(ctx, id);
  }

  async getPrice(ctx: WorkspaceContext, id: string) {
    const doc = await this.prices.findOne(ctx, { _id: id });
    return doc ? toPriceEntry(doc) : null;
  }
}

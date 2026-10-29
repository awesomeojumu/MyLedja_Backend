import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../common/errors/errors.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import { costOfPurchase, proceedsOfSale } from '../ledger/builders.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { HoldingDoc, HoldingType, InvestmentsRepository } from './investments.repository.js';

export class InvestmentsService {
  constructor(
    private readonly repo: InvestmentsRepository,
    private readonly ledger: LedgerService,
  ) {}

  async listHoldings(ctx: WorkspaceContext) {
    const rows = await this.repo.holdings.find({ workspaceId: ctx.workspaceId }).toArray();
    const lots = await this.repo.lots.find({ workspaceId: ctx.workspaceId }).toArray();
    const prices = await this.repo.prices.find({ workspaceId: ctx.workspaceId }).toArray();
    return {
      holdings: rows.map((h) => {
        const openLots = lots.filter((l) => l.holdingId === h._id);
        const units = openLots.reduce((s, l) => s + Number(l.units) - Number(l.soldUnits || '0'), 0);
        const cost = openLots.reduce((s, l) => {
          const open = Number(l.units) - Number(l.soldUnits || '0');
          const total = Number(l.units);
          if (total <= 0) return s;
          return s + (BigInt(l.costMinor) * BigInt(Math.round(open * 1e6))) / BigInt(Math.round(total * 1e6));
        }, 0n);
        const priceRow = prices
          .filter((p) => p.holdingId === h._id)
          .sort((a, b) => b.date.localeCompare(a.date))[0];
        const price = priceRow ? BigInt(priceRow.priceMinor) : null;
        const value = price !== null ? costOfPurchase(String(units), price.toString(), '0') : cost;
        return {
          id: h._id,
          name: h.name,
          symbol: h.symbol,
          type: h.type,
          accountId: h.accountId,
          currency: h.currency,
          ledgerAccountId: h.ledgerAccountId,
          units: String(units),
          cost: cost.toString(),
          price: price?.toString() ?? null,
          value: value.toString(),
          version: h.version,
        };
      }),
    };
  }

  async createHolding(
    ctx: WorkspaceContext,
    body: {
      id?: string;
      name: string;
      symbol?: string;
      type: HoldingType;
      accountId: string;
      currency?: string;
      currentPrice?: string;
    },
  ) {
    const account = await this.ledger.accounts.findOne(ctx, { _id: body.accountId });
    if (!account || account.accountType !== 'investment') {
      throw new AppError(400, 'wrong_account_kind', 'Choose an investment account');
    }
    const ledgerAccount = await this.ledger.openAccount(ctx, {
      kind: 'asset',
      accountType: 'investment',
      name: body.name,
      currency: body.currency ?? account.currency,
    });
    const now = new Date();
    const id = body.id ?? uuidv7();
    const doc: HoldingDoc = {
      _id: id,
      workspaceId: ctx.workspaceId,
      name: body.name,
      symbol: body.symbol?.toUpperCase() ?? null,
      type: body.type,
      accountId: body.accountId,
      currency: body.currency ?? account.currency,
      ledgerAccountId: ledgerAccount._id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.holdings.insertOne(doc);
    if (body.currentPrice) {
      await this.repo.prices.insertOne({
        _id: uuidv7(),
        workspaceId: ctx.workspaceId,
        holdingId: id,
        date: now.toISOString().slice(0, 10),
        priceMinor: body.currentPrice,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    return (await this.listHoldings(ctx)).holdings.find((h) => h.id === id)!;
  }

  async listLots(ctx: WorkspaceContext, holdingId: string) {
    const lots = await this.repo.lots
      .find({ workspaceId: ctx.workspaceId, holdingId })
      .sort({ date: 1, _id: 1 })
      .toArray();
    return {
      lots: lots.map((l) => ({
        id: l._id,
        holdingId: l.holdingId,
        date: l.date,
        units: l.units,
        soldUnits: l.soldUnits,
        cost: l.costMinor,
        pricePerUnit: l.pricePerUnitMinor,
        fees: l.feesMinor,
      })),
    };
  }

  async buy(
    ctx: WorkspaceContext,
    body: {
      holdingId: string;
      units: string;
      pricePerUnit: string;
      fees?: string;
      cashAccountId: string;
      date: string;
      operationId?: string;
    },
  ) {
    const holding = await this.repo.holdings.findOne({ _id: body.holdingId, workspaceId: ctx.workspaceId });
    if (!holding) throw new AppError(404, 'not_found', 'Holding not found');
    const fees = body.fees ?? '0';
    const { event } = await this.ledger.post(
      ctx,
      {
        type: 'investment_buy',
        holdingAccountId: holding.ledgerAccountId,
        cashAccountId: body.cashAccountId,
        units: body.units,
        pricePerUnit: body.pricePerUnit,
        fees,
        date: body.date,
        holdingId: holding._id,
      },
      { operationId: body.operationId ?? uuidv7(), deviceId: 'server' },
    );
    const cost = costOfPurchase(body.units, body.pricePerUnit, fees);
    const lotId = uuidv7();
    const now = new Date();
    await this.repo.lots.insertOne({
      _id: lotId,
      workspaceId: ctx.workspaceId,
      holdingId: holding._id,
      date: body.date,
      units: body.units,
      soldUnits: '0',
      costMinor: cost.toString(),
      pricePerUnitMinor: body.pricePerUnit,
      feesMinor: fees,
      buyEventId: event._id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { transactionId: event._id, lotId };
  }

  async sell(
    ctx: WorkspaceContext,
    body: {
      holdingId: string;
      units: string;
      pricePerUnit: string;
      fees?: string;
      cashAccountId: string;
      date: string;
      lotIds?: string[];
      operationId?: string;
    },
  ) {
    const holding = await this.repo.holdings.findOne({ _id: body.holdingId, workspaceId: ctx.workspaceId });
    if (!holding) throw new AppError(404, 'not_found', 'Holding not found');
    const lots = await this.repo.lots
      .find({ workspaceId: ctx.workspaceId, holdingId: holding._id })
      .sort({ date: 1, _id: 1 })
      .toArray();
    const want = Number(body.units);
    let left = want;
    let cost = 0n;
    const consumes: { id: string; soldUnits: string; take: number }[] = [];
    for (const lot of lots) {
      if (body.lotIds && !body.lotIds.includes(lot._id)) continue;
      const available = Number(lot.units) - Number(lot.soldUnits || '0');
      if (available <= 0) continue;
      const take = Math.min(available, left);
      const portion =
        Number(lot.units) > 0
          ? (BigInt(lot.costMinor) * BigInt(Math.round(take * 1e6))) / BigInt(Math.round(Number(lot.units) * 1e6))
          : 0n;
      cost += portion;
      consumes.push({ id: lot._id, soldUnits: String(Number(lot.soldUnits || '0') + take), take });
      left -= take;
      if (left <= 1e-9) break;
    }
    if (left > 1e-9) throw new AppError(400, 'not_enough_units', `You hold ${want - left} units`);
    const fees = body.fees ?? '0';
    const proceeds = proceedsOfSale(body.units, body.pricePerUnit, fees);
    const { event } = await this.ledger.post(
      ctx,
      {
        type: 'investment_sell',
        holdingAccountId: holding.ledgerAccountId,
        cashAccountId: body.cashAccountId,
        units: body.units,
        pricePerUnit: body.pricePerUnit,
        fees,
        costOfLots: cost.toString(),
        date: body.date,
        holdingId: holding._id,
      },
      { operationId: body.operationId ?? uuidv7(), deviceId: 'server' },
    );
    for (const c of consumes) {
      await this.repo.lots.updateOne({ _id: c.id }, { $set: { soldUnits: c.soldUnits, updatedAt: new Date() } });
    }
    return { transactionId: event._id, gain: (proceeds - cost).toString() };
  }

  async dividend(
    ctx: WorkspaceContext,
    body: {
      holdingId: string;
      amount: string;
      date: string;
      cashAccountId: string;
      reinvested?: boolean;
      units?: string;
      pricePerUnit?: string;
      operationId?: string;
    },
  ) {
    const holding = await this.repo.holdings.findOne({ _id: body.holdingId, workspaceId: ctx.workspaceId });
    if (!holding) throw new AppError(404, 'not_found', 'Holding not found');
    const incomeAcc = await this.ledger.accounts.findOne(ctx, { systemKey: 'investment_income' });
    if (!incomeAcc?.categoryId) {
      throw new AppError(500, 'missing_system', 'Investment income category is not set up');
    }
    const { event } = await this.ledger.post(
      ctx,
      {
        type: 'income',
        accountId: body.cashAccountId,
        categoryId: incomeAcc.categoryId,
        amount: body.amount,
        date: body.date,
        notes: `Dividend · ${holding.name}`,
      },
      { operationId: body.operationId ?? uuidv7(), deviceId: 'server' },
    );
    if (body.reinvested) {
      if (!body.units || !body.pricePerUnit) {
        throw new AppError(400, 'reinvest_units', 'Reinvested dividends need units and a price');
      }
      await this.buy(ctx, {
        holdingId: holding._id,
        units: body.units,
        pricePerUnit: body.pricePerUnit,
        fees: '0',
        cashAccountId: body.cashAccountId,
        date: body.date,
      });
    }
    return { transactionId: event._id };
  }

  async savePrices(ctx: WorkspaceContext, body: { date: string; prices: { holdingId: string; price: string }[] }) {
    const now = new Date();
    let saved = 0;
    for (const row of body.prices) {
      if (!row.price || row.price === '0') continue;
      await this.repo.prices.insertOne({
        _id: uuidv7(),
        workspaceId: ctx.workspaceId,
        holdingId: row.holdingId,
        date: body.date,
        priceMinor: row.price,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      saved += 1;
    }
    return { saved };
  }

  async listPrices(ctx: WorkspaceContext, holdingId: string) {
    const prices = await this.repo.prices
      .find({ workspaceId: ctx.workspaceId, holdingId })
      .sort({ date: -1 })
      .toArray();
    return {
      prices: prices.map((p) => ({ id: p._id, holdingId: p.holdingId, date: p.date, price: p.priceMinor })),
    };
  }

  async listRates(ctx: WorkspaceContext) {
    const rates = await this.repo.rates.find({ workspaceId: ctx.workspaceId }).sort({ date: -1 }).toArray();
    return {
      rates: rates.map((r) => ({
        id: r._id,
        currency: r.currency,
        date: r.date,
        rate: r.rate,
        source: r.source,
      })),
    };
  }

  async saveRate(ctx: WorkspaceContext, body: { currency: string; date: string; rate: string; source?: 'manual' | 'download' }) {
    const now = new Date();
    const id = uuidv7();
    await this.repo.rates.updateOne(
      { workspaceId: ctx.workspaceId, currency: body.currency.toUpperCase(), date: body.date },
      {
        $set: {
          rate: body.rate,
          source: body.source ?? 'manual',
          updatedAt: now,
        },
        $setOnInsert: {
          _id: id,
          workspaceId: ctx.workspaceId,
          currency: body.currency.toUpperCase(),
          date: body.date,
          version: 1,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    const doc = await this.repo.rates.findOne({
      workspaceId: ctx.workspaceId,
      currency: body.currency.toUpperCase(),
      date: body.date,
    });
    return {
      id: doc!._id,
      currency: doc!.currency,
      date: doc!.date,
      rate: doc!.rate,
      source: doc!.source,
    };
  }
}

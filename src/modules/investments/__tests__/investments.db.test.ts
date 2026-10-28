import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

async function world() {
  const w = await newWorkspace(t);
  const s = t.services;
  const bank = await s.accounts.create(
    w.ctx,
    { type: 'bank', name: 'GTBank', openingBalance: '81230000', openingDate: '2026-10-01' } as never,
    uuidv7(),
  );
  const broker = await s.accounts.create(
    w.ctx,
    { type: 'investment', name: 'Stanbic Shares', openingBalance: '0', openingDate: '2026-10-01' } as never,
    uuidv7(),
  );
  const mtn = await s.investments.create(
    w.ctx,
    { name: 'MTN Nigeria', symbol: 'MTNN', type: 'stock', accountId: broker.id },
    uuidv7(),
  );
  return { ...w, s, bank, broker, mtn };
}

describe('investments (B5.1, cases 15 to 17)', () => {
  it('buy, price, sell: cost, unrealised and realised gain, never spending', async () => {
    const { ctx, s, bank, broker, mtn } = await world();
    const buy = await s.transactions.create(
      ctx,
      {
        type: 'investment_buy',
        holdingId: mtn.id,
        accountId: bank.id,
        units: '500',
        price: '21000',
        fees: '50000',
        date: '2026-10-10',
      },
      uuidv7(),
    );
    expect(buy.amount).toBe('-10550000');
    expect(buy.accountIds).toEqual([bank.id]);
    expect(buy.links.holdingId).toBe(mtn.id);
    expect(buy.investment).toMatchObject({ kind: 'buy', units: '500', price: '21000', fees: '50000' });

    await s.investments.setPrices(ctx, { date: '2026-10-20', prices: [{ holdingId: mtn.id, price: '23600' }] });
    let p = await s.investments.portfolio(ctx, 'All');
    expect(p).toMatchObject({ value: '11800000', cost: '10550000', unrealised: '1250000', realised: '0' });
    expect(p.holdings[0]).toMatchObject({ units: '500', averageCost: '21100', price: '23600' });

    // Net worth counts the holding at market value (case 16): 812,300 + 12,500.
    const accounts = await s.accounts.list(ctx);
    expect(accounts.netWorth.amount).toBe('82480000');
    expect(accounts.accounts.find((a) => a.id === broker.id)!.holdingsValue).toBe('11800000');

    const sell = await s.transactions.create(
      ctx,
      {
        type: 'investment_sell',
        holdingId: mtn.id,
        accountId: bank.id,
        units: '200',
        price: '24000',
        fees: '0',
        date: '2026-10-25',
      },
      uuidv7(),
    );
    expect(sell.amount).toBe('4800000');
    p = await s.investments.portfolio(ctx, 'All');
    expect(p.realised).toBe('580000');

    const detail = await s.investments.get(ctx, mtn.id, 'All');
    expect(detail.lots).toEqual([
      expect.objectContaining({ units: '500', unitsHeld: '300', cost: '6330000', realised: '580000', sold: false }),
    ]);
    expect(detail.trades.map((x) => [x.kind, x.amount, x.gain])).toEqual([
      ['sell', '4800000', '580000'],
      ['buy', '10550000', null],
    ]);

    const dash = await s.budget.dashboard(ctx, '2026-10');
    expect(dash.tiles.spent.amount).toBe('0');
  });

  it('refuses selling more than held, and removing a holding with units', async () => {
    const { ctx, s, bank, mtn } = await world();
    await expect(
      s.transactions.create(
        ctx,
        {
          type: 'investment_sell',
          holdingId: mtn.id,
          accountId: bank.id,
          units: '1',
          price: '100',
          fees: '0',
          date: '2026-10-25',
        },
        uuidv7(),
      ),
    ).rejects.toMatchObject({ code: 'not_enough_units' });
    await s.transactions.create(
      ctx,
      {
        type: 'investment_buy',
        holdingId: mtn.id,
        accountId: bank.id,
        units: '1',
        price: '100',
        fees: '0',
        date: '2026-10-10',
      },
      uuidv7(),
    );
    await expect(s.investments.archive(ctx, mtn.id)).rejects.toMatchObject({ code: 'holding_has_units' });
  });

  it('a buy whose units were sold can only be deleted after the sale', async () => {
    const { ctx, s, bank, mtn } = await world();
    const buy = await s.transactions.create(
      ctx,
      {
        type: 'investment_buy',
        holdingId: mtn.id,
        accountId: bank.id,
        units: '10',
        price: '100',
        fees: '0',
        date: '2026-10-10',
      },
      uuidv7(),
    );
    const sell = await s.transactions.create(
      ctx,
      {
        type: 'investment_sell',
        holdingId: mtn.id,
        accountId: bank.id,
        units: '5',
        price: '100',
        fees: '0',
        date: '2026-10-11',
      },
      uuidv7(),
    );
    await expect(s.ledger.reverse(ctx, buy.id, { operationId: uuidv7() })).rejects.toMatchObject({ code: 'lot_sold' });
    await s.ledger.reverse(ctx, sell.id, { operationId: uuidv7() });
    await s.ledger.reverse(ctx, buy.id, { operationId: uuidv7() });
    const p = await s.investments.portfolio(ctx, 'All');
    expect(p.holdings[0]).toMatchObject({ units: '0', cost: '0' });
  });

  it('dividends paid out or reinvested are Investment income', async () => {
    const { ctx, s, bank, mtn } = await world();
    await s.transactions.create(
      ctx,
      { type: 'dividend', holdingId: mtn.id, amount: '1200000', accountId: bank.id, date: '2026-10-12' },
      uuidv7(),
    );
    const reinvested = await s.transactions.create(
      ctx,
      { type: 'dividend', holdingId: mtn.id, amount: '500000', reinvestedUnits: '20', date: '2026-10-13' },
      uuidv7(),
    );
    expect(reinvested.amount).toBe('500000');
    const detail = await s.investments.get(ctx, mtn.id, 'All');
    expect(detail.dividends.map((d) => [d.amount, d.reinvested])).toEqual([
      ['500000', true],
      ['1200000', false],
    ]);
    expect(detail.holding.units).toBe('20');
    const p = await s.investments.portfolio(ctx, 'All');
    expect(p.dividends).toBe('1700000');
  });

  it('a holding needs an investment account', async () => {
    const { ctx, s, bank } = await world();
    await expect(
      s.investments.create(ctx, { name: 'X', type: 'stock', accountId: bank.id }, uuidv7()),
    ).rejects.toMatchObject({ code: 'wrong_account' });
  });
});

describe('exchange rates (B5.5, case 25)', () => {
  it('net worth converts other currencies, and is Partial without a rate', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'Dollar', currency: 'USD', openingBalance: '12000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    let list = await s.accounts.list(w.ctx);
    expect(list.netWorth).toMatchObject({ amount: '0', partial: ['USD'] });
    expect((await s.currencies.list(w.ctx)).needed).toEqual(['USD']);
    await s.currencies.set(w.ctx, { currency: 'USD', date: '2026-10-01', rate: '1550' });
    list = await s.accounts.list(w.ctx);
    expect(list.netWorth).toMatchObject({ amount: '18600000', partial: [] });
    expect((await s.currencies.list(w.ctx)).rates[0]).toMatchObject({ currency: 'USD', rate: '1550' });
  });
});

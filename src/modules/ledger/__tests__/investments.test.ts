import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../../common/errors/errors.js';
import { buildEvent, type Resolver } from '../builders.js';
import { checkLines } from '../checks.js';
import { EventInput } from '../ledger.inputs.js';
import {
  formatUnits,
  latestPrice,
  lotsFrom,
  type OpenLot,
  parseUnits,
  pickLots,
  position,
  UnitsError,
  valueOf,
} from '../investments.js';
import { type AccountRef, SYSTEM_ACCOUNTS, SYSTEM_KEYS } from '../ledger.types.js';

const ref = (kind: AccountRef['kind'], extra: Partial<AccountRef> = {}): AccountRef => ({
  id: uuidv7(),
  kind,
  currency: 'NGN',
  systemKey: null,
  categoryId: null,
  archived: false,
  ...extra,
});

const bank = ref('asset');
const mtn = ref('asset', { holding: true });
const system = new Map(SYSTEM_KEYS.map((k) => [k, ref(SYSTEM_ACCOUNTS[k].kind, { systemKey: k })]));
const byId = new Map([bank, mtn, ...system.values()].map((a) => [a.id, a]));

const lot = (lotId: string, date: string, units: string, cost: bigint): OpenLot => ({
  lotId,
  date,
  units: parseUnits(units),
  cost,
});

function resolver(open: OpenLot[] = []): Resolver {
  return {
    account: (id) => (id === bank.id ? bank : null),
    category: () => null,
    system: (k) => system.get(k)!,
    original: () => null,
    holding: (id) => (id === mtn.id ? mtn : null),
    lots: () => open,
  };
}

const build = (raw: Record<string, unknown>, open: OpenLot[] = []) => {
  const input = EventInput.parse({ date: '2026-10-10', ...raw });
  const built = buildEvent(input, resolver(open));
  checkLines(built.type, built.lines, (id) => byId.get(id) ?? null);
  return built;
};

describe('units (TECH-SPEC 6.8)', () => {
  it('reads and writes up to 6 decimal places without floats', () => {
    expect(parseUnits('500')).toBe(500_000_000n);
    expect(parseUnits('12.5')).toBe(12_500_000n);
    expect(parseUnits('0.000001')).toBe(1n);
    expect(formatUnits(12_500_000n)).toBe('12.5');
    expect(formatUnits(500_000_000n)).toBe('500');
    expect(() => parseUnits('1.2345678')).toThrow(UnitsError);
    expect(() => parseUnits('1e3')).toThrow(UnitsError);
  });

  it('round-trips any units', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), (n) => parseUnits(formatUnits(n)) === n));
  });

  it('values units at a price, rounding half away from zero', () => {
    expect(valueOf(parseUnits('500'), 23600n)).toBe(11_800_000n);
    // 0.5 units at 1 kobo is half a kobo: rounds up.
    expect(valueOf(parseUnits('0.5'), 1n)).toBe(1n);
    expect(valueOf(parseUnits('0.333333'), 300n)).toBe(100n);
  });
});

describe('pickLots', () => {
  const a = lot('a', '2026-01-01', '100', 10_000n);
  const b = lot('b', '2026-02-01', '100', 30_000n);

  it('sells the oldest lots first', () => {
    expect(pickLots([b, a], parseUnits('150'))).toEqual([
      { lotId: 'a', units: parseUnits('100'), cost: 10_000n },
      { lotId: 'b', units: parseUnits('50'), cost: 15_000n },
    ]);
  });

  it('uses the chosen lots when given', () => {
    expect(pickLots([a, b], parseUnits('20'), [{ lotId: 'b', units: parseUnits('20') }])).toEqual([
      { lotId: 'b', units: parseUnits('20'), cost: 6_000n },
    ]);
  });

  it('refuses more units than held, or chosen lots that do not add up', () => {
    expect(pickLots([a], parseUnits('101'))).toBeNull();
    expect(pickLots([a, b], parseUnits('20'), [{ lotId: 'a', units: parseUnits('10') }])).toBeNull();
    expect(pickLots([a], parseUnits('10'), [{ lotId: 'zz', units: parseUnits('10') }])).toBeNull();
  });

  it('costs of every part add up to the lot cost exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_999 }), fc.bigInt({ min: 1n, max: 10n ** 12n }), (cut, cost) => {
        const l = lot('x', '2026-01-01', '10000', cost);
        const first = pickLots([l], parseUnits(String(cut)))!;
        const rest = { ...l, units: l.units - first[0]!.units, cost: l.cost - first[0]!.cost };
        const second = pickLots([rest], rest.units)!;
        return first[0]!.cost + second[0]!.cost === cost;
      }),
    );
  });
});

describe('E20 to E22 builders', () => {
  it('E20: buying is not spending; cost includes fees (case 15)', () => {
    const b = build({
      type: 'investment_buy',
      holdingId: mtn.id,
      accountId: bank.id,
      units: '500',
      price: '21000',
      fees: '50000',
    });
    expect(b.lines.map((l) => [l.ledgerAccountId, l.amountMinor])).toEqual([
      [mtn.id, 10_550_000n],
      [bank.id, -10_550_000n],
    ]);
    expect(b.investment).toEqual({ kind: 'buy', units: '500', price: '21000', fees: '50000' });
  });

  it('E21: a loss goes to Investment loss, never spending', () => {
    const b = build(
      { type: 'investment_sell', holdingId: mtn.id, accountId: bank.id, units: '100', price: '9000', fees: '1000' },
      [lot('l1', '2026-01-01', '100', 1_000_000n)],
    );
    expect(b.lines.map((l) => [l.ledgerAccountId, l.amountMinor])).toEqual([
      [bank.id, 899_000n],
      [mtn.id, -1_000_000n],
      [system.get('investment_loss')!.id, 101_000n],
    ]);
  });

  it('E21: a sale at cost has no gain line', () => {
    const b = build({ type: 'investment_sell', holdingId: mtn.id, accountId: bank.id, units: '10', price: '100' }, [
      lot('l1', '2026-01-01', '10', 1_000n),
    ]);
    expect(b.lines).toHaveLength(2);
  });

  it('E21: refuses more units than held, and fees above the proceeds', () => {
    const open = [lot('l1', '2026-01-01', '10', 1_000n)];
    const err = (raw: Record<string, unknown>) => {
      try {
        build(raw, open);
        return null;
      } catch (e) {
        return (e as AppError).body();
      }
    };
    expect(
      err({ type: 'investment_sell', holdingId: mtn.id, accountId: bank.id, units: '11', price: '100' }),
    ).toMatchObject({
      code: 'not_enough_units',
      message: 'You hold 10 units. Sell that many or fewer.',
    });
    expect(
      err({ type: 'investment_sell', holdingId: mtn.id, accountId: bank.id, units: '10', price: '100', fees: '1000' }),
    ).toMatchObject({ code: 'fees_too_big' });
  });

  it('E22: a dividend paid out, or reinvested as a new lot, is Investment income', () => {
    const paid = build({ type: 'dividend', holdingId: mtn.id, amount: '1200000', accountId: bank.id });
    expect(paid.type).toBe('income');
    expect(paid.lines.map((l) => [l.ledgerAccountId, l.amountMinor])).toEqual([
      [bank.id, 1_200_000n],
      [system.get('investment_income')!.id, -1_200_000n],
    ]);
    const reinvested = build({ type: 'dividend', holdingId: mtn.id, amount: '1200000', reinvestedUnits: '50' });
    expect(reinvested.lines[0]!.ledgerAccountId).toBe(mtn.id);
    expect(reinvested.investment).toEqual({ kind: 'reinvest', units: '50' });
    expect(() => build({ type: 'dividend', holdingId: mtn.id, amount: '1' })).toThrow(AppError);
  });

  it('a holding is never a cash account', () => {
    expect(() => build({ type: 'income', accountId: mtn.id, categoryId: uuidv7(), amount: '100' })).toThrow(AppError);
  });
});

describe('lots and positions from history', () => {
  const ev = (id: string, date: string, investment: object, lines: [string, bigint][], status = 'posted') => ({
    id,
    date,
    status,
    holdingId: mtn.id,
    investment: investment as never,
    lines: lines.map(([ledgerAccountId, amountMinor]) => ({ ledgerAccountId, amountMinor })),
  });

  const history = [
    ev('b1', '2026-10-10', { kind: 'buy', units: '500', price: '21000', fees: '50000' }, [[mtn.id, 10_550_000n]]),
    ev(
      's1',
      '2026-10-25',
      { kind: 'sell', units: '200', price: '24000', fees: '0', lots: [{ lotId: 'b1', units: '200', cost: '4220000' }] },
      [
        [bank.id, 4_800_000n],
        [mtn.id, -4_220_000n],
      ],
    ),
  ];

  it('closes what a sale took and records the realised gain (case 17)', () => {
    const [l] = lotsFrom(history).get(mtn.id)!;
    expect(l).toMatchObject({ units: parseUnits('300'), cost: 6_330_000n, realised: 580_000n });
  });

  it('leaves out reversed events', () => {
    const reversed = history.map((e) => (e.id === 's1' ? { ...e, status: 'reversed' } : e));
    expect(lotsFrom(reversed).get(mtn.id)![0]).toMatchObject({ units: parseUnits('500'), cost: 10_550_000n });
  });

  it('values at the latest price on or before the date, else at cost (TECH-SPEC 6.8)', () => {
    const lots = lotsFrom(history).get(mtn.id)!;
    const prices = [
      { holdingId: mtn.id, date: '2026-10-20', priceMinor: 23600n },
      { holdingId: mtn.id, date: '2026-11-20', priceMinor: 30000n },
    ];
    expect(latestPrice(prices, mtn.id, '2026-11-01')?.priceMinor).toBe(23600n);
    const p = position(lots, prices, mtn.id, '2026-11-01');
    expect(p).toMatchObject({ units: parseUnits('300'), cost: 6_330_000n, value: 7_080_000n, unrealised: 750_000n });
    expect(position(lots, [], mtn.id, '2026-11-01')).toMatchObject({ value: 6_330_000n, unrealised: 0n, price: null });
  });
});

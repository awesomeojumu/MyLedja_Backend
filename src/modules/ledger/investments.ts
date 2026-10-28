import { divRoundHalfAwayFromZero } from '../../common/money/money.js';

/**
 * Investment arithmetic (TECH-SPEC 6.8). Pure, so the app runs the same rules offline. Units are held as
 * whole millionths ("micro-units") so fractional fund units and crypto never touch a float.
 */
export const UNIT_PLACES = 6;
const UNIT_SCALE = 10n ** BigInt(UNIT_PLACES);
const UNITS = /^(0|[1-9]\d{0,14})(?:\.(\d{1,6}))?$/;

export class UnitsError extends Error {
  constructor() {
    super('units_unreadable');
    this.name = 'UnitsError';
  }
}

/** "12.5" → 12500000n. Up to 6 decimal places. */
export function parseUnits(value: string): bigint {
  const m = UNITS.exec(value);
  if (!m) throw new UnitsError();
  return BigInt(m[1]!) * UNIT_SCALE + BigInt((m[2] ?? '').padEnd(UNIT_PLACES, '0'));
}

/** 12500000n → "12.5". */
export function formatUnits(micro: bigint): string {
  const whole = micro / UNIT_SCALE;
  const frac = (micro % UNIT_SCALE).toString().padStart(UNIT_PLACES, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Units × a price per unit in minor units, rounded half away from zero (TECH-SPEC 6.5). */
export function valueOf(micro: bigint, priceMinor: bigint): bigint {
  return divRoundHalfAwayFromZero(micro * priceMinor, UNIT_SCALE);
}

/** What an investment event recorded about units, kept on the event so lots can be rebuilt from history. */
export type InvestmentMeta =
  | { kind: 'buy'; units: string; price: string; fees: string }
  | { kind: 'reinvest'; units: string }
  | { kind: 'dividend' }
  | {
      kind: 'sell';
      units: string;
      price: string;
      fees: string;
      lots: { lotId: string; units: string; cost: string }[];
    };

/** A lot still (partly) held. `lotId` is the id of the event that bought it. */
export type OpenLot = { lotId: string; date: string; units: bigint; cost: bigint };

/** A lot with its history: what was bought and what is left. */
export type Lot = OpenLot & {
  boughtUnits: bigint;
  boughtCost: bigint;
  /** Realised gain of the units sold from this lot (proceeds share − cost share). */
  realised: bigint;
};

type InvestmentEvent = {
  id: string;
  date: string;
  status: string;
  holdingId: string | null;
  investment: InvestmentMeta | null;
  /** The holding's debit (cost of a buy or reinvested dividend) and, for a sell, its proceeds after fees. */
  lines: readonly { ledgerAccountId: string; amountMinor: bigint }[];
};

/**
 * Lots per holding, rebuilt from posted events in date order: buys and reinvested dividends open lots;
 * sells close the lots they name. Reversed events are left out (their reversal cancels them).
 */
export function lotsFrom(events: readonly InvestmentEvent[]): Map<string, Lot[]> {
  const out = new Map<string, Lot[]>();
  const live = events
    .filter((e) => e.status === 'posted' && e.investment && e.holdingId)
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
  for (const e of live) {
    const meta = e.investment!;
    const holding = e.holdingId!;
    const lots = out.get(holding) ?? [];
    out.set(holding, lots);
    if (meta.kind === 'buy' || meta.kind === 'reinvest') {
      const cost = e.lines.find((l) => l.ledgerAccountId === holding)?.amountMinor ?? 0n;
      const units = parseUnits(meta.units);
      lots.push({ lotId: e.id, date: e.date, units, cost, boughtUnits: units, boughtCost: cost, realised: 0n });
    } else if (meta.kind === 'sell') {
      const sold = parseUnits(meta.units);
      const proceeds = e.lines.find((l) => l.amountMinor > 0n)?.amountMinor ?? 0n;
      for (const part of meta.lots) {
        const lot = lots.find((l) => l.lotId === part.lotId);
        if (!lot) continue;
        const units = parseUnits(part.units);
        const cost = BigInt(part.cost);
        lot.units -= units;
        lot.cost -= cost;
        lot.realised += (sold === 0n ? 0n : divRoundHalfAwayFromZero(proceeds * units, sold)) - cost;
      }
    }
  }
  return out;
}

export type LotPick = { lotId: string; units: bigint; cost: bigint };

/**
 * Which lots a sale takes and what they cost: oldest first unless the person chose lots (TECH-SPEC 6.8).
 * A part of a lot costs its share of the lot's remaining cost, rounded half away from zero; selling what's
 * left of a lot takes all its remaining cost, so costs always add up exactly.
 * Returns null when the holding doesn't have that many units (or a chosen lot doesn't).
 */
export function pickLots(
  open: readonly OpenLot[],
  units: bigint,
  chosen?: readonly { lotId: string; units: bigint }[],
) {
  const picks: LotPick[] = [];
  const take = (lot: OpenLot, n: bigint) => {
    const cost = n === lot.units ? lot.cost : divRoundHalfAwayFromZero(lot.cost * n, lot.units);
    picks.push({ lotId: lot.lotId, units: n, cost });
  };
  if (chosen) {
    let total = 0n;
    for (const c of chosen) {
      const lot = open.find((l) => l.lotId === c.lotId);
      if (!lot || c.units <= 0n || c.units > lot.units) return null;
      take(lot, c.units);
      total += c.units;
    }
    return total === units ? picks : null;
  }
  let left = units;
  const oldest = [...open]
    .filter((l) => l.units > 0n)
    .sort((a, b) => (a.date === b.date ? a.lotId.localeCompare(b.lotId) : a.date.localeCompare(b.date)));
  for (const lot of oldest) {
    if (left === 0n) break;
    const n = left < lot.units ? left : lot.units;
    take(lot, n);
    left -= n;
  }
  return left === 0n ? picks : null;
}

export type Price = { holdingId: string; date: string; priceMinor: bigint };

/** The latest price entered on or before `date`, or null. */
export function latestPrice(prices: readonly Price[], holdingId: string, date: string): Price | null {
  let best: Price | null = null;
  for (const p of prices) {
    if (p.holdingId !== holdingId || p.date > date) continue;
    if (!best || p.date > best.date) best = p;
  }
  return best;
}

export type Position = {
  units: bigint;
  /** Remaining cost of the open lots. */
  cost: bigint;
  /** Units × latest price; falls back to cost when there's no price (TECH-SPEC 6.8). */
  value: bigint;
  unrealised: bigint;
  realised: bigint;
  /** The price used, or null when the value fell back to cost. */
  price: Price | null;
};

/** A holding's position on a date, from lots rebuilt from events up to that date and the prices entered. */
export function position(lots: readonly Lot[], prices: readonly Price[], holdingId: string, date: string): Position {
  let units = 0n;
  let cost = 0n;
  let realised = 0n;
  for (const l of lots) {
    units += l.units;
    cost += l.cost;
    realised += l.realised;
  }
  const price = latestPrice(prices, holdingId, date);
  const value = price ? valueOf(units, price.priceMinor) : cost;
  return { units, cost, value, unrealised: value - cost, realised, price };
}

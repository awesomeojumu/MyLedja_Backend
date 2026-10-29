import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, LocalDate, MinorAmount, Uuid } from '../../common/http/schemas.js';
import { PositiveMinor } from '../ledger/ledger.inputs.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

/** DESIGN.md page 17, Add / edit holding. */
export const HOLDING_TYPES = ['stock', 'fund', 'pension', 'crypto', 'fixed_deposit', 'other'] as const;
export const HoldingType = z.enum(HOLDING_TYPES);

/** Investment, pension, fixed deposit and other asset accounts can hold holdings. */
export const HOLDING_ACCOUNT_TYPES = ['investment', 'pension', 'fixed_deposit', 'other_asset'] as const;

export const RANGES = ['1M', '3M', '1Y', 'All'] as const;
export const Range = z.enum(RANGES).default('1Y');

const UnitsOut = z.string().meta({ description: 'Units as a decimal string, up to 6 places.' });

export const Holding = z
  .object({
    id: z.string().meta({ description: "Also the id of the holding's ledger account (TECH-SPEC 6.1)." }),
    name: z.string(),
    symbol: z.string().nullable(),
    type: HoldingType,
    accountId: z.string().meta({ description: 'The investment account it is held in.' }),
    currency: z.string(),
    archived: z.boolean(),
    units: UnitsOut,
    cost: MinorAmount.meta({ description: 'Remaining cost of the lots held (units × price + fees when bought).' }),
    averageCost: MinorAmount.nullable().meta({ description: 'Cost per unit, rounded. Null with no units.' }),
    price: MinorAmount.nullable().meta({ description: 'The latest price entered, or null.' }),
    priceDate: LocalDate.nullable(),
    value: MinorAmount.meta({
      description: 'Units × latest price; the cost when no price was entered (TECH-SPEC 6.8).',
    }),
    unrealised: MinorAmount.meta({ description: 'Value − cost. Never income (M17).' }),
    realised: MinorAmount.meta({ description: 'Gains and losses of lots sold (E21).' }),
    version: z.number().int(),
  })
  .meta({ id: 'Holding' });

export const SeriesPoint = z
  .object({ date: LocalDate, value: MinorAmount, cost: MinorAmount })
  .meta({ id: 'InvestmentSeriesPoint' });

export const Portfolio = z
  .object({
    asOf: LocalDate,
    currency: z.string(),
    value: MinorAmount,
    cost: MinorAmount,
    unrealised: MinorAmount,
    realised: MinorAmount.meta({ description: 'Realised gains in the range.' }),
    dividends: MinorAmount.meta({ description: 'Dividends and reinvested dividends in the range (E22).' }),
    partial: z.array(z.string()).meta({ description: 'Currencies left out of the totals for want of a rate.' }),
    holdings: z.array(Holding),
    byType: z.array(z.object({ type: HoldingType, value: MinorAmount })),
    byAccount: z.array(z.object({ accountId: z.string(), value: MinorAmount })),
    series: z.array(SeriesPoint),
  })
  .meta({ id: 'Portfolio' });

export const Lot = z
  .object({
    lotId: z.string().meta({ description: 'The id of the buy (or reinvested dividend) that opened it.' }),
    date: LocalDate,
    units: UnitsOut.meta({ description: 'Units bought.' }),
    unitsHeld: UnitsOut,
    costPerUnit: MinorAmount,
    cost: MinorAmount.meta({ description: 'Cost of the units still held.' }),
    value: MinorAmount,
    gain: MinorAmount.meta({ description: 'Unrealised gain of the units still held.' }),
    realised: MinorAmount.meta({ description: 'Realised gain of the units sold from this lot.' }),
    sold: z.boolean().meta({ description: 'Every unit sold: shown greyed (P18-02).' }),
  })
  .meta({ id: 'HoldingLot' });

export const Trade = z
  .object({
    transactionId: z.string(),
    date: LocalDate,
    kind: z.enum(['buy', 'sell']),
    units: UnitsOut,
    price: MinorAmount,
    fees: MinorAmount,
    amount: MinorAmount.meta({ description: 'Paid for a buy (with fees), received for a sale (after fees).' }),
    gain: MinorAmount.nullable().meta({ description: 'A sale: its realised gain.' }),
  })
  .meta({ id: 'HoldingTrade' });

export const Dividend = z
  .object({
    transactionId: z.string(),
    date: LocalDate,
    amount: MinorAmount,
    accountId: z.string().nullable(),
    reinvested: z.boolean(),
  })
  .meta({ id: 'HoldingDividend' });

export const PriceEntry = z
  .object({ holdingId: z.string(), date: LocalDate, price: MinorAmount, version: z.number().int() })
  .meta({ id: 'HoldingPrice' });

export const HoldingDetail = z
  .object({
    holding: Holding,
    lots: z.array(Lot),
    trades: z.array(Trade),
    dividends: z.array(Dividend),
    dividendsThisYear: MinorAmount,
    prices: z.array(PriceEntry),
    series: z.array(SeriesPoint),
  })
  .meta({ id: 'HoldingDetail' });

export const HoldingParams = WorkspaceParams.extend({ holdingId: Uuid });

export const CreateHoldingBody = z
  .object({
    id: Uuid.optional().meta({ description: 'Made on the device; also the id of its ledger account.' }),
    name: z.string().trim().min(1, { error: 'Enter a name' }).max(80),
    symbol: z.string().trim().max(20).nullable().optional(),
    type: HoldingType,
    accountId: Uuid.meta({ description: "The holding uses this account's currency." }),
    price: PositiveMinor.optional().meta({ description: 'Current price per unit, entered as a price for today.' }),
    priceDate: LocalDate.optional(),
  })
  .meta({ id: 'CreateHoldingBody' });

export const UpdateHoldingBody = z
  .object({
    baseVersion: BaseVersion,
    name: z.string().trim().min(1).max(80).optional(),
    symbol: z.string().trim().max(20).nullable().optional(),
    type: HoldingType.optional(),
  })
  .meta({ id: 'UpdateHoldingBody' });

export const SetPricesBody = z
  .object({
    date: LocalDate,
    prices: z
      .array(z.object({ holdingId: Uuid, price: PositiveMinor }))
      .min(1)
      .max(500),
  })
  .meta({ id: 'SetPricesBody' });

const tag = 'Investments';
const base = '/v1/workspaces/:workspaceId/investments';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const investmentRoutes = {
  portfolio: defineRoute({
    name: 'getPortfolio',
    method: 'GET',
    path: base,
    tag,
    summary: 'Portfolio: value, gains, dividends and every holding (DESIGN.md page 17)',
    description:
      'Buys are not spending and price rises are not income (M14, M17). Buy, sell and dividends are posted through createTransaction with types investment_buy, investment_sell and dividend.',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({ range: Range, archived: z.coerce.boolean().default(false) }),
    status: 200,
    response: Portfolio,
    errors: [400, 401, 404],
  }),
  create: defineRoute({
    name: 'createHolding',
    method: 'POST',
    path: `${base}/holdings`,
    tag,
    summary: 'Add a holding',
    access: editor,
    params: WorkspaceParams,
    body: CreateHoldingBody,
    status: 201,
    response: Holding,
    errors: [400, 401, 403, 404],
  }),
  get: defineRoute({
    name: 'getHolding',
    method: 'GET',
    path: `${base}/holdings/:holdingId`,
    tag,
    summary: 'One holding: lots, trades, dividends and prices (DESIGN.md page 18)',
    access: viewer,
    params: HoldingParams,
    query: z.object({ range: Range }),
    status: 200,
    response: HoldingDetail,
    errors: [400, 401, 404],
  }),
  update: defineRoute({
    name: 'updateHolding',
    method: 'PATCH',
    path: `${base}/holdings/:holdingId`,
    tag,
    summary: 'Rename a holding or change its symbol or type',
    access: editor,
    params: HoldingParams,
    body: UpdateHoldingBody,
    status: 200,
    response: Holding,
    errors: [400, 401, 403, 404, 409],
  }),
  archive: defineRoute({
    name: 'deleteHolding',
    method: 'DELETE',
    path: `${base}/holdings/:holdingId`,
    tag,
    summary: 'Remove a holding with no units left',
    description: 'Its history stays. A holding with units is refused: sell them first.',
    access: editor,
    params: HoldingParams,
    status: 200,
    response: Holding,
    errors: [400, 401, 403, 404, 409],
  }),
  setPrices: defineRoute({
    name: 'setHoldingPrices',
    method: 'PUT',
    path: `${base}/prices`,
    tag,
    summary: 'Update prices: one price per holding for a date (P17-04)',
    description: 'Entering a price again for the same date replaces it. Prices are not ledger events (M17).',
    access: editor,
    params: WorkspaceParams,
    body: SetPricesBody,
    status: 200,
    response: z.object({ prices: z.array(PriceEntry) }).meta({ id: 'SetPricesResult' }),
    errors: [400, 401, 403, 404],
  }),
  deletePrice: defineRoute({
    name: 'deleteHoldingPrice',
    method: 'DELETE',
    path: `${base}/holdings/:holdingId/prices/:date`,
    tag,
    summary: 'Remove a price from the price history',
    access: editor,
    params: HoldingParams.extend({ date: LocalDate }),
    status: 204,
    response: null,
    errors: [400, 401, 403, 404],
  }),
};

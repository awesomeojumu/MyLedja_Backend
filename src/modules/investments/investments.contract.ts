import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { LocalDate, MinorAmount, Uuid } from '../../common/http/schemas.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const HoldingType = z.enum(['stock', 'fund', 'pension', 'crypto', 'fixed_deposit', 'other']);

export const Holding = z
  .object({
    id: z.string(),
    name: z.string(),
    symbol: z.string().nullable(),
    type: HoldingType,
    accountId: z.string(),
    currency: z.string(),
    ledgerAccountId: z.string(),
    units: z.string(),
    cost: MinorAmount,
    price: MinorAmount.nullable(),
    value: MinorAmount,
    version: z.number().int(),
  })
  .meta({ id: 'Holding' });

export const HoldingLot = z
  .object({
    id: z.string(),
    holdingId: z.string(),
    date: LocalDate,
    units: z.string(),
    soldUnits: z.string(),
    cost: MinorAmount,
    pricePerUnit: MinorAmount,
    fees: MinorAmount,
  })
  .meta({ id: 'HoldingLot' });

export const HoldingPrice = z
  .object({
    id: z.string(),
    holdingId: z.string(),
    date: LocalDate,
    price: MinorAmount,
  })
  .meta({ id: 'HoldingPrice' });

const tag = 'Investments';
const base = '/v1/workspaces/:workspaceId/investments';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;
const editor = { kind: 'workspace', minRole: 'editor' } as const;

export const investmentRoutes = {
  listHoldings: defineRoute({
    name: 'listHoldings',
    method: 'GET',
    path: `${base}/holdings`,
    tag,
    summary: 'Holdings in the workspace',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: z.object({ holdings: z.array(Holding) }).meta({ id: 'HoldingList' }),
    errors: [401, 404],
  }),
  createHolding: defineRoute({
    name: 'createHolding',
    method: 'POST',
    path: `${base}/holdings`,
    tag,
    summary: 'Add a holding (no money moves)',
    access: editor,
    params: WorkspaceParams,
    body: z.object({
      id: Uuid.optional(),
      name: z.string().trim().min(1).max(60),
      symbol: z.string().trim().max(20).optional(),
      type: HoldingType.default('stock'),
      accountId: Uuid,
      currency: z.string().length(3).optional(),
      currentPrice: MinorAmount.optional(),
    }),
    status: 201,
    response: Holding,
    errors: [400, 401, 404],
  }),
  listLots: defineRoute({
    name: 'listLots',
    method: 'GET',
    path: `${base}/holdings/:holdingId/lots`,
    tag,
    summary: 'Lots for a holding (FIFO order)',
    access: viewer,
    params: WorkspaceParams.extend({ holdingId: Uuid }),
    status: 200,
    response: z.object({ lots: z.array(HoldingLot) }),
    errors: [401, 404],
  }),
  buy: defineRoute({
    name: 'buyHolding',
    method: 'POST',
    path: `${base}/buy`,
    tag,
    summary: 'E20 buy at cost',
    access: editor,
    params: WorkspaceParams,
    body: z.object({
      holdingId: Uuid,
      units: z.string(),
      pricePerUnit: MinorAmount,
      fees: MinorAmount.optional(),
      cashAccountId: Uuid,
      date: LocalDate,
      operationId: Uuid.optional(),
    }),
    status: 201,
    response: z.object({ transactionId: z.string(), lotId: z.string() }),
    errors: [400, 401, 404],
  }),
  sell: defineRoute({
    name: 'sellHolding',
    method: 'POST',
    path: `${base}/sell`,
    tag,
    summary: 'E21 sell (FIFO or chosen lots)',
    access: editor,
    params: WorkspaceParams,
    body: z.object({
      holdingId: Uuid,
      units: z.string(),
      pricePerUnit: MinorAmount,
      fees: MinorAmount.optional(),
      cashAccountId: Uuid,
      date: LocalDate,
      lotIds: z.array(Uuid).optional(),
      operationId: Uuid.optional(),
    }),
    status: 201,
    response: z.object({ transactionId: z.string(), gain: MinorAmount }),
    errors: [400, 401, 404],
  }),
  dividend: defineRoute({
    name: 'recordDividend',
    method: 'POST',
    path: `${base}/dividend`,
    tag,
    summary: 'E22 dividend or reinvested dividend',
    access: editor,
    params: WorkspaceParams,
    body: z.object({
      holdingId: Uuid,
      amount: MinorAmount,
      date: LocalDate,
      cashAccountId: Uuid,
      reinvested: z.boolean().default(false),
      units: z.string().optional(),
      pricePerUnit: MinorAmount.optional(),
      operationId: Uuid.optional(),
    }),
    status: 201,
    response: z.object({ transactionId: z.string() }),
    errors: [400, 401, 404],
  }),
  savePrices: defineRoute({
    name: 'savePrices',
    method: 'POST',
    path: `${base}/prices`,
    tag,
    summary: 'Update holding prices (not income)',
    access: editor,
    params: WorkspaceParams,
    body: z.object({
      date: LocalDate,
      prices: z.array(z.object({ holdingId: Uuid, price: MinorAmount })),
    }),
    status: 200,
    response: z.object({ saved: z.number().int() }),
    errors: [400, 401, 404],
  }),
  listPrices: defineRoute({
    name: 'listPrices',
    method: 'GET',
    path: `${base}/holdings/:holdingId/prices`,
    tag,
    summary: 'Price history for a holding',
    access: viewer,
    params: WorkspaceParams.extend({ holdingId: Uuid }),
    status: 200,
    response: z.object({ prices: z.array(HoldingPrice) }),
    errors: [401, 404],
  }),
};

export const exchangeRateRoutes = {
  listRates: defineRoute({
    name: 'listExchangeRates',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/exchange-rates',
    tag: 'Exchange rates',
    summary: 'Hand-entered exchange rates',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: z.object({
      rates: z.array(
        z.object({
          id: z.string(),
          currency: z.string(),
          date: LocalDate,
          rate: z.string(),
          source: z.enum(['manual', 'download']),
        }),
      ),
    }),
    errors: [401, 404],
  }),
  saveRate: defineRoute({
    name: 'saveExchangeRate',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/exchange-rates',
    tag: 'Exchange rates',
    summary: 'Save a rate for a currency and date (case 25)',
    access: editor,
    params: WorkspaceParams,
    body: z.object({
      currency: z.string().length(3),
      date: LocalDate,
      rate: z.string().regex(/^\d+(\.\d{1,10})?$/),
      source: z.enum(['manual', 'download']).default('manual'),
    }),
    status: 201,
    response: z.object({ id: z.string(), currency: z.string(), date: LocalDate, rate: z.string(), source: z.string() }),
    errors: [400, 401, 404],
  }),
};

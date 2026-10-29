import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { LocalDate } from '../../common/http/schemas.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

const RATE_ERROR = 'Enter a rate, for example 1550 or 1550.25';

/** Units of the workspace currency per one unit of `currency`, up to 10 decimal places (TECH-SPEC 6.5). */
export const Rate = z
  .string({ error: RATE_ERROR })
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,10})?$/, { error: RATE_ERROR })
  .refine((v) => /[1-9]/.test(v), { error: 'Enter a rate above 0' })
  .meta({ description: 'Workspace currency per one unit of the other currency, as a decimal string: "1550".' });

export const CurrencyCode = z
  .string({ error: 'Choose a currency' })
  .regex(/^[A-Z]{3}$/, { error: 'Choose a currency' });

export const ExchangeRate = z
  .object({
    id: z.string(),
    currency: z.string(),
    date: LocalDate,
    rate: z.string(),
    source: z.enum(['manual']).meta({ description: 'Typed in by hand (TECH-SPEC 6.13 decision 4).' }),
    version: z.number().int(),
  })
  .meta({ id: 'ExchangeRate' });

export const SetExchangeRateBody = z
  .object({ currency: CurrencyCode, date: LocalDate, rate: Rate })
  .meta({ id: 'SetExchangeRateBody' });

const tag = 'Currencies';
const base = '/v1/workspaces/:workspaceId/exchange-rates';

export const currencyRoutes = {
  list: defineRoute({
    name: 'listExchangeRates',
    method: 'GET',
    path: base,
    tag,
    summary: 'Exchange rates by currency and date, newest first (Settings › Currencies)',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: WorkspaceParams,
    query: z.object({ currency: CurrencyCode.optional() }),
    status: 200,
    response: z
      .object({
        currency: z.string().meta({ description: 'The workspace currency the rates convert into.' }),
        rates: z.array(ExchangeRate),
        needed: z
          .array(z.string())
          .meta({ description: 'Currencies your accounts and holdings use that have no rate yet.' }),
      })
      .meta({ id: 'ExchangeRateList' }),
    errors: [400, 401, 404],
  }),
  set: defineRoute({
    name: 'setExchangeRate',
    method: 'PUT',
    path: base,
    tag,
    summary: 'Add a rate for a date; a second one for the same date replaces it',
    access: { kind: 'workspace', minRole: 'editor' },
    params: WorkspaceParams,
    body: SetExchangeRateBody,
    status: 200,
    response: ExchangeRate,
    errors: [400, 401, 403, 404],
  }),
  remove: defineRoute({
    name: 'deleteExchangeRate',
    method: 'DELETE',
    path: `${base}/:currency/:date`,
    tag,
    summary: 'Remove a rate',
    access: { kind: 'workspace', minRole: 'editor' },
    params: WorkspaceParams.extend({ currency: CurrencyCode, date: LocalDate }),
    status: 204,
    response: null,
    errors: [400, 401, 403, 404],
  }),
};

import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';

export const INSTITUTION_KINDS = ['bank', 'wallet', 'microfinance', 'other'] as const;

export const Institution = z
  .object({
    id: z.string().meta({ description: 'Stable slug, for example "gtbank". Accounts store it as `institution`.' }),
    name: z.string().meta({ description: 'As people know it, for example "GTBank".' }),
    kind: z.enum(INSTITUTION_KINDS),
    logoUrl: z.url().nullable().meta({
      description:
        'A public Cloudinary image (square, transparent background). Null until a logo is uploaded: show the initials.',
    }),
    aliases: z.array(z.string()).meta({ description: 'Other names it goes by, for search ("Guaranty Trust Bank").' }),
  })
  .meta({ id: 'Institution' });

export const InstitutionList = z
  .object({
    institutions: z.array(Institution),
    version: z
      .string()
      .meta({ description: 'Changes whenever the list or a logo changes, so the app can cache the list.' }),
  })
  .meta({ id: 'InstitutionList' });

export const institutionRoutes = {
  list: defineRoute({
    name: 'listInstitutions',
    method: 'GET',
    path: '/v1/institutions',
    tag: 'Institutions',
    summary: 'Banks and wallets, with logos',
    description:
      'The banks and wallets people choose from when adding an account (Welcome step 3, Add account). Served by the API with logos in Cloudinary, so the list grows without an app update. Public and cacheable (`Cache-Control: public, max-age=86400`). Logos arrive later; until then `logoUrl` is null.',
    access: { kind: 'public' },
    status: 200,
    response: InstitutionList,
    errors: [],
  }),
};

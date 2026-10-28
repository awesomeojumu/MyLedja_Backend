import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { LocalDate, MinorAmount } from '../../common/http/schemas.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

/** Settings › AI features (TECH-SPEC 5.8): each use is off until the person agrees. */

export const AiConsentBody = z.object({
  categorize: z.boolean().meta({ description: 'Suggest categories. Sends description, amount and date only.' }),
  statements: z
    .boolean()
    .meta({ description: 'Read PDF and Excel statements. Sends redacted transaction lines only.' }),
  healthAdvice: z.boolean().meta({ description: 'Reword Health advice. Never sends any number.' }),
});

export const AiSettings = z
  .object({
    available: z
      .object({ claude: z.boolean(), gemini: z.boolean() })
      .meta({ description: 'Hidden in the app when both are false.' }),
    consent: AiConsentBody.extend({ updatedAt: z.iso.datetime().nullable() }),
  })
  .meta({ id: 'AiSettings' });

const tag = 'AI';

export const aiRoutes = {
  get: defineRoute({
    name: 'getAiSettings',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/ai',
    tag,
    summary: 'Which AI features are available and agreed to',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: WorkspaceParams,
    status: 200,
    response: AiSettings,
    errors: [401, 404],
  }),
  setConsent: defineRoute({
    name: 'setAiConsent',
    method: 'PUT',
    path: '/v1/workspaces/:workspaceId/ai/consent',
    tag,
    summary: 'Agree to, or turn off, each AI feature',
    access: { kind: 'workspace', minRole: 'admin' },
    params: WorkspaceParams,
    body: AiConsentBody,
    status: 200,
    response: AiSettings,
    errors: [400, 401, 403, 404],
  }),
  categorize: defineRoute({
    name: 'suggestCategories',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/ai/categorize',
    tag,
    summary: 'Suggest a category for each transaction (B4.4)',
    description: 'Only description, amount and date are sent. A null suggestion means nothing fitted.',
    access: { kind: 'workspace', minRole: 'editor' },
    params: WorkspaceParams,
    body: z.object({
      items: z
        .array(z.object({ description: z.string().max(300), amount: MinorAmount, date: LocalDate }))
        .min(1)
        .max(100),
    }),
    status: 200,
    response: z.object({ categoryIds: z.array(z.string().nullable()) }),
    errors: [400, 401, 403, 404, 503],
    idempotent: false,
  }),
};

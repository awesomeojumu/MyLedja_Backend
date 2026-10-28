import { z } from 'zod';
import { APP_ENVS } from '../../config/config.schema.js';
import { defineRoute } from '../../common/http/contract.js';

export const Health = z.object({ status: z.literal('ok'), env: z.enum(APP_ENVS) }).meta({ id: 'Health' });

export const PublicConfig = z
  .object({
    env: z.enum(APP_ENVS),
    google: z.object({
      enabled: z.boolean(),
      clientId: z.string().nullable().meta({ description: "Google's public OAuth client id, when set up." }),
    }),
    services: z.object({
      bankConnections: z.boolean(),
      files: z.boolean(),
      ai: z.boolean(),
    }),
  })
  .meta({
    id: 'PublicConfig',
    description: 'Which optional services are on, so the app hides what is off (TECH-SPEC 2.3 rule 3). No secrets.',
  });

export const healthRoutes = {
  health: defineRoute({
    name: 'getHealth',
    method: 'GET',
    path: '/v1/health',
    tag: 'System',
    summary: 'Liveness check',
    access: { kind: 'public' },
    status: 200,
    response: Health,
    errors: [],
  }),
  publicConfig: defineRoute({
    name: 'getPublicConfig',
    method: 'GET',
    path: '/v1/public-config',
    tag: 'System',
    summary: 'Optional services that are on',
    access: { kind: 'public' },
    status: 200,
    response: PublicConfig,
    errors: [],
  }),
};

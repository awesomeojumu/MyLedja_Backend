import { z } from 'zod';
import { ROLES } from '../../common/auth/roles.js';
import { defineRoute } from '../../common/http/contract.js';
import { LocalDate, MinorAmount, Uuid } from '../../common/http/schemas.js';
import { User } from '../auth/auth.contract.js';

export const BUDGET_STYLES = ['tracking', 'envelope'] as const;
export const WEEK_STARTS = ['monday', 'sunday', 'saturday'] as const;
export const SETUP_ACCOUNT_TYPES = ['bank', 'cash', 'wallet', 'card', 'savings', 'investment', 'loan'] as const;

export const WorkspaceParams = z.object({ workspaceId: Uuid });

export const Workspace = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.literal('personal'),
    currency: z.string(),
    timeZone: z.string(),
    weekStart: z.enum(WEEK_STARTS),
    budgetStyle: z.enum(BUDGET_STYLES),
    setupComplete: z.boolean(),
    skippedSteps: z.array(z.number().int()),
    role: z.enum(ROLES).meta({ description: "The caller's role." }),
    features: z.array(z.string()),
    version: z.number().int(),
  })
  .meta({ id: 'Workspace' });

const SetupAccount = z.object({
  id: Uuid.optional().meta({ description: 'A UUID v7 made on the device, so later records can refer to it offline.' }),
  name: z.string().trim().min(1, { error: 'Add a name for this account' }).max(100),
  type: z.enum(SETUP_ACCOUNT_TYPES, { error: 'Choose a type' }),
  openingBalance: MinorAmount.meta({
    description: 'Whole kobo. For a card or loan, what you owe, as a positive figure.',
  }),
  openingDate: LocalDate,
});

const SetupCategory = z.object({
  key: z.string().trim().min(1).max(60).meta({ description: 'Starter-set key, or "custom-<n>" for your own.' }),
  group: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1, { error: 'Add a name for this category' }).max(60),
});

export const SetupBody = z.object({
  workspaceName: z
    .string({ error: 'Add a name' })
    .trim()
    .min(1, { error: 'Add a name' })
    .max(60, { error: 'Use 60 characters or fewer' }),
  currency: z.literal('NGN', { error: 'Choose naira' }),
  weekStart: z.enum(WEEK_STARTS, { error: 'Choose the first day of your week' }),
  accounts: z.array(SetupAccount).max(50),
  categories: z.array(SetupCategory).max(200),
  budgetStyle: z.enum(BUDGET_STYLES, { error: 'Choose a budget style' }),
  monthlyTakeHome: MinorAmount.nullable(),
  skippedSteps: z
    .array(z.number().int().min(1).max(5))
    .max(5)
    .meta({ description: "Steps left for the Dashboard's Get started checklist (P04-02)." }),
});

const tag = 'Workspaces';

export const workspaceRoutes = {
  get: defineRoute({
    name: 'getWorkspace',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId',
    tag,
    summary: 'Read a workspace',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: WorkspaceParams,
    status: 200,
    response: Workspace,
    errors: [400, 401, 404],
  }),
  setup: defineRoute({
    name: 'finishSetup',
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/setup',
    tag,
    summary: 'Finish Welcome',
    description:
      'Saves the workspace name, week start and budget style, creates each account with its opening balance (E8, never income) and each category (in the group named; a group called "Income" holds income categories), and marks setup complete. Account `id`s made on the device are kept. Sending setup again adds only what is new: accounts and categories already created are matched by id, then by name.',
    access: { kind: 'workspace', minRole: 'admin' },
    params: WorkspaceParams,
    body: SetupBody,
    status: 200,
    response: User,
    errors: [400, 401, 403, 404],
  }),
};

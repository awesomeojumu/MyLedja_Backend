import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { BaseVersion, Uuid } from '../../common/http/schemas.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

/** Rules (DESIGN page 25, build plan B4.5). The same shape the app edits; runs on past transactions are corrections. */

export const RuleCondition = z.object({
  field: z.enum(['payee', 'description', 'amount', 'account', 'category', 'notes', 'date']),
  op: z.enum(['contains', 'equals', 'lessThan', 'greaterThan', 'before', 'after']),
  value: z.string().max(200),
});

export const RuleAction = z.object({
  kind: z.enum(['setCategory', 'renamePayee', 'addNote', 'addTag', 'split', 'linkSchedule', 'moneyBack']),
  value: z.string().max(200),
});

export const RuleBody = z.object({
  enabled: z.boolean(),
  stage: z.enum(['first', 'normal', 'last']),
  order: z.number().int().min(0),
  matchMode: z.enum(['all', 'any']),
  conditions: z.array(RuleCondition).max(20),
  actions: z.array(RuleAction).max(10),
  matchedCount: z.number().int().min(0).default(0),
  lastUsedAt: z.string().optional(),
});

export const Rule = RuleBody.extend({ id: z.string(), version: z.number().int() }).meta({ id: 'Rule' });

const RuleParams = WorkspaceParams.extend({ ruleId: Uuid });

export const ruleRoutes = {
  list: defineRoute({
    name: 'listRules',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/rules',
    tag: 'Rules',
    summary: 'Rules in the order they run: first, normal, last',
    access: { kind: 'workspace', minRole: 'viewer' },
    params: WorkspaceParams,
    status: 200,
    response: z.object({ rules: z.array(Rule) }),
    errors: [401, 404],
  }),
  upsert: defineRoute({
    name: 'upsertRule',
    method: 'PUT',
    path: '/v1/workspaces/:workspaceId/rules/:ruleId',
    tag: 'Rules',
    summary: 'Create or replace a rule (device id)',
    access: { kind: 'workspace', minRole: 'editor' },
    params: RuleParams,
    body: RuleBody.extend({ baseVersion: BaseVersion.nullable().optional() }),
    status: 200,
    response: Rule,
    errors: [400, 401, 404, 409],
  }),
  remove: defineRoute({
    name: 'deleteRule',
    method: 'DELETE',
    path: '/v1/workspaces/:workspaceId/rules/:ruleId',
    tag: 'Rules',
    summary: 'Delete a rule',
    access: { kind: 'workspace', minRole: 'editor' },
    params: RuleParams,
    status: 200,
    response: z.object({ id: z.string() }),
    errors: [401, 404],
  }),
};

import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

/** Rules (DESIGN page 25, build plan B4.5). The same shape the app edits; runs on past transactions are corrections. */

export const RuleCondition = z.object({
  field: z.enum(['payee', 'description', 'amount', 'account', 'category', 'notes', 'date']),
  op: z.enum(['contains', 'equals', 'lessThan', 'greaterThan', 'before', 'after']),
  value: z.string().max(200),
});

export const RuleAction = z.object({
  kind: z.enum(['setCategory', 'renamePayee', 'addNote']),
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
};

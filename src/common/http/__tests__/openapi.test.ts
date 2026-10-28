import { describe, expect, it } from 'vitest';
import { ALL_ROUTES } from '../../../contract.js';
import { buildOpenApi } from '../openapi.js';

describe('openapi.json from the contracts (B0.11)', () => {
  const doc = buildOpenApi(ALL_ROUTES, '0.0.0') as {
    paths: Record<string, Record<string, { operationId: string; parameters?: { name: string }[] }>>;
    components: { schemas: Record<string, unknown> };
  };

  it('has one operation per route, with unique operationIds', () => {
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(ops).toHaveLength(ALL_ROUTES.length);
    expect(new Set(ops).size).toBe(ops.length);
  });

  it('documents X-Operation-Id on writes and not on reads or refresh', () => {
    const header = (path: string, method: string) =>
      (doc.paths[path]?.[method]?.parameters ?? []).some((p) => p.name === 'X-Operation-Id');
    expect(header('/v1/auth/sign-in', 'post')).toBe(true);
    expect(header('/v1/me', 'get')).toBe(false);
    expect(header('/v1/auth/refresh', 'post')).toBe(false);
  });

  it('names shared shapes as components', () => {
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(['Error', 'User', 'SessionResponse']));
  });
});

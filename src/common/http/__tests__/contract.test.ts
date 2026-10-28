import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.factory.js';
import { ALL_ROUTES } from '../../../contract.js';
import { testConfig } from '../../../../test/helpers/test-config.js';
import { buildOpenApi } from '../openapi.js';

describe('contracts and openapi.json (B0.11)', () => {
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

describe('contract checks on requests', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApp(testConfig(), { quiet: true });
  });
  afterAll(async () => {
    await app.close();
  });

  const opId = '0190f5a8-7b1c-7d2e-8f3a-4b5c6d7e8f90';

  it('refuses bad input with the error shape and a DESIGN.md 2.12 message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { 'x-operation-id': opId },
      payload: { name: 'Ada', email: 'not-an-email', password: 'long-enough-password', termsAccepted: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      code: 'invalid_input',
      field: 'email',
      message: 'Enter your email address, for example ada@example.com',
    });
  });

  it('refuses a common password and unticked terms', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { 'x-operation-id': opId },
      payload: { name: 'Ada', email: 'ada@example.test', password: 'password123', termsAccepted: true },
    });
    expect(weak.json()).toMatchObject({
      field: 'password',
      message: 'This password is too common. Choose another one',
    });
    const terms = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { 'x-operation-id': opId },
      payload: { name: 'Ada', email: 'ada@example.test', password: 'a-long-unusual-pass', termsAccepted: false },
    });
    expect(terms.json()).toMatchObject({ field: 'termsAccepted', message: 'Agree to the terms to continue' });
  });

  it('needs an X-Operation-Id on writes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/recover',
      payload: { email: 'ada@example.test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('operation_id_missing');
  });

  it('refuses a body that is not JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/recover',
      headers: { 'content-type': 'application/json', 'x-operation-id': opId },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad_request');
  });
});

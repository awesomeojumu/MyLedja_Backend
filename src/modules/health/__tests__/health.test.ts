import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.factory.js';
import { testConfig } from '../../../../test/helpers/test-config.js';

describe('GET /v1/health (B0.1)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApp(testConfig(), { quiet: true });
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with the environment', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', env: 'development' });
  });

  it('reports optional services as off when unset, with no secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/public-config' });
    expect(res.json()).toEqual({
      env: 'development',
      google: { enabled: false, clientId: null },
      services: { bankConnections: false, files: false, ai: false },
    });
  });

  it('answers unknown routes with the error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'not_found', message: expect.any(String) });
  });

  it('allows only CORS_ORIGINS', async () => {
    const ok = await app.inject({ method: 'GET', url: '/v1/health', headers: { origin: 'http://localhost:8081' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    const bad = await app.inject({ method: 'GET', url: '/v1/health', headers: { origin: 'https://evil.test' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

describe('GET /v1/health (B0.1)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(() => t.close());

  it('returns 200 with the environment', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', env: 'development' });
  });

  it('reports optional services as off when unset, with no secrets', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/public-config' });
    expect(res.json()).toEqual({
      env: 'development',
      google: { enabled: false, clientId: null },
      services: { bankConnections: false, files: false, ai: false },
    });
  });

  it('shows the Google client id when Google sign-in is set up', async () => {
    const g = await startTestApp({ GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh' });
    const res = await g.app.inject({ method: 'GET', url: '/v1/public-config' });
    expect(res.json().google).toEqual({ enabled: true, clientId: 'abc.apps.googleusercontent.com' });
    expect(res.body).not.toContain('shh');
    await g.close();
  });

  it('answers unknown routes with the error shape', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'not_found', message: expect.any(String) });
  });

  it('allows only CORS_ORIGINS', async () => {
    const ok = await t.app.inject({ method: 'GET', url: '/v1/health', headers: { origin: 'http://localhost:8081' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    const bad = await t.app.inject({ method: 'GET', url: '/v1/health', headers: { origin: 'https://evil.test' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

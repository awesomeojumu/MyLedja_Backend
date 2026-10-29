import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, signUp, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('files API (TECH-SPEC §8)', () => {
  it('uploads a receipt and returns a signed view link', async () => {
    const ada = await signUp(t);
    const base = `/v1/workspaces/${ada.workspaceId}/files`;
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    const uploaded = await t.app.inject({
      method: 'POST',
      url: base,
      headers: { ...ada.auth, ...op() },
      payload: {
        contentBase64: tinyPng.toString('base64'),
        contentType: 'image/png',
        kind: 'receipt',
      },
    });
    expect(uploaded.statusCode).toBe(201);
    const body = uploaded.json();
    expect(body.fileId).toBeTruthy();
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.resourceType).toBe('image');

    const view = await t.app.inject({
      method: 'GET',
      url: `${base}/${encodeURIComponent(body.fileId)}/view-url`,
      headers: ada.auth,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().url).toBeTruthy();
    expect(view.json().fileId).toBe(body.fileId);
    expect(view.json().expiresAt).toMatch(/^\d{4}-/);
  });
});

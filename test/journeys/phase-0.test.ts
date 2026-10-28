import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, startTestApp, type TestApp } from '../helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const call = (method: 'GET' | 'POST', url: string, payload?: object, auth?: string) =>
  t.app.inject({
    method,
    url,
    payload,
    headers: { ...(method === 'POST' ? op() : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
  });

describe('Journey: sign up, check email, finish Welcome, land on Dashboard', () => {
  it('goes end to end', async () => {
    const email = 'ada@example.test';
    expect(
      (
        await call('POST', '/v1/auth/sign-up', {
          name: 'Ada',
          email,
          password: 'ada-strong-passphrase',
          termsAccepted: true,
        })
      ).statusCode,
    ).toBe(202);
    const verified = await call('POST', '/v1/auth/verify-email', { email, code: t.outbox.lastCode(email) });
    const { accessToken, user } = verified.json();
    expect(user.setupComplete).toBe(false);

    const done = await call(
      'POST',
      `/v1/workspaces/${user.workspaceId}/setup`,
      {
        workspaceName: 'Personal',
        currency: 'NGN',
        weekStart: 'monday',
        accounts: [
          { name: 'GTBank Current', type: 'bank', openingBalance: '81230000', openingDate: '2026-10-01' },
          { name: 'OPay Wallet', type: 'wallet', openingBalance: '2420000', openingDate: '2026-10-01' },
        ],
        categories: [{ key: 'rent', group: 'Home', name: 'Rent' }],
        budgetStyle: 'tracking',
        monthlyTakeHome: null,
        skippedSteps: [],
      },
      accessToken,
    );
    expect(done.json()).toMatchObject({ setupComplete: true });
    expect((await call('GET', '/v1/me', undefined, accessToken)).json().setupComplete).toBe(true);
  });
});

describe('Journey: sign in, sign out, recover the password', () => {
  it('goes end to end', async () => {
    const email = 'bola@example.test';
    await call('POST', '/v1/auth/sign-up', {
      name: 'Bola',
      email,
      password: 'bola-strong-passphrase',
      termsAccepted: true,
    });
    await call('POST', '/v1/auth/verify-email', { email, code: t.outbox.lastCode(email) });

    const signedIn = await call('POST', '/v1/auth/sign-in', { email, password: 'bola-strong-passphrase' });
    const token = signedIn.json().accessToken;
    expect((await call('POST', '/v1/auth/sign-out', undefined, token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/me', undefined, token)).statusCode).toBe(401);

    expect((await call('POST', '/v1/auth/recover', { email })).statusCode).toBe(202);
    const changed = await call('POST', '/v1/auth/new-password', {
      email,
      code: t.outbox.lastCode(email),
      newPassword: 'bola-new-passphrase',
    });
    expect(changed.statusCode).toBe(204);
    expect((await call('POST', '/v1/auth/sign-in', { email, password: 'bola-new-passphrase' })).statusCode).toBe(200);
  });
});

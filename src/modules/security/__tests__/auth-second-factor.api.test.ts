import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, signUp, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';
import { totpAt } from '../totp.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({
    GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
    CORS_ORIGINS: 'http://localhost:8081',
  });
});
afterAll(() => t.close());

const authHeaders = (accessToken: string) => ({ authorization: `Bearer ${accessToken}`, ...op() });

async function turnOnTwoFactor(accessToken: string) {
  const setup = await t.app.inject({
    method: 'POST',
    url: '/v1/me/two-factor/setup',
    headers: authHeaders(accessToken),
  });
  expect(setup.statusCode).toBe(200);
  const secret = setup.json().secret as string;
  const code = totpAt(secret, Math.floor(t.clock.now.getTime() / 1000));
  const confirm = await t.app.inject({
    method: 'POST',
    url: '/v1/me/two-factor/confirm',
    headers: authHeaders(accessToken),
    payload: { code },
  });
  expect(confirm.statusCode).toBe(200);
  return { secret, backupCodes: confirm.json().backupCodes as string[] };
}

describe('POST /v1/auth/two-factor (P01-06 / BUILD-PLAN 3.3)', () => {
  it('asks for a code after password sign-in, then finishes with TOTP', async () => {
    const ada = await signUp(t);
    const { secret } = await turnOnTwoFactor(ada.accessToken);

    const signIn = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email: ada.email, password: ada.password },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json()).toMatchObject({ twoFactorRequired: true, challengeToken: expect.any(String) });

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/two-factor',
      headers: op(),
      payload: { challengeToken: signIn.json().challengeToken, code: '000000', trustDevice: false },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('code_wrong');

    const code = totpAt(secret, Math.floor(t.clock.now.getTime() / 1000));
    const finish = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/two-factor',
      headers: op(),
      payload: { challengeToken: signIn.json().challengeToken, code, trustDevice: true },
    });
    expect(finish.statusCode).toBe(200);
    expect(finish.json().user.id).toBe(ada.userId);
    expect(finish.json().accessToken).toEqual(expect.any(String));
    expect(finish.json().trustedDeviceToken).toEqual(expect.any(String));
  });

  it('accepts a backup code once', async () => {
    const ada = await signUp(t, 'Bola');
    const { backupCodes } = await turnOnTwoFactor(ada.accessToken);
    const backup = backupCodes[0]!;

    const firstSignIn = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email: ada.email, password: ada.password },
    });
    const first = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/two-factor',
      headers: op(),
      payload: {
        challengeToken: firstSignIn.json().challengeToken,
        backupCode: backup,
        trustDevice: false,
      },
    });
    expect(first.statusCode).toBe(200);

    const secondSignIn = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email: ada.email, password: ada.password },
    });
    const reuse = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/two-factor',
      headers: op(),
      payload: {
        challengeToken: secondSignIn.json().challengeToken,
        backupCode: backup,
        trustDevice: false,
      },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('code_wrong');
  });
});

describe('POST /v1/auth/passkey (P01-07 server)', () => {
  it('starts passkey sign-in with options and a challenge token', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/passkey/options',
      headers: op(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      challengeToken: expect.any(String),
      options: expect.objectContaining({ challenge: expect.any(String) }),
    });
  });

  it('refuses a forged passkey assertion', async () => {
    const options = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/passkey/options',
      headers: op(),
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/passkey',
      headers: op(),
      payload: {
        challengeToken: options.json().challengeToken,
        response: {
          id: 'not-a-real-credential',
          rawId: 'not-a-real-credential',
          type: 'public-key',
          response: {
            clientDataJSON: 'e30',
            authenticatorData: 'e30',
            signature: 'e30',
            userHandle: null,
          },
        },
        staySignedIn: false,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('passkey_failed');
  });
});

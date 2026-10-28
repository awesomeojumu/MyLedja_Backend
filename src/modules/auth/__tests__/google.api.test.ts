import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, signUp, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com' });
});
afterAll(() => t.close());

const google = (idToken: string, headers = op()) =>
  t.app.inject({ method: 'POST', url: '/v1/auth/google', headers, payload: { idToken } });

let n = 0;
function identity(email: string, verified = true) {
  const token = `google-token-${n++}`;
  t.google.tokens.set(token, { googleId: `g-${n}`, email, emailVerified: verified, name: 'Ada Lovelace' });
  return token;
}

describe('POST /v1/auth/google (B0.8)', () => {
  it('a new email creates an account and a Personal workspace, and skips the email code (P02-05)', async () => {
    const res = await google(identity('new.person@example.test'));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      name: 'Ada Lovelace',
      email: 'new.person@example.test',
      setupComplete: false,
    });
    const user = await t.db.collection('users').findOne({ email: 'new.person@example.test' });
    expect(user).toMatchObject({ passwordHash: null, emailVerifiedAt: expect.any(Date) });
    expect(t.outbox.to('new.person@example.test')).toHaveLength(0);
  });

  it('the same Google account signs in again', async () => {
    const token = identity('again@example.test');
    const first = await google(token);
    const second = await google(token);
    expect(second.json().user.id).toBe(first.json().user.id);
    expect(await t.db.collection('users').countDocuments({ email: 'again@example.test' })).toBe(1);
  });

  it('an existing password account links only after a password sign-in (P01-03)', async () => {
    const ada = await signUp(t);
    const res = await google(identity(ada.email));
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({ code: 'google_link_needed', email: ada.email, linkToken: expect.any(String) });
    expect((await t.db.collection('users').findOne({ _id: ada.userId as never }))?.googleId).toBeNull();

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email: ada.email, password: 'not-the-password', googleLinkToken: body.linkToken },
    });
    expect(wrong.statusCode).toBe(401);
    expect((await t.db.collection('users').findOne({ _id: ada.userId as never }))?.googleId).toBeNull();

    const linked = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email: ada.email, password: ada.password, googleLinkToken: body.linkToken },
    });
    expect(linked.statusCode).toBe(200);
    expect((await t.db.collection('users').findOne({ _id: ada.userId as never }))?.googleId).toMatch(/^g-/);
    const after = await google([...t.google.tokens.entries()].find(([, v]) => v.email === ada.email)![0]);
    expect(after.json().user.id).toBe(ada.userId);
  });

  it("a link token can't link a different account", async () => {
    const ada = await signUp(t);
    const bola = await signUp(t, 'Bola');
    const { linkToken } = (await google(identity(ada.email))).json();
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email: bola.email, password: bola.password, googleLinkToken: linkToken },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('google_link_invalid');
  });

  it("an unconfirmed sign-up is taken over by Google, and the stranger's password stops working", async () => {
    const email = 'victim@example.test';
    await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: op(),
      payload: { name: 'Stranger', email, password: 'stranger-password-1', termsAccepted: true },
    });
    const res = await google(identity(email));
    expect(res.statusCode).toBe(200);
    const signIn = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email, password: 'stranger-password-1' },
    });
    expect(signIn.statusCode).toBe(401);
  });

  it('refuses a token Google did not sign, or an unverified Google email', async () => {
    expect((await google('forged')).statusCode).toBe(401);
    expect((await google(identity('unverified@example.test', false))).json().code).toBe('google_refused');
  });

  it('checks input and runs once', async () => {
    expect((await google('')).statusCode).toBe(400);
    const headers = op();
    const token = identity('once@example.test');
    const a = await google(token, headers);
    const b = await google(token, headers);
    expect(b.json()).toEqual(a.json());
  });

  it('answers google_off when Google sign-in is not set up', async () => {
    const off = await startTestApp();
    const res = await off.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      headers: op(),
      payload: { idToken: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('google_off');
    await off.close();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, signUp, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';
import { RECHECK_WINDOW_MS } from '../security.contract.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com' });
});
afterAll(() => t.close());

const authHeaders = (accessToken: string) => ({ authorization: `Bearer ${accessToken}`, ...op() });

/** Ages the session past the re-check window without expiring the access token. */
async function agePastRecheck(userId: string) {
  const past = new Date(t.clock.now.getTime() - RECHECK_WINDOW_MS - 1);
  await t.db.collection('sessions').updateMany({ userId }, { $set: { createdAt: past, recheckedAt: null } });
}

describe('PU-61 change email', () => {
  it('PU61-1: email only changes after the code from the new address; PU61-2: old address is told', async () => {
    const ada = await signUp(t);
    const newEmail = `new.${ada.email}`;

    const beforeConfirm = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      headers: authHeaders(ada.accessToken),
      payload: { email: newEmail.toUpperCase() },
    });
    expect(beforeConfirm.statusCode).toBe(204);
    expect(await t.db.collection('users').findOne({ email: ada.email })).toMatchObject({ email: ada.email });
    expect(t.outbox.to(newEmail).at(-1)?.template).toBe('email_change_code');
    expect(t.outbox.to(ada.email).filter((m) => m.template === 'email_changed')).toHaveLength(0);

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/confirm',
      headers: authHeaders(ada.accessToken),
      payload: { email: newEmail, code: '000000' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(await t.db.collection('users').findOne({ email: ada.email })).toBeTruthy();
    expect(await t.db.collection('users').findOne({ email: newEmail })).toBeNull();

    const confirmed = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/confirm',
      headers: authHeaders(ada.accessToken),
      payload: { email: newEmail, code: t.outbox.lastCode(newEmail) },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ email: newEmail });
    expect(await t.db.collection('users').findOne({ email: newEmail })).toMatchObject({ email: newEmail });
    expect(await t.db.collection('users').findOne({ email: ada.email })).toBeNull();
    expect(t.outbox.to(ada.email).at(-1)?.template).toBe('email_changed');
    expect(t.outbox.to(ada.email).at(-1)?.text).toContain(newEmail);

    const audit = await t.db
      .collection('audit_events')
      .findOne({ action: 'user.email_changed', 'target.id': ada.userId });
    expect(audit).toBeTruthy();
  });

  it('refuses an address already in use without saying why', async () => {
    const ada = await signUp(t);
    const bola = await signUp(t, 'Bola');
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      headers: authHeaders(ada.accessToken),
      payload: { email: bola.email },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'email_in_use', message: "That email can't be used", field: 'email' });
    expect(t.outbox.to(bola.email).filter((m) => m.template === 'email_change_code')).toHaveLength(0);
  });

  it('refuses the current email and needs a recent re-check after the window', async () => {
    const ada = await signUp(t);
    const same = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      headers: authHeaders(ada.accessToken),
      payload: { email: ada.email },
    });
    expect(same.statusCode).toBe(400);
    expect(same.json().code).toBe('email_same');

    await agePastRecheck(ada.userId);
    const stale = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      headers: authHeaders(ada.accessToken),
      payload: { email: `later.${ada.email}` },
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe('recheck_needed');

    await t.app.inject({
      method: 'POST',
      url: '/v1/auth/recheck',
      headers: authHeaders(ada.accessToken),
      payload: { password: ada.password },
    });
    const after = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      headers: authHeaders(ada.accessToken),
      payload: { email: `later.${ada.email}` },
    });
    expect(after.statusCode).toBe(204);
  });
});

describe('POST /v1/auth/recheck/google', () => {
  it('marks the session rechecked for Google-only accounts', async () => {
    const token = 'google-recheck-token';
    t.google.tokens.set(token, {
      googleId: 'g-recheck',
      email: 'google.only@example.test',
      emailVerified: true,
      name: 'Google Ada',
    });
    const signedIn = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      headers: op(),
      payload: { idToken: token },
    });
    expect(signedIn.statusCode).toBe(200);
    const accessToken = signedIn.json().accessToken as string;
    const userId = signedIn.json().user.id as string;

    await agePastRecheck(userId);
    const blocked = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      headers: authHeaders(accessToken),
      payload: { email: 'google.new@example.test' },
    });
    expect(blocked.json().code).toBe('recheck_needed');

    const recheck = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/recheck/google',
      headers: authHeaders(accessToken),
    });
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json().recheckedUntil).toBeTruthy();

    const ok = await t.app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      headers: authHeaders(accessToken),
      payload: { email: 'google.new@example.test' },
    });
    expect(ok.statusCode).toBe(204);
  });

  it('refuses accounts that have a password', async () => {
    const ada = await signUp(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/recheck/google',
      headers: authHeaders(ada.accessToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('google_recheck_unavailable');
  });
});

describe('POST /v1/me/password signOutOtherDevices', () => {
  it('keeps other devices signed in when signOutOtherDevices is false', async () => {
    const ada = await signUp(t);
    const other = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: op(),
      payload: { email: ada.email, password: ada.password },
    });
    const otherToken = other.json().accessToken as string;

    const changed = await t.app.inject({
      method: 'POST',
      url: '/v1/me/password',
      headers: authHeaders(ada.accessToken),
      payload: {
        currentPassword: ada.password,
        newPassword: 'my-brand-new-passphrase',
        signOutOtherDevices: false,
      },
    });
    expect(changed.statusCode).toBe(204);

    const stillSignedIn = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(stillSignedIn.statusCode).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { op, signUp, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers: { ...op(), ...headers } });

const PASSWORD = 'a-long-unusual-passphrase';
let n = 0;
const freshEmail = () => `person${n++}@example.test`;

describe('POST /v1/auth/sign-up', () => {
  it('works: creates an unconfirmed person and emails a 6-digit code', async () => {
    const email = freshEmail();
    const res = await post('/v1/auth/sign-up', {
      name: 'Ada',
      email: email.toUpperCase(),
      password: PASSWORD,
      termsAccepted: true,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ codeExpiresInSeconds: 600, resendAfterSeconds: 45 });
    const user = await t.db.collection('users').findOne({ email });
    expect(user).toMatchObject({ name: 'Ada', emailVerifiedAt: null });
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(t.outbox.lastCode(email)).toMatch(/^\d{6}$/);
    expect(await t.db.collection('codes').findOne({ email })).not.toHaveProperty('code');
  });

  it('checks input', async () => {
    const res = await post('/v1/auth/sign-up', {
      name: '',
      email: freshEmail(),
      password: PASSWORD,
      termsAccepted: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'invalid_input', field: 'name', message: 'Add your name' });
    const short = await post('/v1/auth/sign-up', {
      name: 'A',
      email: freshEmail(),
      password: 'short',
      termsAccepted: true,
    });
    expect(short.json()).toMatchObject({ field: 'password', message: 'Use at least 10 characters' });
  });

  it('refuses sign-up without consent to the terms (B3.8)', async () => {
    const res = await post('/v1/auth/sign-up', {
      name: 'A',
      email: freshEmail(),
      password: PASSWORD,
      termsAccepted: false,
    });
    expect(res.json()).toMatchObject({ field: 'termsAccepted', message: 'Agree to the terms to continue' });
  });

  it('P02-04: an already-registered email still gets "check your email", and the email says so', async () => {
    const ada = await signUp(t);
    const before = await t.db.collection('users').findOne({ email: ada.email });
    const res = await post('/v1/auth/sign-up', {
      name: 'Imposter',
      email: ada.email,
      password: 'another-long-password',
      termsAccepted: true,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ codeExpiresInSeconds: 600, resendAfterSeconds: 45 });
    expect(t.outbox.to(ada.email).at(-1)?.template).toBe('already_registered');
    expect(await t.db.collection('users').findOne({ email: ada.email })).toEqual(before);
  });

  it('runs once: the same operationId returns the first answer and sends one email', async () => {
    const email = freshEmail();
    const headers = op();
    const body = { name: 'Ada', email, password: PASSWORD, termsAccepted: true };
    const first = await post('/v1/auth/sign-up', body, headers);
    const second = await post('/v1/auth/sign-up', body, headers);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(t.outbox.to(email)).toHaveLength(1);
    const reused = await post('/v1/auth/sign-up', { ...body, name: 'Different' }, headers);
    expect(reused.statusCode).toBe(422);
  });

  it('needs an operationId', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/sign-up', payload: { name: 'A' } });
    expect(res.json().code).toBe('operation_id_missing');
  });
});

describe('POST /v1/auth/verify-email', () => {
  it('works: confirms, creates the Personal workspace with an owner membership, and signs in', async () => {
    const email = freshEmail();
    await post('/v1/auth/sign-up', { name: 'Ada', email, password: PASSWORD, termsAccepted: true });
    const res = await post('/v1/auth/verify-email', { email, code: t.outbox.lastCode(email) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      accessTokenExpiresIn: 900,
      refreshToken: expect.any(String),
      user: { name: 'Ada', email, setupComplete: false, workspaceName: 'Personal' },
    });
    const ws = await t.db.collection('workspaces').findOne({ _id: body.user.workspaceId });
    expect(ws).toMatchObject({ currency: 'NGN', timeZone: 'Africa/Lagos', budgetStyle: 'tracking', type: 'personal' });
    expect(await t.db.collection('memberships').findOne({ workspaceId: ws?._id })).toMatchObject({
      role: 'owner',
      userId: body.user.id,
    });
    const actions = (await t.db.collection('audit_events').find({ workspaceId: ws?._id }).toArray()).map(
      (a) => a.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['workspace.created', 'user.signed_up']));
  });

  it('checks input and refuses a wrong code; the fifth wrong try kills it', async () => {
    const email = freshEmail();
    await post('/v1/auth/sign-up', { name: 'Ada', email, password: PASSWORD, termsAccepted: true });
    const code = t.outbox.lastCode(email);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await post('/v1/auth/verify-email', { email, code: '12' })).json()).toMatchObject({ field: 'code' });
    for (let i = 0; i < 4; i++) {
      expect((await post('/v1/auth/verify-email', { email, code: wrong })).json().code).toBe('code_wrong');
    }
    expect((await post('/v1/auth/verify-email', { email, code: wrong })).json().code).toBe('code_expired');
    expect((await post('/v1/auth/verify-email', { email, code })).json().code).toBe('code_expired');
  });

  it('refuses an expired code', async () => {
    const email = freshEmail();
    await post('/v1/auth/sign-up', { name: 'Ada', email, password: PASSWORD, termsAccepted: true });
    t.clock.advance(601_000);
    const res = await post('/v1/auth/verify-email', { email, code: t.outbox.lastCode(email) });
    expect(res.json()).toEqual({
      code: 'code_expired',
      field: 'code',
      message: 'This code has expired. Send a new one.',
    });
  });

  it('runs once: a retried confirmation returns the same session and makes one workspace', async () => {
    const email = freshEmail();
    await post('/v1/auth/sign-up', { name: 'Ada', email, password: PASSWORD, termsAccepted: true });
    const headers = op();
    const body = { email, code: t.outbox.lastCode(email) };
    const a = await post('/v1/auth/verify-email', body, headers);
    const b = await post('/v1/auth/verify-email', body, headers);
    expect(b.json()).toEqual(a.json());
    expect(await t.db.collection('memberships').countDocuments({ userId: a.json().user.id })).toBe(1);
  });
});

describe('POST /v1/auth/resend-code', () => {
  it('sends a new code after 45 seconds, not before, and always answers the same', async () => {
    const email = freshEmail();
    await post('/v1/auth/sign-up', { name: 'Ada', email, password: PASSWORD, termsAccepted: true });
    const early = await post('/v1/auth/resend-code', { email });
    expect(early.statusCode).toBe(202);
    expect(t.outbox.to(email)).toHaveLength(1);
    t.clock.advance(46_000);
    await post('/v1/auth/resend-code', { email });
    expect(t.outbox.to(email)).toHaveLength(2);
    const unknown = await post('/v1/auth/resend-code', { email: freshEmail() });
    expect(unknown.json()).toEqual(early.json());
  });

  it('checks input', async () => {
    expect((await post('/v1/auth/resend-code', { email: 'x' })).statusCode).toBe(400);
  });
});

describe('POST /v1/auth/sign-in', () => {
  it('works, and lands on Welcome until setup is done (P01-01)', async () => {
    const ada = await signUp(t);
    const res = await post('/v1/auth/sign-in', { email: ada.email, password: ada.password, deviceName: 'Pixel 7' });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: ada.email, setupComplete: false });
    const sessions = await t.db.collection('sessions').find({ userId: ada.userId }).toArray();
    expect(sessions.map((s) => s.deviceName)).toContain('Pixel 7');
    expect(JSON.stringify(sessions)).not.toContain(res.json().refreshToken.split('.')[1]);
  });

  it('P01-02: wrong details never say which; five failures give "Wait 1 minute"', async () => {
    const ada = await signUp(t);
    const wrongPassword = await post('/v1/auth/sign-in', { email: ada.email, password: 'not-the-password' });
    const unknownEmail = await post('/v1/auth/sign-in', { email: freshEmail(), password: 'not-the-password' });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual({ code: 'sign_in_wrong', message: 'Email or password is wrong' });
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
    for (let i = 0; i < 3; i++) await post('/v1/auth/sign-in', { email: ada.email, password: 'nope-nope-nope' });
    const locked = await post('/v1/auth/sign-in', { email: ada.email, password: 'nope-nope-nope' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ code: 'too_many_attempts', message: 'Wait 1 minute', retryAfterSeconds: 60 });
    expect(locked.headers['retry-after']).toBe('60');
    const evenRight = await post('/v1/auth/sign-in', { email: ada.email, password: ada.password });
    expect(evenRight.statusCode).toBe(429);
    t.clock.advance(61_000);
    expect((await post('/v1/auth/sign-in', { email: ada.email, password: ada.password })).statusCode).toBe(200);
  });

  it('the lock grows after the next five failures', async () => {
    const ada = await signUp(t);
    for (let round = 0; round < 2; round++) {
      let last;
      for (let i = 0; i < 5; i++)
        last = await post('/v1/auth/sign-in', { email: ada.email, password: 'nope-nope-nope' });
      expect(last!.json().retryAfterSeconds).toBe(60 * 2 ** round);
      t.clock.advance(60_000 * 2 ** round + 1000);
    }
  });

  it('checks input', async () => {
    const res = await post('/v1/auth/sign-in', { email: 'ada@example.test', password: '' });
    expect(res.json()).toMatchObject({ code: 'invalid_input', field: 'password', message: 'Enter your password' });
  });

  it('an unconfirmed email with the right password gets a fresh code (Q-B7)', async () => {
    const email = freshEmail();
    await post('/v1/auth/sign-up', { name: 'Ada', email, password: PASSWORD, termsAccepted: true });
    t.clock.advance(46_000);
    const res = await post('/v1/auth/sign-in', { email, password: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('email_not_verified');
    expect(t.outbox.to(email)).toHaveLength(2);
  });

  it('runs once', async () => {
    const ada = await signUp(t);
    const headers = op();
    const a = await post('/v1/auth/sign-in', { email: ada.email, password: ada.password }, headers);
    const b = await post('/v1/auth/sign-in', { email: ada.email, password: ada.password }, headers);
    expect(b.json()).toEqual(a.json());
    expect(await t.db.collection('sessions').countDocuments({ userId: ada.userId })).toBe(2);
  });
});

describe('"Stay signed in" on web (P01-04, TECH-SPEC 10)', () => {
  const origin = 'http://localhost:8081';

  async function cookieSignIn() {
    const ada = await signUp(t);
    const res = await post('/v1/auth/sign-in', { email: ada.email, password: ada.password, staySignedIn: true });
    const setCookie = String(res.headers['set-cookie']);
    const token = /myledja_refresh=([^;]+)/.exec(setCookie)?.[1];
    return { ada, res, setCookie, token: token! };
  }

  it('sets an HttpOnly, SameSite=Strict cookie on the refresh path, and no token in the body', async () => {
    const { res, setCookie } = await cookieSignIn();
    expect(res.json().refreshToken).toBeNull();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/v1/auth/refresh');
    expect(setCookie).toContain('Max-Age=2592000');
  });

  it('refreshes from the cookie with the custom header and an allowed Origin', async () => {
    const { token } = await cookieSignIn();
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-myledja-client': '1', origin, cookie: `myledja_refresh=${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ refreshToken: null, accessTokenExpiresIn: 900 });
    expect(String(res.headers['set-cookie'])).toContain('myledja_refresh=');
  });

  it('refuses the cookie refresh without the custom header, or from a foreign Origin', async () => {
    const { token } = await cookieSignIn();
    const cookie = `myledja_refresh=${token}`;
    const noHeader = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { origin, cookie },
      payload: {},
    });
    expect(noHeader.statusCode).toBe(403);
    const foreign = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-myledja-client': '1', origin: 'https://evil.test', cookie },
      payload: {},
    });
    expect(foreign.statusCode).toBe(403);
    const noOrigin = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-myledja-client': '1', cookie },
      payload: {},
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it('ends after 7 days without use, and after 30 days in all', async () => {
    const { token } = await cookieSignIn();
    t.clock.advance(8 * 86_400_000);
    const idle = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-myledja-client': '1', origin, cookie: `myledja_refresh=${token}` },
      payload: {},
    });
    expect(idle.statusCode).toBe(401);

    let { token: current } = await cookieSignIn();
    for (let day = 0; day < 5; day++) {
      t.clock.advance(6 * 86_400_000);
      const r = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { 'x-myledja-client': '1', origin, cookie: `myledja_refresh=${current}` },
        payload: {},
      });
      if (day < 4) {
        expect(r.statusCode).toBe(200);
        current = /myledja_refresh=([^;]+)/.exec(String(r.headers['set-cookie']))![1]!;
      } else {
        expect(r.statusCode).toBe(401);
      }
    }
  });
});

describe('POST /v1/auth/refresh', () => {
  const refresh = (refreshToken: string | undefined, headers: Record<string, string> = { 'x-myledja-client': '1' }) =>
    t.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers, payload: refreshToken ? { refreshToken } : {} });

  it('works: rotates the refresh token', async () => {
    const ada = await signUp(t);
    const res = await refresh(ada.refreshToken);
    expect(res.statusCode).toBe(200);
    const next = res.json().refreshToken;
    expect(next).not.toBe(ada.refreshToken);
    expect(next.split('.')[0]).toBe(ada.refreshToken.split('.')[0]);
    const me = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('checks input and needs the client header', async () => {
    expect((await refresh('nonsense')).statusCode).toBe(401);
    expect((await refresh(undefined)).statusCode).toBe(403);
    const ada = await signUp(t);
    expect((await refresh(ada.refreshToken, {})).statusCode).toBe(403);
  });

  it('reusing an old refresh token ends every session for that person', async () => {
    const ada = await signUp(t);
    const other = await post('/v1/auth/sign-in', { email: ada.email, password: ada.password });
    const rotated = await refresh(ada.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const reuse = await refresh(ada.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('session_ended');
    expect((await refresh(rotated.json().refreshToken)).statusCode).toBe(401);
    expect((await refresh(other.json().refreshToken)).statusCode).toBe(401);
    const me = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${other.json().accessToken}` },
    });
    expect(me.statusCode).toBe(401);
    const actions = (await t.db.collection('audit_events').find({ workspaceId: ada.workspaceId }).toArray()).map(
      (a) => a.action,
    );
    expect(actions).toContain('session.refresh_reused');
  });

  it('a body token on a cookie session is fine, but a cookie on a token session is refused', async () => {
    const ada = await signUp(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        'x-myledja-client': '1',
        origin: 'http://localhost:8081',
        cookie: `myledja_refresh=${ada.refreshToken}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/auth/sign-out and sign-out-others', () => {
  it('needs sign-in', async () => {
    expect((await post('/v1/auth/sign-out', undefined)).statusCode).toBe(401);
    expect((await post('/v1/auth/sign-out-others', undefined)).statusCode).toBe(401);
    expect((await post('/v1/auth/sign-out', undefined, { authorization: 'Bearer junk' })).statusCode).toBe(401);
  });

  it('sign-out ends this session at once, and clears the cookie', async () => {
    const ada = await signUp(t);
    const res = await post('/v1/auth/sign-out', undefined, ada.auth);
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain('myledja_refresh=;');
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: ada.auth })).statusCode).toBe(401);
    const r = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-myledja-client': '1' },
      payload: { refreshToken: ada.refreshToken },
    });
    expect(r.statusCode).toBe(401);
  });

  it('sign-out-others ends every other session and keeps this one', async () => {
    const ada = await signUp(t);
    const phone = (await post('/v1/auth/sign-in', { email: ada.email, password: ada.password })).json();
    const laptop = (await post('/v1/auth/sign-in', { email: ada.email, password: ada.password })).json();
    const res = await post('/v1/auth/sign-out-others', undefined, ada.auth);
    expect(res.json()).toEqual({ signedOut: 2 });
    for (const s of [phone, laptop]) {
      const me = await t.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${s.accessToken}` },
      });
      expect(me.statusCode).toBe(401);
    }
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: ada.auth })).statusCode).toBe(200);
  });

  it('runs once', async () => {
    const ada = await signUp(t);
    await post('/v1/auth/sign-in', { email: ada.email, password: ada.password });
    const headers = { ...op(), ...ada.auth };
    const a = await post('/v1/auth/sign-out-others', undefined, headers);
    await post('/v1/auth/sign-in', { email: ada.email, password: ada.password });
    const b = await post('/v1/auth/sign-out-others', undefined, headers);
    expect(b.json()).toEqual(a.json());
    expect(await t.db.collection('sessions').countDocuments({ userId: ada.userId, revokedAt: null })).toBe(2);
  });
});

describe('POST /v1/auth/recover and new-password (P03)', () => {
  it('P03-01: the same answer for a known and an unknown email', async () => {
    const ada = await signUp(t);
    const known = await post('/v1/auth/recover', { email: ada.email });
    const unknown = await post('/v1/auth/recover', { email: freshEmail() });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    expect(unknown.headers['content-length']).toBe(known.headers['content-length']);
    expect(t.outbox.to(ada.email).at(-1)?.template).toBe('recover_code');
  });

  it('P03-02, P03-03: a new password with the code signs out every device', async () => {
    const ada = await signUp(t);
    const other = (await post('/v1/auth/sign-in', { email: ada.email, password: ada.password })).json();
    await post('/v1/auth/recover', { email: ada.email });
    const res = await post('/v1/auth/new-password', {
      email: ada.email,
      code: t.outbox.lastCode(ada.email),
      newPassword: 'my-brand-new-passphrase',
    });
    expect(res.statusCode).toBe(204);
    for (const token of [ada.accessToken, other.accessToken]) {
      expect(
        (await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } }))
          .statusCode,
      ).toBe(401);
    }
    expect((await post('/v1/auth/sign-in', { email: ada.email, password: ada.password })).statusCode).toBe(401);
    expect((await post('/v1/auth/sign-in', { email: ada.email, password: 'my-brand-new-passphrase' })).statusCode).toBe(
      200,
    );
    expect(t.outbox.to(ada.email).at(-1)?.template).toBe('password_changed');
  });

  it('checks input: the same strength rules as sign-up, and a real code', async () => {
    const ada = await signUp(t);
    await post('/v1/auth/recover', { email: ada.email });
    const weak = await post('/v1/auth/new-password', { email: ada.email, code: '123456', newPassword: '1234567890' });
    expect(weak.json()).toMatchObject({
      field: 'newPassword',
      message: 'This password is too common. Choose another one',
    });
    const code = t.outbox.lastCode(ada.email);
    const wrong = await post('/v1/auth/new-password', {
      email: ada.email,
      code: code === '000000' ? '111111' : '000000',
      newPassword: 'my-brand-new-passphrase',
    });
    expect(wrong.json().code).toBe('code_wrong');
    const unknown = await post('/v1/auth/new-password', {
      email: freshEmail(),
      code,
      newPassword: 'my-brand-new-passphrase',
    });
    expect(unknown.json().code).toBe('code_expired');
  });

  it('a sign-up code cannot reset a password', async () => {
    const email = freshEmail();
    await post('/v1/auth/sign-up', { name: 'Ada', email, password: PASSWORD, termsAccepted: true });
    const res = await post('/v1/auth/new-password', {
      email,
      code: t.outbox.lastCode(email),
      newPassword: 'my-brand-new-passphrase',
    });
    expect(res.json().code).toBe('code_expired');
  });

  it('runs once', async () => {
    const ada = await signUp(t);
    await post('/v1/auth/recover', { email: ada.email });
    const headers = op();
    const body = { email: ada.email, code: t.outbox.lastCode(ada.email), newPassword: 'my-brand-new-passphrase' };
    const a = await post('/v1/auth/new-password', body, headers);
    const b = await post('/v1/auth/new-password', body, headers);
    expect([a.statusCode, b.statusCode]).toEqual([204, 204]);
    expect(t.outbox.to(ada.email).filter((m) => m.template === 'password_changed')).toHaveLength(1);
  });
});

describe('GET /v1/me', () => {
  it('works, and needs sign-in', async () => {
    const ada = await signUp(t);
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: ada.auth });
    expect(res.json()).toEqual({
      id: ada.userId,
      name: 'Ada',
      email: ada.email,
      setupComplete: false,
      workspaceId: ada.workspaceId,
      workspaceName: 'Personal',
    });
    expect((await t.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
  });

  it('refuses an expired access token after 15 minutes', async () => {
    const ada = await signUp(t);
    t.clock.advance(15 * 60_000 + 1000);
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: ada.auth })).statusCode).toBe(401);
  });
});

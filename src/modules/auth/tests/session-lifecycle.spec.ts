import { INestApplication } from "@nestjs/common";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import { SECURITY_EVENTS_COLLECTION } from "@/modules/auth/schemas/security-event";
import { http, registerAndVerify, startAuthApp, TEST_PASSWORD, TestApp } from "@/modules/auth/tests/test-app";

jest.setTimeout(120_000);

interface Tokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

describe("session lifecycle", () => {
  let harness: TestApp;
  let app: INestApplication;
  let mailer: CaptureMailer;

  beforeAll(async () => {
    harness = await startAuthApp();
    app = harness.app;
    mailer = harness.mailer;
  });

  afterAll(async () => {
    await harness.stop();
  });

  async function login(email: string, password = TEST_PASSWORD): Promise<Tokens> {
    const res = await http(app, "POST", "/v1/auth/login", { email, password });
    expect(res.code).toBe(200);
    return res.json as Tokens;
  }

  it("returns the signed-in user from /me and rejects the access token right after logout", async () => {
    const email = "me@example.com";
    await registerAndVerify(app, mailer, email);
    const tokens = await login(email);

    const me = await http(app, "GET", "/v1/auth/me", undefined, tokens.accessToken);
    expect(me.code).toBe(200);
    expect(me.json).toEqual({ userId: tokens.userId, email, hideLockScreenAmounts: true });

    await http(app, "POST", "/v1/auth/logout", { refreshToken: tokens.refreshToken });
    const after = await http(app, "GET", "/v1/auth/me", undefined, tokens.accessToken);
    expect(after.code).toBe(401);
  });

  it("rejects missing, malformed and forged access tokens", async () => {
    expect((await http(app, "GET", "/v1/auth/me")).code).toBe(401);
    expect((await http(app, "GET", "/v1/auth/me", undefined, "not-a-token")).code).toBe(401);
    const forged =
      "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4Iiwic2lkIjoieSJ9.";
    expect((await http(app, "GET", "/v1/auth/me", undefined, forged)).code).toBe(401);
  });

  it("resends a working verification code, with the same reply for unknown emails", async () => {
    const email = "late@example.com";
    await http(app, "POST", "/v1/auth/register", { email, password: TEST_PASSWORD });
    const firstCode = mailer.lastCode(email, "verify");

    const known = await http(app, "POST", "/v1/auth/verify/resend", { email });
    const unknown = await http(app, "POST", "/v1/auth/verify/resend", { email: "ghost@example.com" });
    expect(known.code).toBe(202);
    expect(unknown.json).toEqual(known.json);

    const secondCode = mailer.lastCode(email, "verify");
    expect(secondCode).toBeDefined();
    expect(secondCode).not.toBe(firstCode);
    if (firstCode !== secondCode) {
      const stale = await http(app, "POST", "/v1/auth/verify", { email, code: firstCode });
      expect(stale.code).toBe(401);
    }
    const verified = await http(app, "POST", "/v1/auth/verify", { email, code: secondCode });
    expect(verified.code).toBe(200);
  });

  it("resets the password, revokes every session and records the reset", async () => {
    const email = "forgot@example.com";
    const { userId } = await registerAndVerify(app, mailer, email);
    const old = await login(email);

    await http(app, "POST", "/v1/auth/recovery", { email });
    const code = mailer.lastCode(email, "recovery");
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await http(app, "POST", "/v1/auth/recovery/confirm", {
      email,
      code: code === "000000" ? "111111" : "000000",
      password: "brand-new-passphrase",
    });
    expect(wrong.code).toBe(401);

    const reset = await http(app, "POST", "/v1/auth/recovery/confirm", {
      email,
      code,
      password: "brand-new-passphrase",
    });
    expect(reset.code).toBe(200);

    expect((await http(app, "GET", "/v1/auth/me", undefined, old.accessToken)).code).toBe(401);
    expect((await http(app, "POST", "/v1/auth/refresh", { refreshToken: old.refreshToken })).code).toBe(401);
    expect((await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD })).code).toBe(401);
    await login(email, "brand-new-passphrase");

    const reused = await http(app, "POST", "/v1/auth/recovery/confirm", {
      email,
      code,
      password: "another-new-passphrase",
    });
    expect(reused.code).toBe(401);

    const events = await harness.db.collection(SECURITY_EVENTS_COLLECTION).find({ userId }).toArray();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "password_reset" })]));
  });

  it("stores verification codes only as keyed hashes", async () => {
    const email = "hashed@example.com";
    await http(app, "POST", "/v1/auth/register", { email, password: TEST_PASSWORD });
    const code = mailer.lastCode(email, "verify") ?? "";
    const stored = await harness.db.collection("email_codes").findOne({ email, purpose: "verify" });
    expect(JSON.stringify(stored)).not.toContain(code);
  });
});

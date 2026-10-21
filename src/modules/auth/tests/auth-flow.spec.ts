import { argon2id } from "argon2";
import { INestApplication } from "@nestjs/common";
import { ARGON2_PRODUCTION } from "@/modules/auth/domain/password";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import {
  http,
  registerAndVerify,
  startAuthApp,
  TEST_PASSWORD,
  TestApp,
} from "@/modules/auth/tests/test-app";

jest.setTimeout(120_000);

describe("ARGON2_PRODUCTION", () => {
  it("matches OWASP Argon2id parameters", () => {
    expect(ARGON2_PRODUCTION).toEqual({
      type: argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  });
});

describe("register → verify → login → refresh → logout", () => {
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

  it("passes the full session cycle", async () => {
    const email = "ada@example.com";
    const first = await http(app, "POST", "/v1/auth/register", { email, password: TEST_PASSWORD });
    const second = await http(app, "POST", "/v1/auth/register", {
      email,
      password: "another-long-password",
    });
    expect(first.code).toBe(202);
    expect(first.json).toEqual({ status: "accepted" });
    expect(second.json).toEqual(first.json);
    // Registering again before verifying sends a fresh code, with the same neutral reply.
    expect(mailer.sent.filter((item) => item.email === email && item.purpose === "verify")).toHaveLength(2);

    const unverified = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    expect(unverified.code).toBe(403);

    const { userId } = await registerAndVerify(app, mailer, email);
    const login = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    expect(login.code).toBe(200);
    const tokens = login.json as { accessToken: string; refreshToken: string; userId: string };
    expect(tokens.userId).toBe(userId);
    expect(tokens.accessToken.length).toBeGreaterThan(20);
    expect(tokens.refreshToken).toContain(".");

    const refreshed = await http(app, "POST", "/v1/auth/refresh", { refreshToken: tokens.refreshToken });
    expect(refreshed.code).toBe(200);
    const next = refreshed.json as { refreshToken: string };
    expect(next.refreshToken).not.toBe(tokens.refreshToken);

    const loggedOut = await http(app, "POST", "/v1/auth/logout", { refreshToken: next.refreshToken });
    expect(loggedOut.code).toBe(200);
    const reused = await http(app, "POST", "/v1/auth/refresh", { refreshToken: next.refreshToken });
    expect(reused.code).toBe(401);
  });

  it("keeps sign-up and recovery accepted when the mail server rejects the address", async () => {
    const email = "bounce@example.com";
    mailer.rejects.add(email);
    const bounced = await http(app, "POST", "/v1/auth/register", { email, password: TEST_PASSWORD });
    expect(bounced.code).toBe(202);
    expect(bounced.json).toEqual({ status: "accepted" });

    mailer.rejects.delete(email);
    const resend = await http(app, "POST", "/v1/auth/verify/resend", { email });
    expect(resend.code).toBe(202);
    expect(resend.json).toEqual({ status: "accepted" });
    const code = mailer.lastCode(email, "verify");
    expect(code).toMatch(/^\d{6}$/);
    const verified = await http(app, "POST", "/v1/auth/verify", { email, code });
    expect(verified.code).toBe(200);

    mailer.rejects.add(email);
    const recovery = await http(app, "POST", "/v1/auth/recovery", { email });
    expect(recovery.code).toBe(202);
    expect(recovery.json).toEqual({ status: "accepted" });
    mailer.rejects.delete(email);
  });
});

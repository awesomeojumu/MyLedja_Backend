import { INestApplication } from "@nestjs/common";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import { http, registerAndVerify, startAuthApp, TestApp } from "@/modules/auth/tests/test-app";

jest.setTimeout(120_000);

describe("recovery", () => {
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

  it("sends a code to a known account and says when no account matches", async () => {
    const email = "known@example.com";
    await registerAndVerify(app, mailer, email);
    const exists = await http(app, "POST", "/v1/auth/recovery", { email });
    expect(exists.code).toBe(202);
    expect(exists.json).toEqual({ status: "accepted" });
    expect(mailer.lastCode(email, "recovery")).toMatch(/^\d{6}$/);
    const missing = await http(app, "POST", "/v1/auth/recovery", { email: "nobody@example.com" });
    expect(missing.code).toBe(404);
    expect(missing.json).toEqual({ status: "error", error: "no account" });
  });

  it("asks an unverified account to finish signing up", async () => {
    const email = "halfway@example.com";
    await http(app, "POST", "/v1/auth/register", { email, password: "kola-nut-river-42" });
    const res = await http(app, "POST", "/v1/auth/recovery", { email });
    expect(res.code).toBe(403);
    expect(res.json).toEqual({ status: "error", error: "email not verified" });
  });
});

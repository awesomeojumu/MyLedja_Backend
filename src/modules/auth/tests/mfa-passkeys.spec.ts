import { INestApplication } from "@nestjs/common";
import { totpAt } from "@/modules/auth/domain/totp";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import { http, registerAndVerify, startAuthApp, TEST_PASSWORD, TestApp } from "@/modules/auth/tests/test-app";

jest.setTimeout(120_000);

describe("optional TOTP and skippable passkeys", () => {
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

  it("new user signs in with password only; skip enroll never enables TOTP", async () => {
    const email = "plain@example.com";
    await registerAndVerify(app, mailer, email);
    const login = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    expect(login.code).toBe(200);
    expect((login.json as { refreshToken: string }).refreshToken).toBeTruthy();
    const token = (login.json as { accessToken: string }).accessToken;
    const me = await http(app, "GET", "/v1/auth/me", undefined, token);
    expect((me.json as { totpEnabled: boolean }).totpEnabled).toBe(false);
  });

  it("after enroll, password alone does not issue tokens; TOTP and backup do", async () => {
    const email = "mfa@example.com";
    await registerAndVerify(app, mailer, email);
    const first = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    const token = (first.json as { accessToken: string }).accessToken;
    const start = await http(app, "POST", "/v1/me/mfa/totp/start", {}, token);
    expect(start.code).toBe(201);
    const secret = (start.json as { data: { secret: string } }).data.secret;
    const confirm = await http(app, "POST", "/v1/me/mfa/totp/confirm", { code: totpAt(secret, Math.floor(Date.now() / 1000)) }, token);
    expect(confirm.code).toBe(201);
    const backups = (confirm.json as { data: { backupCodes: string[] } }).data.backupCodes;
    expect(backups.length).toBeGreaterThan(0);

    const blocked = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    expect(blocked.code).toBe(403);
    const challenge = blocked.json as { status: string; data: { challengeId: string }; refreshToken?: string };
    expect(challenge.status).toBe("mfa_required");
    expect(challenge.refreshToken).toBeUndefined();

    const wrong = await http(app, "POST", "/v1/auth/mfa", { challengeId: challenge.data.challengeId, code: "000000" });
    expect(wrong.code).toBe(401);

    const ok = await http(app, "POST", "/v1/auth/mfa", {
      challengeId: challenge.data.challengeId,
      code: totpAt(secret, Math.floor(Date.now() / 1000)),
    });
    expect(ok.code).toBe(200);
    expect((ok.json as { refreshToken: string }).refreshToken).toBeTruthy();

    const again = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    const both = await http(app, "POST", "/v1/auth/mfa", {
      challengeId: (again.json as { data: { challengeId: string } }).data.challengeId,
      code: totpAt(secret, Math.floor(Date.now() / 1000)),
      backupCode: backups[0],
    });
    expect(both.code).toBe(200);
    const still = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    const backupLogin = await http(app, "POST", "/v1/auth/mfa", {
      challengeId: (still.json as { data: { challengeId: string } }).data.challengeId,
      backupCode: backups[0],
    });
    expect(backupLogin.code).toBe(200);
  });

  it("passkey finish stores one credential; finish without ceremony fails", async () => {
    const email = "key@example.com";
    await registerAndVerify(app, mailer, email);
    const login = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    const token = (login.json as { accessToken: string }).accessToken;
    const start = await http(app, "POST", "/v1/me/passkeys/register/start", {}, token);
    const challenge = (start.json as { data: { challenge: string } }).data.challenge;
    const empty = await http(app, "POST", "/v1/me/passkeys/register/finish", {}, token);
    expect(empty.code).toBe(400);
    const padded = Buffer.from(JSON.stringify({
      challenge: challenge.replace(/-/g, "+").replace(/_/g, "/"),
      type: "webauthn.create",
      origin: "http://localhost",
    })).toString("base64url");
    const finish = await http(app, "POST", "/v1/me/passkeys/register/finish", { id: "cred-1", clientDataJSON: padded }, token);
    expect(finish.code).toBe(201);
    const stored = await harness.db.collection("webauthn_credentials").countDocuments({ credentialId: "cred-1" });
    expect(stored).toBe(1);
  });
});

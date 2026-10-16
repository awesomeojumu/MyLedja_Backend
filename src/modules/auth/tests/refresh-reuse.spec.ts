import { INestApplication } from "@nestjs/common";
import { CaptureMailer } from "../domain/mailer";
import { SECURITY_EVENTS_COLLECTION } from "../schemas/security-event";
import { http, registerAndVerify, startAuthApp, TEST_PASSWORD, TestApp } from "./test-app";

jest.setTimeout(120_000);

describe("TC-17 refresh reuse", () => {
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

  it("revokes the family when a used refresh token is presented again", async () => {
    const email = "reuse@example.com";
    const { userId } = await registerAndVerify(app, mailer, email);
    const login = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    const first = login.json as { refreshToken: string };
    const rotated = await http(app, "POST", "/v1/auth/refresh", { refreshToken: first.refreshToken });
    expect(rotated.code).toBe(200);
    const second = rotated.json as { refreshToken: string };

    const replay = await http(app, "POST", "/v1/auth/refresh", { refreshToken: first.refreshToken });
    expect(replay.code).toBe(401);

    const after = await http(app, "POST", "/v1/auth/refresh", { refreshToken: second.refreshToken });
    expect(after.code).toBe(401);

    const events = await harness.db.collection(SECURITY_EVENTS_COLLECTION).find({}).toArray();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "refresh_reuse", userId }),
      ]),
    );
  });
});

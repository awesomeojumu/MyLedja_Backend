import { INestApplication } from "@nestjs/common";
import { CaptureMailer } from "../domain/mailer";
import { http, registerAndVerify, startAuthApp, TestApp } from "./test-app";

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

  it("returns the same body whether the account exists or not", async () => {
    const email = "known@example.com";
    await registerAndVerify(app, mailer, email);
    const missing = await http(app, "POST", "/v1/auth/recovery", { email: "nobody@example.com" });
    const exists = await http(app, "POST", "/v1/auth/recovery", { email });
    expect(missing.code).toBe(202);
    expect(exists.code).toBe(202);
    expect(missing.json).toEqual({ status: "accepted" });
    expect(exists.json).toEqual(missing.json);
  });
});

import { INestApplication } from "@nestjs/common";
import { http, startAuthApp, TestApp } from "@/modules/auth/tests/test-app";

jest.setTimeout(120_000);

describe("rate limits", () => {
  let harness: TestApp;
  let app: INestApplication;

  beforeAll(async () => {
    harness = await startAuthApp();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("returns 429 after repeated login failures", async () => {
    const body = { email: "brute@example.com", password: "wrong-password-long" };
    for (let i = 0; i < 5; i += 1) {
      const attempt = await http(app, "POST", "/v1/auth/login", body);
      expect(attempt.code).toBe(401);
    }
    const limited = await http(app, "POST", "/v1/auth/login", body);
    expect(limited.code).toBe(429);
    expect(limited.json).toEqual({ status: "error", error: "too many attempts" });
  });

  it("limits recovery requests per email", async () => {
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      last = (await http(app, "POST", "/v1/auth/recovery", { email: "flood@example.com" })).code;
    }
    expect(last).toBe(429);
  });
});

describe("rate limits behind a spoofed X-Forwarded-For", () => {
  let harness: TestApp;
  let app: INestApplication;

  beforeAll(async () => {
    harness = await startAuthApp();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("is not bypassed by a spoofed X-Forwarded-For header", async () => {
    const body = { email: "spoof@example.com", password: "wrong-password-long" };
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(`${await app.getUrl()}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}` },
        body: JSON.stringify({ ...body, email: `spoof${i}@example.com` }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

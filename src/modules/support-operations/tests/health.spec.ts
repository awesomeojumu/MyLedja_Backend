import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MONGO_DB } from "../../../database/mongo/mongo.constants";
import { HealthController } from "../controllers/health.controller";
import { checkHealth } from "../domain/health";

describe("checkHealth", () => {
  it("reports up when the database answers", async () => {
    await expect(checkHealth(async () => ({ ok: 1 }))).resolves.toEqual({ status: "ok", database: "up" });
  });

  it("reports down without the error text", async () => {
    const result = await checkHealth(async () => {
      throw new Error("connect ECONNREFUSED cluster0.example.mongodb.net");
    });
    expect(result).toEqual({ status: "error", database: "down" });
  });
});

describe("GET /health", () => {
  let app: INestApplication;
  let ping: jest.Mock;

  beforeAll(async () => {
    ping = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: MONGO_DB, useValue: { command: ping } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function get(): Promise<{ code: number; text: string }> {
    const res = await fetch(`${await app.getUrl()}/health`);
    return { code: res.status, text: await res.text() };
  }

  it("returns 200 with only status fields", async () => {
    ping.mockResolvedValueOnce({ ok: 1 });
    const { code, text } = await get();
    expect(code).toBe(200);
    expect(JSON.parse(text)).toEqual({ status: "ok", database: "up" });
  });

  it("returns 503 without leaking sensitive details when the database is down", async () => {
    ping.mockRejectedValueOnce(new Error("auth failed for db-user-42 at cluster0.example.mongodb.net"));
    const { code, text } = await get();
    expect(code).toBe(503);
    expect(JSON.parse(text)).toEqual({ status: "error", database: "down" });
    expect(text).not.toMatch(/mongodb|cluster0|db-user-42|env|password|stack/i);
  });
});

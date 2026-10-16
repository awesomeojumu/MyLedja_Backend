import { loadConfig } from "./env";

describe("loadConfig", () => {
  it("loads development defaults", () => {
    const config = loadConfig({ APP_ENV: "development" });
    expect(config.appEnv).toBe("development");
    expect(config.port).toBe(4000);
  });

  it("loads staging", () => {
    const config = loadConfig({
      APP_ENV: "staging",
      PORT: "4100",
      APP_URL: "https://staging.example.com",
    });
    expect(config.appEnv).toBe("staging");
    expect(config.port).toBe(4100);
    expect(config.appUrl).toBe("https://staging.example.com");
  });

  it("refuses production without JWT_SECRET", () => {
    expect(() => loadConfig({ APP_ENV: "production", MONGODB_URI: "mongodb://localhost:27017" })).toThrow(
      "JWT_SECRET is required in production",
    );
  });

  it("accepts production with a long JWT_SECRET", () => {
    const config = loadConfig({
      APP_ENV: "production",
      JWT_SECRET: "a".repeat(32),
      MONGODB_URI: "mongodb://localhost:27017",
    });
    expect(config.appEnv).toBe("production");
  });
});

describe("loadConfig database settings", () => {
  it("reads MONGODB_URI and defaults the database name", () => {
    const config = loadConfig({ MONGODB_URI: "mongodb://localhost:27017" });
    expect(config.mongodbUri).toBe("mongodb://localhost:27017");
    expect(config.mongodbDb).toBe("MyLedja");
  });

  it("refuses production without MONGODB_URI", () => {
    expect(() => loadConfig({ APP_ENV: "production", JWT_SECRET: "a".repeat(32) })).toThrow(
      "MONGODB_URI is required in production",
    );
  });
});

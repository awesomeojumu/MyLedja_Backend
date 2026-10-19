import { loadConfig } from "@/config/env";

describe("loadConfig", () => {
  it("loads development defaults", () => {
    const config = loadConfig({ APP_ENV: "development" });
    expect(config.appEnv).toBe("development");
    expect(config.port).toBe(4000);
    expect(config.accountNumberKey.length).toBe(64);
  });

  it("loads staging", () => {
    const config = loadConfig({
      APP_ENV: "staging",
      PORT: "4100",
      APP_URL: "https://staging.example.com",
      JWT_SECRET: "a".repeat(32),
      MONGODB_URI: "mongodb://localhost:27017",
      ACCOUNT_NUMBER_KEY: "ab".repeat(32),
    });
    expect(config.appEnv).toBe("staging");
    expect(config.port).toBe(4100);
    expect(config.appUrl).toBe("https://staging.example.com");
  });

  it("uses RENDER_EXTERNAL_URL when APP_URL is unset", () => {
    const config = loadConfig({ RENDER_EXTERNAL_URL: "https://myledja-api-staging.onrender.com" });
    expect(config.appUrl).toBe("https://myledja-api-staging.onrender.com");
  });

  it("refuses staging without JWT_SECRET or MONGODB_URI", () => {
    expect(() =>
      loadConfig({ APP_ENV: "staging", ACCOUNT_NUMBER_KEY: "ab".repeat(32) }),
    ).toThrow("JWT_SECRET is required in staging and production");
    expect(() =>
      loadConfig({
        APP_ENV: "staging",
        JWT_SECRET: "a".repeat(32),
        ACCOUNT_NUMBER_KEY: "ab".repeat(32),
      }),
    ).toThrow("MONGODB_URI is required in staging and production");
  });

  it("refuses production without JWT_SECRET", () => {
    expect(() => loadConfig({ APP_ENV: "production", MONGODB_URI: "mongodb://localhost:27017" })).toThrow(
      "JWT_SECRET is required in staging and production",
    );
  });

  it("accepts production with a long JWT_SECRET", () => {
    const config = loadConfig({
      APP_ENV: "production",
      JWT_SECRET: "a".repeat(32),
      MONGODB_URI: "mongodb://localhost:27017",
      ACCOUNT_NUMBER_KEY: "ab".repeat(32),
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
      "MONGODB_URI is required in staging and production",
    );
  });
});

describe("loadConfig Mono settings", () => {
  it("reads sandbox keys without logging them", () => {
    const config = loadConfig({
      MONO_SEC_KEY: "test_sk_example",
      MONO_PUBLIC_KEY: "test_pk_example",
      MONO_APP_ID: "6a2800772814c9ea0ed20b5e",
    });
    expect(config.monoSecKey).toBe("test_sk_example");
    expect(config.monoPublicKey).toBe("test_pk_example");
    expect(config.monoAppId).toBe("6a2800772814c9ea0ed20b5e");
  });

  it("defaults Mono settings to empty", () => {
    const config = loadConfig({});
    expect(config.monoSecKey).toBe("");
    expect(config.monoAppId).toBe("");
  });
});

describe("loadConfig account number key", () => {
  it("refuses staging without ACCOUNT_NUMBER_KEY", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "staging",
        JWT_SECRET: "a".repeat(32),
        MONGODB_URI: "mongodb://localhost:27017",
      }),
    ).toThrow("ACCOUNT_NUMBER_KEY is required");
  });

  it("accepts a 64-character hex key", () => {
    const key = "ab".repeat(32);
    expect(loadConfig({ ACCOUNT_NUMBER_KEY: key }).accountNumberKey).toBe(key);
  });
});

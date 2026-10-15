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
    expect(() => loadConfig({ APP_ENV: "production" })).toThrow(
      "JWT_SECRET is required in production",
    );
  });

  it("accepts production with a long JWT_SECRET", () => {
    const config = loadConfig({
      APP_ENV: "production",
      JWT_SECRET: "a".repeat(32),
    });
    expect(config.appEnv).toBe("production");
  });
});

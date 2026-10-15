import { healthStatus } from "./health";

describe("healthStatus", () => {
  it("returns ok and the current env", () => {
    process.env.APP_ENV = "test";
    expect(healthStatus()).toEqual({ ok: true, env: "test" });
  });
});

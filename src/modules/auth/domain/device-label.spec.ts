import { deviceLabelFromUa } from "@/modules/auth/domain/device-label";

describe("deviceLabelFromUa", () => {
  it("names browsers and phones", () => {
    expect(deviceLabelFromUa("Mozilla/5.0 Chrome")).toBe("This browser");
    expect(deviceLabelFromUa("Mozilla/5.0 (iPhone; CPU iPhone OS)")).toBe("This phone");
    expect(deviceLabelFromUa("")).toBe("This device");
  });
});

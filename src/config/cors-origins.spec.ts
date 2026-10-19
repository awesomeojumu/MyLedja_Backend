import { isAllowedCorsOrigin } from "@/config/cors-origins";

describe("isAllowedCorsOrigin", () => {
  const extra = ["https://myledja-web.vercel.app", "https://app.myledja.com"];

  it("allows only origins listed in CORS_ORIGINS", () => {
    expect(isAllowedCorsOrigin("https://myledja-web.vercel.app", extra)).toBe(true);
    expect(isAllowedCorsOrigin("https://app.myledja.com", extra)).toBe(true);
  });

  it("rejects hosts that are not listed", () => {
    expect(isAllowedCorsOrigin("https://myledja-app.vercel.app", extra)).toBe(false);
    expect(isAllowedCorsOrigin("https://evil.example", extra)).toBe(false);
  });
});

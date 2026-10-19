import { isAllowedCorsOrigin } from "@/config/cors-origins";

describe("isAllowedCorsOrigin", () => {
  const extra = ["https://myledja-web.vercel.app"];

  it("allows the production app host", () => {
    expect(isAllowedCorsOrigin("https://app.myledja.com", extra)).toBe(true);
  });

  it("allows the production Vercel project and its aliases", () => {
    expect(isAllowedCorsOrigin("https://myledja-app.vercel.app", extra)).toBe(true);
    expect(
      isAllowedCorsOrigin("https://myledja-app-planexiglobalconsults-projects.vercel.app", extra),
    ).toBe(true);
  });

  it("allows the staging Vercel project", () => {
    expect(isAllowedCorsOrigin("https://myledja-web.vercel.app", extra)).toBe(true);
  });

  it("rejects other sites", () => {
    expect(isAllowedCorsOrigin("https://evil.example", extra)).toBe(false);
    expect(isAllowedCorsOrigin("https://myledja-app.vercel.app.evil.example", extra)).toBe(false);
  });
});

import { http, registerAndVerify, TEST_PASSWORD } from "@/modules/auth/tests/test-app";
import { BANK_CONNECTIONS_COLLECTION } from "@/modules/bank-integrations/schemas/bank-connection";
import { startLinkApp } from "@/modules/bank-integrations/tests/test-app";

jest.setTimeout(120_000);

describe("bank-integrations link", () => {
  it("starts linking and completes without posting a ledger row", async () => {
    const ctx = await startLinkApp();
    try {
      const { workspaceId } = await registerAndVerify(ctx.app, ctx.mailer, "ada@myledja.com");
      const login = await http(ctx.app, "POST", "/v1/auth/login", { email: "ada@myledja.com", password: TEST_PASSWORD });
      const token = (login.json as { accessToken: string }).accessToken;

      const unauth = await http(ctx.app, "POST", "/v1/bank-integrations/link", {});
      expect(unauth.code).toBe(401);

      const started = await http(ctx.app, "POST", "/v1/bank-integrations/link", { workspaceId }, token);
      expect(started.code).toBe(200);
      expect(started.json).toEqual({ status: "ok", data: { monoUrl: "https://connect.mono.co/sandbox" } });
      expect(ctx.monoCalls[0]?.url).toContain("/v2/accounts/initiate");
      const initiateBody = ctx.monoCalls[0]?.body as { redirect_url: string; scope: string; customer: { email: string } };
      expect(initiateBody.redirect_url).toBe("https://mono.co");
      expect(initiateBody.scope).toBe("auth");
      expect(initiateBody.customer.email).toBe("ada@myledja.com");

      const missing = await http(ctx.app, "POST", "/v1/bank-integrations/link/complete", {}, token);
      expect(missing.code).toBe(400);

      const done = await http(ctx.app, "POST", "/v1/bank-integrations/link/complete", { code: "sandbox-code", workspaceId }, token);
      expect(done.code).toBe(200);
      expect(done.json).toEqual({
        status: "ok",
        data: {
          provider: "mono",
          institution: "GTBank",
          name: "Ada Okonkwo",
          mask: "3465",
          balance: 20000,
          currency: "NGN",
        },
      });
      const stored = await ctx.db.collection(BANK_CONNECTIONS_COLLECTION).find().toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        workspaceId,
        provider: "mono",
        monoAppId: "6a2800772814c9ea0ed20b5e",
        monoAccountId: "acc_gtb",
        institution: "GTBank",
        mask: "3465",
      });
      expect(stored[0]).not.toHaveProperty("transactions");
    } finally {
      await ctx.stop();
    }
  }, 60000);

  it("returns 503 when Mono is not configured", async () => {
    const ctx = await startLinkApp(undefined, { configured: false });
    try {
      await registerAndVerify(ctx.app, ctx.mailer, "ada@myledja.com");
      const login = await http(ctx.app, "POST", "/v1/auth/login", { email: "ada@myledja.com", password: TEST_PASSWORD });
      const token = (login.json as { accessToken: string }).accessToken;
      const started = await http(ctx.app, "POST", "/v1/bank-integrations/link", {}, token);
      expect(started.code).toBe(503);
    } finally {
      await ctx.stop();
    }
  }, 60000);
});

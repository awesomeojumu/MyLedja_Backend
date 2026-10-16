import { customerNameFromEmail, linkReference } from "../domain/customer-name";
import { MonoClient } from "../domain/mono-client";
import { MonoFailure } from "../domain/mono-failure";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("customerNameFromEmail", () => {
  it("uses the local part", () => {
    expect(customerNameFromEmail("ada@myledja.com")).toBe("ada");
  });
});

describe("linkReference", () => {
  it("is at least 10 characters", () => {
    expect(linkReference("ws-1", new Date("2026-10-16T00:00:00Z")).length).toBeGreaterThanOrEqual(10);
  });
});

describe("MonoClient", () => {
  const calls: { url: string; method: string; headers: HeadersInit; body: string | undefined }[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  function client(handler: (url: string, init: RequestInit) => Promise<Response>): MonoClient {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return handler(url, init ?? {});
    };
    return new MonoClient("test_sk_fake", fetchImpl, "https://api.withmono.com");
  }

  it("refuses to call Mono without a secret", async () => {
    const empty = new MonoClient("", globalThis.fetch);
    await expect(empty.initiate({ name: "Ada", email: "ada@x.com", ref: "myl1234567890", redirectUrl: "https://mono.co" })).rejects.toBeInstanceOf(
      MonoFailure,
    );
  });

  it("initiates linking with the secret header and returns mono_url", async () => {
    const mono = client(async () => jsonResponse(200, { data: { mono_url: "https://connect.mono.co/abc" } }));
    const url = await mono.initiate({
      name: "Ada",
      email: "ada@x.com",
      ref: "myl1234567890",
      redirectUrl: "https://mono.co",
    });
    expect(url).toBe("https://connect.mono.co/abc");
    expect(calls[0]?.url).toBe("https://api.withmono.com/v2/accounts/initiate");
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers["mono-sec-key"]).toBe("test_sk_fake");
    const body = JSON.parse(calls[0]?.body ?? "{}") as { scope: string; redirect_url: string };
    expect(body.scope).toBe("auth");
    expect(body.redirect_url).toBe("https://mono.co");
  });

  it("exchanges a code for an account id", async () => {
    const mono = client(async () => jsonResponse(200, { id: "acc_gtb" }));
    await expect(mono.exchange("code-1")).resolves.toBe("acc_gtb");
  });

  it("reads institution, mask and balance", async () => {
    const mono = client(async () =>
      jsonResponse(200, {
        account: {
          id: "acc_gtb",
          name: "Ada Okonkwo",
          accountNumber: "0131883465",
          balance: 20000,
          currency: "NGN",
          institution: { name: "GTBank" },
        },
      }),
    );
    const details = await mono.account("acc_gtb");
    expect(details.institution).toBe("GTBank");
    expect(details.mask).toBe("3465");
    expect(details.balance).toBe(20000);
  });

  it("maps Mono HTTP errors to a generic upstream failure", async () => {
    const mono = client(async () => jsonResponse(401, { message: "invalid key test_sk_fake" }));
    await expect(mono.exchange("bad")).rejects.toMatchObject({ status: "upstream" });
  });
});

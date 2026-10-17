import { MonoFailure } from "@/modules/bank-integrations/domain/mono-failure";

export const MONO_BASE_URL = "https://api.withmono.com";
export const MONO_FETCH = Symbol("MONO_FETCH");

export type FetchLike = typeof fetch;

export interface MonoAccountDetails {
  id: string;
  name: string;
  mask: string;
  institution: string;
  balance: number;
  currency: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nested(value: unknown, key: string): Record<string, unknown> {
  return asRecord(asRecord(value)[key] ?? asRecord(value).data);
}

export class MonoClient {
  constructor(
    private readonly secKey: string,
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string = MONO_BASE_URL,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.secKey) {
      throw new MonoFailure("misconfigured", "Bank linking is not set up on this server.");
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "mono-sec-key": this.secKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new MonoFailure("upstream", "Could not reach Mono. Try again.");
    }
    const text = await res.text();
    if (res.status >= 400) {
      throw new MonoFailure("upstream", "Mono could not complete that step.");
    }
    try {
      return text.length > 0 ? JSON.parse(text) : null;
    } catch {
      throw new MonoFailure("upstream", "Mono could not complete that step.");
    }
  }

  async initiate(input: { name: string; email: string; ref: string; redirectUrl: string }): Promise<string> {
    const json = await this.call("POST", "/v2/accounts/initiate", {
      customer: { name: input.name, email: input.email },
      meta: { ref: input.ref },
      scope: "auth",
      redirect_url: input.redirectUrl,
    });
    const data = nested(json, "data");
    const url = data.mono_url ?? data.monoUrl ?? asRecord(json).mono_url;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new MonoFailure("upstream", "Mono could not start that link.");
    }
    return url;
  }

  async exchange(code: string): Promise<string> {
    const json = await this.call("POST", "/v2/accounts/auth", { code });
    const data = nested(json, "data");
    const id = data.id ?? asRecord(json).id;
    if (typeof id !== "string" || id.length === 0) {
      throw new MonoFailure("upstream", "Mono could not finish that link.");
    }
    return id;
  }

  async account(id: string): Promise<MonoAccountDetails> {
    const json = await this.call("GET", `/v2/accounts/${id}`);
    const account = nested(json, "account");
    const institution = asRecord(account.institution);
    const number = String(account.accountNumber ?? account.account_number ?? "");
    const mask = number.length >= 4 ? number.slice(-4) : number;
    const balanceRaw = account.balance;
    const balance = typeof balanceRaw === "number" ? balanceRaw : Number(balanceRaw ?? 0);
    return {
      id: String(account._id ?? account.id ?? id),
      name: String(account.name ?? "Linked account"),
      mask,
      institution: String(institution.name ?? "Bank"),
      balance: Number.isFinite(balance) ? balance : 0,
      currency: String(account.currency ?? "NGN"),
    };
  }
}

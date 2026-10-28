import type { AppConfig } from '../../config/config.schema.js';

type MonoConfig = NonNullable<AppConfig['mono']>;

export type BankTransaction = {
  id: string;
  date: string;
  narration: string;
  amountMinor: bigint;
  balanceMinor: bigint | null;
};
export type BankAccount = {
  id: string;
  name: string;
  institution: string;
  last4: string | null;
  balanceMinor: bigint | null;
  currency: string;
};

/** The bank-provider interface (TECH-SPEC 5.2 `banking`): Mono first, others later behind the same shape. */
export interface BankProvider {
  exchange(code: string): Promise<string>;
  account(providerAccountId: string): Promise<BankAccount>;
  transactions(providerAccountId: string, since: string): Promise<BankTransaction[]>;
  requestSync(providerAccountId: string): Promise<void>;
  /** A one-time token for reopening the provider's screen when consent has lapsed. */
  reauthToken(providerAccountId: string): Promise<string>;
  unlink(providerAccountId: string): Promise<void>;
}

const BASE = 'https://api.withmono.com/v2';

/** Mono Connect (Nigeria). The secret key stays on the server; amounts come back in kobo. */
export class MonoProvider implements BankProvider {
  constructor(
    private readonly config: MonoConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        'mono-sec-key': this.config.secretKey,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`mono_${res.status}`);
    return (await res.json()) as T;
  }

  async exchange(code: string): Promise<string> {
    const r = await this.call<{ data?: { id?: string }; id?: string }>('POST', '/accounts/auth', { code });
    const id = r.data?.id ?? r.id;
    if (!id) throw new Error('mono_no_account');
    return id;
  }

  async account(id: string): Promise<BankAccount> {
    const r = await this.call<{
      data: {
        account: {
          name?: string;
          account_number?: string;
          balance?: number;
          currency?: string;
          institution?: { name?: string };
        };
      };
    }>('GET', `/accounts/${id}`);
    const a = r.data.account;
    return {
      id,
      name: a.name ?? 'Bank account',
      institution: a.institution?.name ?? 'Bank',
      // Only the last 4 digits are ever kept (TECH-SPEC 10).
      last4: a.account_number ? a.account_number.slice(-4) : null,
      balanceMinor: typeof a.balance === 'number' ? BigInt(Math.trunc(a.balance)) : null,
      currency: a.currency ?? 'NGN',
    };
  }

  async transactions(id: string, since: string): Promise<BankTransaction[]> {
    const out: BankTransaction[] = [];
    const end = new Date().toISOString().slice(0, 10);
    for (let page = 1; page <= 20; page++) {
      const r = await this.call<{
        data: {
          id: string;
          date: string;
          narration: string;
          amount: number;
          type: 'debit' | 'credit';
          balance?: number;
        }[];
        meta?: { next?: string | null };
      }>('GET', `/accounts/${id}/transactions?start=${since}&end=${end}&page=${page}`);
      for (const t of r.data) {
        const size = BigInt(Math.trunc(Math.abs(t.amount)));
        out.push({
          id: t.id,
          date: t.date.slice(0, 10),
          narration: t.narration,
          amountMinor: t.type === 'credit' ? size : -size,
          balanceMinor: typeof t.balance === 'number' ? BigInt(Math.trunc(t.balance)) : null,
        });
      }
      if (!r.meta?.next) break;
    }
    return out;
  }

  async requestSync(id: string): Promise<void> {
    await this.call('POST', `/accounts/${id}/sync`).catch(() => undefined);
  }

  async reauthToken(id: string): Promise<string> {
    const r = await this.call<{ data?: { token?: string }; token?: string }>('POST', `/accounts/${id}/reauthorise`);
    const token = r.data?.token ?? r.token;
    if (!token) throw new Error('mono_no_token');
    return token;
  }

  async unlink(id: string): Promise<void> {
    await this.call('POST', `/accounts/${id}/unlink`);
  }
}

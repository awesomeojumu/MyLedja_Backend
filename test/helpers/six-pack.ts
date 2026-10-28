import { describe, expect, it } from 'vitest';
import { addMember, op, signUp, twoWorkspaces, type SignedIn, type TestApp } from './test-app.js';

export type InjectRes = Awaited<ReturnType<TestApp['app']['inject']>>;

export type Prepared = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  payload?: object;
  /** Expected success status (default 200). */
  status?: number;
  assert?: (res: InjectRes) => void | Promise<void>;
  /** Body that must 400; when omitted on a write, missing X-Operation-Id is used. */
  badPayload?: object;
  /** Alternate URL that must 400 (bad query / path). */
  badUrl?: string;
};

/**
 * BUILD-PLAN 3.3 six tests for one workspace endpoint.
 * Reads get works / input / 401 / cross-workspace 404.
 * Writes also get Viewer 403 and operationId runs-once.
 */
export function sixPack(
  title: string,
  opts: {
    t: () => TestApp;
    write: boolean;
    prepare: (owner: SignedIn) => Promise<Prepared>;
  },
) {
  const app = () => opts.t().app;

  const send = (p: Prepared, auth: Record<string, string>, headers: Record<string, string> = {}) =>
    app().inject({
      method: p.method,
      url: p.url,
      headers: { ...auth, ...headers },
      payload: p.payload,
    });

  describe(title, () => {
    it('works', async () => {
      const owner = await signUp(opts.t());
      const p = await opts.prepare(owner);
      const res = await send(p, owner.auth, opts.write ? op() : {});
      expect(res.statusCode).toBe(p.status ?? 200);
      await p.assert?.(res);
    });

    it('checks input', async () => {
      const owner = await signUp(opts.t());
      const p = await opts.prepare(owner);
      if (p.badUrl) {
        const res = await app().inject({
          method: p.method,
          url: p.badUrl,
          headers: { ...owner.auth, ...(opts.write ? op() : {}) },
          payload: p.payload,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'invalid_input' });
        return;
      }
      if (p.badPayload !== undefined) {
        const res = await app().inject({
          method: p.method,
          url: p.url,
          headers: { ...owner.auth, ...(opts.write ? op() : {}) },
          payload: p.badPayload,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('invalid_input');
        return;
      }
      if (opts.write) {
        const res = await send(p, owner.auth, {});
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('operation_id_missing');
        return;
      }
      // Read with only workspaceId: malformed id is not found (same as workspaces.api.test).
      const res = await app().inject({
        method: p.method,
        url: p.url.replace(owner.workspaceId, 'not-a-uuid'),
        headers: owner.auth,
      });
      expect(res.statusCode).toBe(404);
    });

    it('needs sign-in', async () => {
      const owner = await signUp(opts.t());
      const p = await opts.prepare(owner);
      const res = await send(p, {}, opts.write ? op() : {});
      expect(res.statusCode).toBe(401);
    });

    it("stays in its workspace: B gets 404 for A's data", async () => {
      const { a, b } = await twoWorkspaces(opts.t());
      const p = await opts.prepare(a);
      const res = await send(p, b.auth, opts.write ? op() : {});
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('not_found');
    });

    if (opts.write) {
      it('respects roles: a Viewer gets 403', async () => {
        const { a, b } = await twoWorkspaces(opts.t());
        await addMember(opts.t(), a.workspaceId, b.userId, 'viewer');
        const p = await opts.prepare(a);
        const res = await send(p, b.auth, op());
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({
          code: 'forbidden',
          message: "Your role in this workspace doesn't allow this.",
        });
      });

      it('runs once: the same operationId returns the first result', async () => {
        const owner = await signUp(opts.t());
        const p = await opts.prepare(owner);
        const headers = op();
        const first = await send(p, owner.auth, headers);
        const second = await send(p, owner.auth, headers);
        expect(first.statusCode).toBe(p.status ?? 200);
        expect(second.statusCode).toBe(first.statusCode);
        expect(second.body).toBe(first.body);
      });
    }
  });
}

/** Create a bank account (+ optional second) and resolve a spending category over HTTP. */
export async function moneyWorld(t: TestApp, owner: SignedIn, extra: { secondAccount?: boolean } = {}) {
  const base = `/v1/workspaces/${owner.workspaceId}`;
  const account = (
    await t.app.inject({
      method: 'POST',
      url: `${base}/accounts`,
      headers: { ...owner.auth, ...op() },
      payload: {
        type: 'bank',
        name: `Bank ${Date.now()}`,
        openingBalance: '10000000',
        openingDate: '2026-10-01',
      },
    })
  ).json();
  let account2: { id: string; version: number } | undefined;
  if (extra.secondAccount) {
    account2 = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/accounts`,
        headers: { ...owner.auth, ...op() },
        payload: { type: 'bank', name: `Bank2 ${Date.now()}`, openingBalance: '0', openingDate: '2026-10-01' },
      })
    ).json();
  }
  const tree = (await t.app.inject({ method: 'GET', url: `${base}/categories`, headers: owner.auth })).json();
  const other = tree.groups.find((g: { name: string }) => g.name === 'Other')!;
  const income = tree.groups.find((g: { name: string; kind: string }) => g.kind === 'income')!;
  const fees = tree.categories.find((c: { starterKey: string }) => c.starterKey === 'fees')!;
  const uncategorized = tree.categories.find((c: { starterKey: string }) => c.starterKey === 'uncategorized')!;
  const otherIncome = tree.categories.find((c: { starterKey: string }) => c.starterKey === 'other_income')!;
  return { base, account, account2, tree, other, income, fees, uncategorized, otherIncome };
}

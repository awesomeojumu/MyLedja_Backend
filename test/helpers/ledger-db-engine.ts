import { v7 as uuidv7 } from 'uuid';
import type { WorkspaceContext } from '../../src/common/workspace/workspace-context.js';
import { toRef, type TransactionDoc } from '../../src/modules/ledger/ledger.repository.js';
import type { AccountRef } from '../../src/modules/ledger/ledger.types.js';
import type { CasesFile, Engine, EngineEvent } from './ledger-cases.js';
import { newWorkspace, type TestApp } from './test-app.js';

const asEvent = (e: TransactionDoc): EngineEvent => ({
  id: e._id,
  type: e.type,
  status: e.status,
  date: e.date,
  lines: e.lines,
});

/** A fresh person and workspace with the cases' accounts and categories, posting through the real ledger. */
export async function dbEngine(t: TestApp, file: CasesFile): Promise<Engine & { ctx: WorkspaceContext }> {
  const { ctx } = await newWorkspace(t);
  const ledger = t.services.ledger;
  const ledgerIds = new Map<string, string>();
  const realIds = new Map<string, string>();
  const categoryIds = new Map<string, string>();
  for (const a of file.accounts) {
    const doc = await ledger.openAccount(ctx, {
      kind: a.kind as 'asset' | 'liability',
      accountType: a.accountType as never,
      name: a.name,
      currency: file.currency,
    });
    realIds.set(a.key, doc._id);
    ledgerIds.set(a.key, doc._id);
  }
  for (const c of file.categories) {
    if (c.system) {
      const linked = await ledger.accounts.findOne(ctx, { systemKey: c.system, categoryId: { $ne: null } });
      if (linked) {
        categoryIds.set(c.key, linked.categoryId!);
        continue;
      }
    }
    const categoryId = uuidv7();
    categoryIds.set(c.key, categoryId);
    if (c.system) await ledger.linkSystemCategory(ctx, c.system, categoryId);
    else await ledger.ensureCategoryAccount(ctx, { categoryId, kind: c.kind, name: c.name, currency: file.currency });
  }
  const all = await ledger.accounts.find(ctx, {});
  const refs = new Map<string, AccountRef>(all.map((a) => [a._id, toRef(a)]));
  for (const a of all) {
    if (a.systemKey) ledgerIds.set(`system:${a.systemKey}`, a._id);
    const key = [...categoryIds].find(([, id]) => id === a.categoryId)?.[0];
    if (key) ledgerIds.set(key, a._id);
  }
  return {
    ctx,
    ledgerIds,
    realIds,
    categoryIds,
    refs,
    async post(input, operationId) {
      const { event, duplicate } = await ledger.post(ctx, input, { operationId });
      return { event: asEvent(event), duplicate };
    },
    async correct(id, input, operationId) {
      const r = await ledger.correct(ctx, id, input, { operationId });
      return { reversal: asEvent(r.reversal), event: asEvent(r.event) };
    },
    async reverse(id, operationId) {
      return asEvent((await ledger.reverse(ctx, id, { operationId })).event);
    },
    async events() {
      return (await ledger.transactions.find(ctx, {}, { sort: { recordedAt: 1, _id: 1 } })).map(asEvent);
    },
  };
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { systemContext, type WorkspaceContext } from '../../../common/workspace/workspace-context.js';
import { loadCases, runCase } from '../../../../test/helpers/ledger-cases.js';
import { dbEngine } from '../../../../test/helpers/ledger-db-engine.js';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';
import { balances, periodTotals } from '../read.js';
import { SYSTEM_KEYS } from '../ledger.types.js';
import type { LedgerService } from '../ledger.service.js';

const file = loadCases();
let t: TestApp;
let ledger: LedgerService;

beforeAll(async () => {
  t = await startTestApp({ CONTACT_EMAIL: 'ops@example.test' });
  ledger = t.services.ledger;
});
afterAll(() => t.close());

async function workspace(name = 'Ledger') {
  void name;
  const { ctx } = await newWorkspace(t);
  const bank = await ledger.openAccount(ctx, { kind: 'asset', accountType: 'bank', name: 'GTBank', currency: 'NGN' });
  const food = await ledger.ensureCategoryAccount(ctx, {
    categoryId: uuidv7(),
    kind: 'expense',
    name: 'Food',
    currency: 'NGN',
  });
  return { ctx, bank, food, foodId: food.categoryId! };
}

const expense = (accountId: string, categoryId: string, amount = '1845000', date = '2026-10-12') =>
  ({ type: 'expense', accountId, categoryId, amount, date }) as const;

describe('ledger cases through postEvent and MongoDB (B1.5)', () => {
  for (const c of file.cases) {
    it(`case ${c.id}: ${c.title}`, async () => {
      const engine = await dbEngine(t, file);
      await runCase(c, file, engine);
      const events = await engine.events();
      const stored = await ledger.balances.all(engine.ctx);
      const fromLines = balances(events);
      for (const b of stored)
        expect(b.balanceMinor, `stored balance ${b.ledgerAccountId}`).toBe(fromLines.get(b.ledgerAccountId) ?? 0n);
      const totals = await ledger.totals.find(engine.ctx, {});
      const expected = periodTotals(events);
      for (const want of expected) {
        const row = totals.find((x) => x.ledgerAccountId === want.ledgerAccountId && x.month === want.month);
        expect(row?.debitsMinor).toBe(want.debitsMinor);
        expect(row?.creditsMinor).toBe(want.creditsMinor);
      }
    });
  }
});

describe('system accounts (B1.1)', () => {
  it('seeds each system account once per workspace, and seeding again changes nothing', async () => {
    const { ctx } = await workspace();
    const first = await ledger.accounts.system(ctx);
    expect(first.map((a) => a.systemKey).sort()).toEqual([...SYSTEM_KEYS].sort());
    await ledger.seedSystemAccounts(ctx, 'NGN');
    await ledger.seedSystemAccounts(ctx, 'NGN');
    const again = await ledger.accounts.system(ctx);
    expect(again.map((a) => a._id).sort()).toEqual(first.map((a) => a._id).sort());
  });

  it('gives every category exactly one ledger account', async () => {
    const { ctx } = await workspace();
    const categoryId = uuidv7();
    const a = await ledger.ensureCategoryAccount(ctx, { categoryId, kind: 'expense', name: 'Food', currency: 'NGN' });
    const b = await ledger.ensureCategoryAccount(ctx, { categoryId, kind: 'expense', name: 'Food', currency: 'NGN' });
    expect(a._id).toBe(b._id);
    expect(await ledger.accounts.count(ctx, { categoryId })).toBe(1);
  });
});

describe('postEvent (B1.3)', () => {
  it('writes the event, balances, period totals, change feed and audit entry together', async () => {
    const { ctx, bank, food, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7(), deviceId: 'phone-1' });
    expect(event).toMatchObject({
      type: 'expense',
      status: 'posted',
      version: 1,
      recordedBy: { userId: ctx.userId, deviceId: 'phone-1' },
    });
    const [bal] = await ledger.balances.forAccounts(ctx, [bank._id]);
    expect(bal!.balanceMinor).toBe(-1845000n);
    const [total] = await ledger.totals.find(ctx, { ledgerAccountId: food._id });
    expect(total).toMatchObject({ month: '2026-10', debitsMinor: 1845000n, creditsMinor: 0n, count: 1 });
    const changes = await t.db.collection('changes').find({ workspaceId: ctx.workspaceId, docId: event._id }).toArray();
    expect(changes).toHaveLength(1);
    const audit = await t.db
      .collection('audit_events')
      .findOne({ workspaceId: ctx.workspaceId, 'target.id': event._id });
    expect(audit).toMatchObject({ action: 'transaction.posted', userId: ctx.userId });
  });

  it('stores amounts as 64-bit integers, never as floats', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId, '999999999999999999'), {
      operationId: uuidv7(),
    });
    const raw = await t.db
      .collection('transactions')
      .findOne({ _id: event._id as never }, { promoteLongs: false, useBigInt64: false });
    expect(raw!.lines[0].amountMinor._bsontype).toBe('Long');
    expect(raw!.lines[0].amountMinor.toString()).toBe('999999999999999999');
  });

  it('posts once when the same operationId is sent at the same moment from two places', async () => {
    const { ctx, bank, foodId } = await workspace();
    const operationId = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ledger.post(ctx, expense(bank._id, foodId), { operationId })),
    );
    expect(new Set(results.map((r) => r.event._id)).size).toBe(1);
    expect(await ledger.transactions.count(ctx, {})).toBe(1);
    const [bal] = await ledger.balances.forAccounts(ctx, [bank._id]);
    expect(bal!.balanceMinor).toBe(-1845000n);
  });

  it('numbers changes in order without gaps', async () => {
    const { ctx, bank, foodId } = await workspace();
    await Promise.all(
      Array.from({ length: 6 }, () => ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() })),
    );
    const seqs = (await t.db.collection('changes').find({ workspaceId: ctx.workspaceId }).toArray())
      .map((c) => c.seq)
      .sort((a, b) => Number(a - b));
    expect(seqs).toEqual(seqs.map((_, i) => BigInt(i + 1)));
  });

  it("refuses another workspace's account, so one workspace can't touch another's data", async () => {
    const a = await workspace('Ada');
    const b = await workspace('Bola');
    await expect(ledger.post(a.ctx, expense(b.bank._id, a.foodId), { operationId: uuidv7() })).rejects.toMatchObject({
      code: 'account_not_found',
    });
    await expect(ledger.post(a.ctx, expense(a.bank._id, b.foodId), { operationId: uuidv7() })).rejects.toMatchObject({
      code: 'category_not_found',
    });
    expect(await ledger.transactions.count(b.ctx, {})).toBe(0);
    const { event } = await ledger.post(b.ctx, expense(b.bank._id, b.foodId), { operationId: uuidv7() });
    await expect(ledger.reverse(a.ctx, event._id, { operationId: uuidv7() })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a refund that would pass the purchase, counting earlier refunds (check 4)', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId, '3000000'), { operationId: uuidv7() });
    const refund = (amount: string) =>
      ledger.post(
        ctx,
        { type: 'refund', refundOf: event._id, accountId: bank._id, amount, date: '2026-10-20' },
        { operationId: uuidv7() },
      );
    await refund('2000000');
    await expect(refund('1000001')).rejects.toMatchObject({
      code: 'refund_too_big',
      userMessage: 'This refund is more than the purchase (₦10,000.00).',
    });
    await refund('1000000');
  });

  it('refuses an archived account', async () => {
    const { ctx, bank, foodId } = await workspace();
    await ledger.accounts.updateOne(ctx, { _id: bank._id }, { $set: { archivedAt: new Date() } });
    await expect(ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() })).rejects.toMatchObject({
      code: 'account_archived',
    });
  });
});

describe('corrections (B1.4)', () => {
  it('correcting an already-reversed event is a conflict', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    await ledger.reverse(ctx, event._id, { operationId: uuidv7() });
    await expect(
      ledger.correct(ctx, event._id, expense(bank._id, foodId, '100'), { operationId: uuidv7() }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'already_changed',
      userMessage: 'This transaction was already changed on another device.',
    });
    await expect(ledger.reverse(ctx, event._id, { operationId: uuidv7() })).rejects.toMatchObject({ status: 409 });
  });

  it('when two devices correct the same event at once, one wins and the other is refused', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    const results = await Promise.allSettled([
      ledger.correct(ctx, event._id, expense(bank._id, foodId, '1000'), { operationId: uuidv7(), baseVersion: 1 }),
      ledger.correct(ctx, event._id, expense(bank._id, foodId, '2000'), { operationId: uuidv7(), baseVersion: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const [bal] = await ledger.balances.forAccounts(ctx, [bank._id]);
    expect([-1000n, -2000n]).toContain(bal!.balanceMinor);
  });

  it('refuses an old baseVersion with the current version attached', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    await ledger.patch(ctx, event._id, { notes: 'Shoprite' }, 1);
    const err = await ledger
      .correct(ctx, event._id, expense(bank._id, foodId, '1'), { operationId: uuidv7(), baseVersion: 1 })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'already_changed' });
    expect(err.extra.current).toMatchObject({ _id: event._id, version: 2, notes: 'Shoprite' });
  });

  it('a reversal and a correction keep the original dated where it was', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId, '1845000', '2026-09-30'), {
      operationId: uuidv7(),
    });
    const r = await ledger.correct(ctx, event._id, expense(bank._id, foodId, '1854000', '2026-10-02'), {
      operationId: uuidv7(),
    });
    expect(r.reversal).toMatchObject({ type: 'reversal', date: '2026-09-30', links: { reversalOf: event._id } });
    expect(r.event).toMatchObject({ date: '2026-10-02', links: { correctionOf: event._id } });
    const original = await ledger.transactions.byId(ctx, event._id);
    expect(original).toMatchObject({ status: 'reversed', links: { reversedBy: r.reversal._id } });
  });

  it('only notes, tags, payee and receipts change in place', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    const payeeId = uuidv7();
    const after = await ledger.patch(ctx, event._id, { notes: 'Weekly shop', tagIds: [uuidv7()], payeeId }, null);
    expect(after).toMatchObject({ notes: 'Weekly shop', payeeId, version: 2, lines: event.lines });
    const audit = await t.db
      .collection('audit_events')
      .findOne({ action: 'transaction.updated', 'target.id': event._id });
    expect(audit!.before).toMatchObject({ notes: null });
  });

  it('a locked (reconciled) event refuses correction', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    await ledger.transactions.updateOne(ctx, { _id: event._id }, { $set: { reconciliationId: uuidv7() } });
    await expect(ledger.reverse(ctx, event._id, { operationId: uuidv7() })).rejects.toMatchObject({
      code: 'reconciled',
    });
  });

  it('a purchase with refunds must lose its refunds before it changes', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    const refund = await ledger.post(
      ctx,
      { type: 'refund', refundOf: event._id, accountId: bank._id, amount: '100', date: '2026-10-13' },
      { operationId: uuidv7() },
    );
    await expect(ledger.reverse(ctx, event._id, { operationId: uuidv7() })).rejects.toMatchObject({
      code: 'has_refunds',
    });
    await ledger.reverse(ctx, refund.event._id, { operationId: uuidv7() });
    await ledger.reverse(ctx, event._id, { operationId: uuidv7() });
    const [bal] = await ledger.balances.forAccounts(ctx, [bank._id]);
    expect(bal!.balanceMinor).toBe(0n);
  });

  it('a reversal itself cannot be reversed', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    const { event: rev } = await ledger.reverse(ctx, event._id, { operationId: uuidv7() });
    await expect(ledger.reverse(ctx, rev._id, { operationId: uuidv7() })).rejects.toMatchObject({
      code: 'not_correctable',
    });
  });

  it('a repeated reverse or correct operationId returns the first result', async () => {
    const { ctx, bank, foodId } = await workspace();
    const { event } = await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    const operationId = uuidv7();
    const first = await ledger.correct(ctx, event._id, expense(bank._id, foodId, '5'), { operationId });
    const again = await ledger.correct(ctx, event._id, expense(bank._id, foodId, '5'), { operationId });
    expect(again).toMatchObject({
      duplicate: true,
      event: { _id: first.event._id },
      reversal: { _id: first.reversal._id },
    });
  });
});

describe('nightly balance check (B1.14)', () => {
  it('passes when every balance matches its lines', async () => {
    const { ctx, bank, foodId } = await workspace();
    await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    const doc = await t.services.balanceCheck.check(systemContext(ctx.workspaceId));
    expect(doc).toMatchObject({ ok: true, mismatches: [] });
  });

  it('reports a tampered balance, and does not overwrite it', async () => {
    const { ctx, bank, foodId } = await workspace();
    await ledger.post(ctx, expense(bank._id, foodId), { operationId: uuidv7() });
    await t.db
      .collection('account_balances')
      .updateOne({ workspaceId: ctx.workspaceId, ledgerAccountId: bank._id }, { $set: { balanceMinor: 5n } });
    t.outbox.messages = [];
    const doc = await t.services.balanceCheck.check(systemContext(ctx.workspaceId) as WorkspaceContext);
    expect(doc.ok).toBe(false);
    expect(doc.mismatches).toContainEqual({
      kind: 'balance',
      ledgerAccountId: bank._id,
      currency: 'NGN',
      stored: '5',
      fromLines: '-1845000',
    });
    const [bal] = await ledger.balances.forAccounts(ctx, [bank._id]);
    expect(bal!.balanceMinor).toBe(5n);
    expect(t.outbox.to('ops@example.test')).toHaveLength(1);
    expect(t.outbox.to('ops@example.test')[0]!.text).not.toContain('1845000');
  });

  it('visits every workspace from the job', async () => {
    const result = await t.services.balanceCheck.runAll();
    expect(result.checked).toBeGreaterThan(0);
  });
});

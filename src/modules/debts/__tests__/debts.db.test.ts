import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorkspace, startTestApp, type TestApp } from '../../../../test/helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('debts (B2.5)', () => {
  it('lend, collect with interest, write off (cases 9–11)', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const opay = await s.accounts.create(
      w.ctx,
      { type: 'wallet', name: 'OPay', openingBalance: '20000000', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const debt = await s.debts.lend(
      w.ctx,
      {
        personName: 'Tunde',
        amount: '10000000',
        accountId: opay.id,
        date: '2026-10-05',
      } as never,
      uuidv7(),
    );
    expect(debt.direction).toBe('they_owe_me');
    expect(debt.outstanding).toBe('10000000');
    const paid = await s.debts.recordPayment(
      w.ctx,
      debt.id,
      {
        date: '2026-11-15',
        accountId: opay.id,
        amount: '4200000',
        split: { principal: '4000000', interest: '200000' },
      } as never,
      uuidv7(),
    );
    expect(paid.debt.outstanding).toBe('6000000');
    const written = await s.debts.writeOff(
      w.ctx,
      debt.id,
      '2026-12-01',
      paid.debt.version,
      uuidv7(),
      'They left the country',
    );
    expect(written.debt.status).toBe('written_off');
    expect(written.debt.outstanding).toBe('0');
    expect(written.debt.notes).toContain('They left the country');
  });

  it('borrow from a person is not income (E13)', async () => {
    const w = await newWorkspace(t);
    const s = t.services;
    const bank = await s.accounts.create(
      w.ctx,
      { type: 'bank', name: 'GTBank', openingBalance: '0', openingDate: '2026-10-01' } as never,
      uuidv7(),
    );
    const debt = await s.debts.borrow(
      w.ctx,
      {
        personName: 'Ada',
        amount: '5000000',
        accountId: bank.id,
        date: '2026-10-10',
      } as never,
      uuidv7(),
    );
    expect(debt.direction).toBe('i_owe_them');
    const list = await s.accounts.list(w.ctx);
    const gtb = list.accounts.find((a) => a.id === bank.id)!;
    expect(gtb.balance).toBe('5000000');
  });
});

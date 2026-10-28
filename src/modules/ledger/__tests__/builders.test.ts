import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../../common/errors/errors.js';
import { buildEvent, buildReversal, rateOf, type Resolver } from '../builders.js';
import { checkLines, IntegrityError } from '../checks.js';
import type { EventInput } from '../ledger.inputs.js';
import { type AccountRef, SYSTEM_ACCOUNTS, SYSTEM_KEYS, type SystemKey } from '../ledger.types.js';
import { balances, budgetMonths } from '../read.js';

const ref = (kind: AccountRef['kind'], extra: Partial<AccountRef> = {}): AccountRef => ({
  id: uuidv7(),
  kind,
  currency: 'NGN',
  systemKey: null,
  categoryId: null,
  archived: false,
  ...extra,
});

const bank = ref('asset');
const usd = ref('asset', { currency: 'USD' });
const card = ref('liability');
const food = ref('expense', { categoryId: uuidv7() });
const home = ref('expense', { categoryId: uuidv7() });
const salary = ref('income', { categoryId: uuidv7() });
const system = new Map(SYSTEM_KEYS.map((k) => [k, ref(SYSTEM_ACCOUNTS[k].kind, { systemKey: k })]));
const all = [bank, usd, card, food, home, salary, ...system.values()];
const byId = new Map(all.map((a) => [a.id, a]));
const purchase = {
  type: 'expense' as const,
  status: 'posted',
  lines: [
    { ledgerAccountId: food.id, amountMinor: 3000000n, currency: 'NGN', categoryId: food.categoryId },
    { ledgerAccountId: bank.id, amountMinor: -3000000n, currency: 'NGN' },
  ],
  refunded: 0n,
};
const purchaseId = uuidv7();

const r: Resolver = {
  account: (id) => byId.get(id) ?? null,
  category: (id) => all.find((a) => a.categoryId === id) ?? null,
  system: (k: SystemKey) => system.get(k)!,
  original: (id) => (id === purchaseId ? purchase : null),
};
const d = '2026-10-12';
const lines = (input: EventInput) => buildEvent(input, r).lines.map((l) => [l.ledgerAccountId, l.amountMinor]);
const sys = (k: SystemKey) => system.get(k)!.id;

describe('event builders (B1.2): exact lines per type', () => {
  it('E1 income', () => {
    expect(
      lines({ type: 'income', accountId: bank.id, categoryId: salary.categoryId!, amount: '100', date: d }),
    ).toEqual([
      [bank.id, 100n],
      [salary.id, -100n],
    ]);
  });
  it('E2 expense from a bank', () => {
    expect(
      lines({ type: 'expense', accountId: bank.id, categoryId: food.categoryId!, amount: '100', date: d }),
    ).toEqual([
      [food.id, 100n],
      [bank.id, -100n],
    ]);
  });
  it('E3 and E5 expense on a card: spending counts when you buy', () => {
    expect(
      lines({ type: 'expense', accountId: card.id, categoryId: food.categoryId!, amount: '100', date: d }),
    ).toEqual([
      [food.id, 100n],
      [card.id, -100n],
    ]);
  });
  it('E4 card repayment and E6 transfer: exactly two lines', () => {
    expect(lines({ type: 'transfer', fromAccountId: bank.id, toAccountId: card.id, amount: '100', date: d })).toEqual([
      [card.id, 100n],
      [bank.id, -100n],
    ]);
  });
  it('E7 transfer between currencies balances each currency through fx-clearing and stores the rate', () => {
    const built = buildEvent(
      { type: 'transfer', fromAccountId: bank.id, toAccountId: usd.id, amount: '18600000', toAmount: '12000', date: d },
      r,
    );
    expect(built.lines.map((l) => [l.ledgerAccountId, l.amountMinor, l.currency])).toEqual([
      [sys('fx_clearing'), 18600000n, 'NGN'],
      [bank.id, -18600000n, 'NGN'],
      [usd.id, 12000n, 'USD'],
      [sys('fx_clearing'), -12000n, 'USD'],
    ]);
    expect(built.fxRate).toBe('1550');
    checkLines('transfer', built.lines, (id) => byId.get(id) ?? null);
  });
  it('E7 needs the amount that arrived', () => {
    expect(() =>
      buildEvent({ type: 'transfer', fromAccountId: bank.id, toAccountId: usd.id, amount: '1', date: d }, r),
    ).toThrow(AppError);
  });
  it('E8 opening balance: asset debits the account, liability credits it', () => {
    expect(lines({ type: 'opening_balance', accountId: bank.id, amount: '500', date: d })).toEqual([
      [bank.id, 500n],
      [sys('opening_balances'), -500n],
    ]);
    expect(lines({ type: 'opening_balance', accountId: card.id, amount: '500', date: d })).toEqual([
      [card.id, -500n],
      [sys('opening_balances'), 500n],
    ]);
  });
  it('E9 reconcile and E10 revaluation go to their equity accounts', () => {
    expect(
      lines({ type: 'balance_adjustment', reason: 'reconcile', accountId: bank.id, amount: '-7', date: d }),
    ).toEqual([
      [bank.id, -7n],
      [sys('adjustments'), 7n],
    ]);
    expect(
      lines({ type: 'balance_adjustment', reason: 'revaluation', accountId: bank.id, amount: '7', date: d }),
    ).toEqual([
      [bank.id, 7n],
      [sys('revaluation'), -7n],
    ]);
  });
  it("E11 refund credits the purchase's category", () => {
    expect(lines({ type: 'refund', refundOf: purchaseId, accountId: bank.id, amount: '100', date: d })).toEqual([
      [bank.id, 100n],
      [food.id, -100n],
    ]);
  });
  it('E12 split: the parts must add up to the total', () => {
    const split = (b: string) => ({
      type: 'expense' as const,
      accountId: bank.id,
      amount: '900',
      splits: [
        { categoryId: food.categoryId!, amount: '300' },
        { categoryId: home.categoryId!, amount: b },
      ],
      date: d,
    });
    expect(lines(split('600'))).toEqual([
      [food.id, 300n],
      [home.id, 600n],
      [bank.id, -900n],
    ]);
    expect(() => buildEvent(split('601'), r)).toThrow(
      expect.objectContaining({
        code: 'split_total',
        userMessage: 'The parts add up to ₦9.01, not ₦9.00. Change a part so they match.',
      }),
    );
  });
  it('E25 reversal flips every sign', () => {
    expect(buildReversal([{ ledgerAccountId: bank.id, amountMinor: 5n, currency: 'NGN' }])[0]!.amountMinor).toBe(-5n);
  });
  it('refuses a category in place of an account, and an income category for spending', () => {
    expect(() =>
      lines({ type: 'expense', accountId: food.id, categoryId: food.categoryId!, amount: '1', date: d }),
    ).toThrow(expect.objectContaining({ code: 'wrong_account' }));
    expect(() =>
      lines({ type: 'expense', accountId: bank.id, categoryId: salary.categoryId!, amount: '1', date: d }),
    ).toThrow(expect.objectContaining({ code: 'wrong_category' }));
    expect(() =>
      lines({ type: 'transfer', fromAccountId: bank.id, toAccountId: bank.id, amount: '1', date: d }),
    ).toThrow(expect.objectContaining({ code: 'same_account' }));
  });
  it('rates are rounded to 10 places', () => {
    expect(rateOf(100n, 'NGN', 3n, 'USD')).toBe('33.3333333333');
  });
});

describe('integrity checks (6.11): each refuses a bad event', () => {
  const of = (id: string) => byId.get(id) ?? null;
  const l = (a: AccountRef, n: bigint) => ({ ledgerAccountId: a.id, amountMinor: n, currency: a.currency });
  it('1: lines must balance per currency', () => {
    expect(() => checkLines('expense', [l(food, 10n), l(bank, -9n)], of)).toThrow(IntegrityError);
  });
  it('2: every account must be in the workspace', () => {
    expect(() =>
      checkLines('expense', [{ ledgerAccountId: uuidv7(), amountMinor: 1n, currency: 'NGN' }, l(bank, -1n)], of),
    ).toThrow(IntegrityError);
  });
  it('2: currency must match the account', () => {
    expect(() => checkLines('transfer', [{ ...l(usd, 1n), currency: 'NGN' }, l(bank, -1n)], of)).toThrow(AppError);
  });
  it('3: required lines are present', () => {
    expect(() => checkLines('income', [l(bank, 1n), l(food, -1n)], of)).toThrow(IntegrityError);
    expect(() => checkLines('opening_balance', [l(bank, 1n), l(system.get('adjustments')!, -1n)], of)).toThrow(
      IntegrityError,
    );
  });
  it('7: a transfer has exactly two accounts', () => {
    expect(() => checkLines('transfer', [l(bank, 2n), l(card, -1n), l(usd, -1n)], of)).toThrow();
    expect(() => checkLines('transfer', [l(bank, 1n), l(food, -1n)], of)).toThrow(IntegrityError);
  });
});

describe('property tests (build plan 3.2)', () => {
  const amount = fc.bigInt({ min: 1n, max: 10n ** 15n });
  it('every built event balances, and a reversal brings every balance back to zero', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('income', 'expense', 'transfer', 'opening'),
            amount,
            fc.array(amount, { minLength: 2, maxLength: 4 }),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (ops) => {
          const events = ops.map(([kind, a, parts]) => {
            const input: EventInput =
              kind === 'income'
                ? { type: 'income', accountId: bank.id, categoryId: salary.categoryId!, amount: a.toString(), date: d }
                : kind === 'transfer'
                  ? { type: 'transfer', fromAccountId: bank.id, toAccountId: card.id, amount: a.toString(), date: d }
                  : kind === 'opening'
                    ? { type: 'opening_balance', accountId: card.id, amount: a.toString(), date: d }
                    : {
                        type: 'expense',
                        accountId: bank.id,
                        amount: parts.reduce((s, p) => s + p, 0n).toString(),
                        splits: parts.map((p, i) => ({
                          categoryId: (i % 2 ? home : food).categoryId!,
                          amount: p.toString(),
                        })),
                        date: d,
                      };
            const built = buildEvent(input, r);
            checkLines(built.type, built.lines, (id) => byId.get(id) ?? null);
            return built;
          });
          const total = [...balances(events).values()].reduce((s, v) => s + v, 0n);
          expect(total).toBe(0n);
          const undone = balances([...events, ...events.map((e) => ({ lines: buildReversal(e.lines) }))]);
          for (const v of undone.values()) expect(v).toBe(0n);
        },
      ),
    );
  });

  it('envelope: what is planned and left to plan always add up to the income received', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(amount, amount, amount), { minLength: 1, maxLength: 6 }), (months) => {
        const ms = months.map((_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
        const out = budgetMonths({
          style: 'envelope',
          months: ms,
          categoryIds: ['food'],
          assigned: (_, m) => months[ms.indexOf(m)]![0],
          activity: (_, m) => months[ms.indexOf(m)]![1],
          budgetableIncome: (m) => months[ms.indexOf(m)]![2],
        });
        const last = out.at(-1)!;
        const income = months.reduce((s, x) => s + x[2], 0n);
        const spent = months.reduce((s, x) => s + x[1], 0n);
        const available = last.categories.get('food')!.available;
        const overspentNow = available < 0n ? -available : 0n;
        // Money in = money spent + money still available + money still unplanned, with this month's overspending pending.
        expect(last.leftToPlan! + (available > 0n ? available : 0n) + spent - overspentNow).toBe(income);
      }),
    );
  });
});

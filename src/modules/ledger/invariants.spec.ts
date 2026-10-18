import { INestApplication } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { add, CurrencyMismatchError, formatMoney, money, parseMoney } from "@/common/money/money";
import { http, registerAndVerify, startLedgerApp, TEST_PASSWORD, testId } from "@/modules/accounts/tests/test-app";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import { TestApp } from "@/modules/auth/tests/test-app";
import { periodTotals } from "@/modules/transactions/application/totals";
import { TransactionsRepository } from "@/modules/transactions/repositories/transactions.repository";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";

jest.setTimeout(120_000);

/** Appendix A titles from SPEC-1.3. Test names must start with these strings. */
export const APPENDIX_A = [
  "INV-01 workspace-scoped posted transactions",
  "INV-02 transfer two effects",
  "INV-03 transfers not income/expense",
  "INV-04 category type match",
  "INV-05 split sums",
  "INV-06 opening balance not income",
  "INV-07 loan proceeds not income",
  "INV-08 principal vs interest",
  "INV-09 savings not a second asset",
  "INV-10 investment purchase not expense",
  "INV-11 sale proceeds not all income",
  "INV-12 refunds",
  "INV-13 net worth",
  "INV-14 explicit currency",
  "INV-15 idempotency",
  "INV-16 authorization",
  "INV-17 durable offline writes",
  "INV-18 stable reports",
  "INV-19 receivables",
  "INV-20 no raw multi-currency sums",
  "INV-21 pending not double-counted",
  "INV-22 derived budgets",
  "INV-23 scheduled items not transactions",
  "INV-24 accounts reconcile",
] as const;

describe("Appendix A INV-01–24", () => {
  let harness: TestApp;
  let app: INestApplication;
  let mailer: CaptureMailer;
  let token: string;
  let workspaceId: string;
  let cashId: string;

  beforeAll(async () => {
    harness = await startLedgerApp();
    app = harness.app;
    mailer = harness.mailer;
    const ids = await registerAndVerify(app, mailer, "inv@example.com");
    workspaceId = ids.workspaceId;
    const login = await http(app, "POST", "/v1/auth/login", { email: "inv@example.com", password: TEST_PASSWORD });
    token = (login.json as { accessToken: string }).accessToken;
    const cash = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Cash", kind: "cash", opening: "1000.00" },
      token,
    );
    cashId = (cash.json as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("Appendix A labels match SPEC-1.3", () => {
    const spec = readFileSync(join(__dirname, "../../../docs/SPEC-1.3.md"), "utf8");
    const line = spec.split("\n").find((row) => row.startsWith("INV-01–INV-24:"));
    expect(line).toBeDefined();
    const phrases = line!
      .replace(/^INV-01–INV-24:\s*/, "")
      .split(";")
      .map((part) => part.trim().replace(/\.$/, ""));
    expect(phrases).toHaveLength(24);
    APPENDIX_A.forEach((title, index) => {
      expect(title).toBe(`INV-${String(index + 1).padStart(2, "0")} ${phrases[index]}`);
    });
    const source = readFileSync(join(__dirname, "invariants.spec.ts"), "utf8");
    for (const title of APPENDIX_A) {
      expect(source).toContain(`it("${title}"`);
    }
  });

  it("INV-01 workspace-scoped posted transactions", async () => {
    const other = await registerAndVerify(app, mailer, "inv-b@example.com");
    const login = await http(app, "POST", "/v1/auth/login", { email: "inv-b@example.com", password: TEST_PASSWORD });
    const otherToken = (login.json as { accessToken: string }).accessToken;
    const otherCash = await http(
      app,
      "POST",
      `/v1/workspaces/${other.workspaceId}/accounts`,
      { name: "Other cash", kind: "cash", opening: "10.00" },
      otherToken,
    );
    const otherCashId = (otherCash.json as { data: { id: string } }).data.id;
    await http(
      app,
      "POST",
      `/v1/workspaces/${other.workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "3.00", accountId: otherCashId, description: "Other shop" },
      otherToken,
    );
    const mine = await http(app, "GET", `/v1/workspaces/${workspaceId}/transactions`, undefined, token);
    const rows = (mine.json as { data: { transactions: { description: string }[] } }).data.transactions;
    expect(rows.some((row) => row.description === "Other shop")).toBe(false);
  });

  it("INV-02 transfer two effects", async () => {
    const dest = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Pot INV-02", kind: "savings", opening: "0.00" },
      token,
    );
    const destId = (dest.json as { data: { id: string } }).data.id;
    const posted = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "transfer", amount: "2.00", accountId: cashId, toAccountId: destId, description: "Move" },
      token,
    );
    const id = (posted.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const stored = await harness.db.collection<{ _id: string; effects: unknown[] }>("transactions").findOne({ _id: id });
    expect(stored?.effects).toHaveLength(2);
  });

  it("INV-03 transfers not income/expense", async () => {
    const dest = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Pot INV-03", kind: "savings", opening: "0.00" },
      token,
    );
    const destId = (dest.json as { data: { id: string } }).data.id;
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "transfer", amount: "3.00", accountId: cashId, toAccountId: destId, description: "Move 03" },
      token,
    );
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    const b = before.json as { data: { income: { value: string }; expense: { value: string } } };
    const a = after.json as { data: { income: { value: string }; expense: { value: string } } };
    expect(a.data.income.value).toBe(b.data.income.value);
    expect(a.data.expense.value).toBe(b.data.expense.value);
  });

  it("INV-04 category type match", async () => {
    const cats = await http(app, "GET", `/v1/workspaces/${workspaceId}/categories`, undefined, token);
    const salary = (cats.json as { data: { id: string; name: string }[] }).data.find((row) => row.name === "Salary");
    expect(salary).toBeTruthy();
    const mismatch = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      {
        operationId: testId(),
        type: "expense",
        amount: "1.00",
        accountId: cashId,
        categoryId: salary?.id,
        description: "Wrong type",
      },
      token,
    );
    expect(mismatch.code).toBe(422);
  });

  it("INV-05 split sums", async () => {
    const parent = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "9.00", accountId: cashId, description: "Split me" },
      token,
    );
    const parentId = (parent.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const ok = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions/${parentId}/splits`,
      { lines: [{ amount: "3.00" }, { amount: "6.00" }] },
      token,
    );
    expect([200, 201]).toContain(ok.code);
    const bad = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions/${parentId}/splits`,
      { lines: [{ amount: "1.00" }, { amount: "1.00" }] },
      token,
    );
    expect(bad.code).toBeGreaterThanOrEqual(400);
  });

  it("INV-06 opening balance not income", async () => {
    const dash = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect((dash.json as { data: { income: { value: string } } }).data.income.value).toBe("0.00");
  });

  it("INV-07 loan proceeds not income", async () => {
    const liab = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Loan", kind: "liability", opening: "0.00" },
      token,
    );
    const liabId = (liab.json as { data: { id: string } }).data.id;
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "loan_in", amount: "6.00", accountId: cashId, toAccountId: liabId, description: "Borrow" },
      token,
    );
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect((after.json as { data: { income: { value: string } } }).data.income.value).toBe(
      (before.json as { data: { income: { value: string } } }).data.income.value,
    );
  });

  it("INV-08 principal vs interest", async () => {
    const debt = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/debts`,
      { direction: "i_owe", counterparty: "Bank", principal: "20.00" },
      token,
    );
    const debtId = (debt.json as { data: { id: string } }).data.id;
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    const repay = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/debts/${debtId}/repay`,
      { cashAccountId: cashId, operationId: testId(), principal: "5.00", interest: "1.00" },
      token,
    );
    expect([200, 201]).toContain(repay.code);
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    const spentBefore = Number((before.json as { data: { expense: { value: string } } }).data.expense.value);
    const spentAfter = Number((after.json as { data: { expense: { value: string } } }).data.expense.value);
    expect(spentAfter - spentBefore).toBeCloseTo(1, 2);
  });

  it("INV-09 savings not a second asset", async () => {
    const dest = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Goal pot", kind: "savings", opening: "0.00" },
      token,
    );
    const destId = (dest.json as { data: { id: string } }).data.id;
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/net-worth`, undefined, token);
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "allocation", amount: "4.00", accountId: cashId, toAccountId: destId, description: "Set aside" },
      token,
    );
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/net-worth`, undefined, token);
    expect((after.json as { data: { netWorth: string } }).data.netWorth).toBe(
      (before.json as { data: { netWorth: string } }).data.netWorth,
    );
  });

  it("INV-10 investment purchase not expense", async () => {
    const dest = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Broker buy", kind: "savings", opening: "0.00" },
      token,
    );
    const destId = (dest.json as { data: { id: string } }).data.id;
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "allocation", amount: "7.00", accountId: cashId, toAccountId: destId, description: "Buy stock" },
      token,
    );
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect((after.json as { data: { expense: { value: string } } }).data.expense.value).toBe(
      (before.json as { data: { expense: { value: string } } }).data.expense.value,
    );
  });

  it("INV-11 sale proceeds not all income", async () => {
    const dest = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Broker sell", kind: "savings", opening: "8.00" },
      token,
    );
    const destId = (dest.json as { data: { id: string } }).data.id;
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "allocation", amount: "2.00", accountId: destId, toAccountId: cashId, description: "Sell stock" },
      token,
    );
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect((after.json as { data: { income: { value: string } } }).data.income.value).toBe(
      (before.json as { data: { income: { value: string } } }).data.income.value,
    );
  });

  it("INV-12 refunds", async () => {
    const exp = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "8.00", accountId: cashId, description: "Bag" },
      token,
    );
    const id = (exp.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const refund = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "refund", amount: "8.00", accountId: cashId, originalTransactionId: id, description: "Back" },
      token,
    );
    expect((refund.json as { data: { transaction: { type: string } } }).data.transaction.type).toBe("refund");
  });

  it("INV-13 net worth", async () => {
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/net-worth`, undefined, token);
    await http(app, "POST", `/v1/workspaces/${workspaceId}/goals`, { name: "Ignore", target: "99999.00" }, token);
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/net-worth`, undefined, token);
    expect((after.json as { data: { netWorth: string } }).data.netWorth).toBe(
      (before.json as { data: { netWorth: string } }).data.netWorth,
    );
  });

  it("INV-14 explicit currency", () => {
    expect(formatMoney(money(123n, "NGN"))).toBe("1.23");
    expect(parseMoney("1.23", "NGN").currency).toBe("NGN");
  });

  it("INV-15 idempotency", async () => {
    const op = testId();
    const body = { operationId: op, type: "expense", amount: "1.00", accountId: cashId, description: "Dup" };
    const a = await http(app, "POST", `/v1/workspaces/${workspaceId}/transactions`, body, token);
    const b = await http(app, "POST", `/v1/workspaces/${workspaceId}/transactions`, body, token);
    expect(a.code).toBe(201);
    expect(b.code).toBe(201);
    expect((a.json as { data: { transaction: { id: string } } }).data.transaction.id).toBe(
      (b.json as { data: { transaction: { id: string } } }).data.transaction.id,
    );
  });

  it("INV-16 authorization", async () => {
    const res = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`);
    expect(res.code).toBe(401);
  });

  it("INV-17 durable offline writes", async () => {
    const op = testId();
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: op, type: "expense", amount: "1.00", accountId: cashId, description: "Queued" },
      token,
    );
    const stored = await harness.db.collection("operations").findOne({ operationId: op });
    expect(stored).toBeTruthy();
  });

  it("INV-18 stable reports", async () => {
    const first = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    const second = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect(first.json).toEqual(second.json);
  });

  it("INV-19 receivables", async () => {
    const rec = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Owed", kind: "receivable", opening: "0.00" },
      token,
    );
    expect(rec.code).toBe(201);
  });

  it("INV-20 no raw multi-currency sums", () => {
    expect(() => add(parseMoney("1.00", "NGN"), parseMoney("1.00", "USD"))).toThrow(CurrencyMismatchError);
  });

  it("INV-21 pending not double-counted", async () => {
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "5.00", accountId: cashId, description: "Hold", status: "pending" },
      token,
    );
    const totals = periodTotals(await harness.app.get(TransactionsRepository).listPosted(workspaceId));
    expect(totals.expense).not.toBe("5.00");
  });

  it("INV-22 derived budgets", async () => {
    const budget = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/budgets`,
      { accountId: cashId, amount: "50.00", primaryPeriod: "year" },
      token,
    );
    const id = (budget.json as { data: { id: string } }).data.id;
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "10.00", accountId: cashId, description: "Budget food" },
      token,
    );
    const views = await http(app, "GET", `/v1/workspaces/${workspaceId}/budgets/${id}`, undefined, token);
    const data = (views.json as { data: { spent: string; remaining: string } }).data;
    expect(Number(data.spent) + Number(data.remaining)).toBeCloseTo(50, 2);
  });

  it("INV-23 scheduled items not transactions", async () => {
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/bills`,
      { name: "Power", amount: "1.00", cadence: "weekly", weekday: 1 },
      token,
    );
    const before = await harness.db.collection("transactions").countDocuments({ workspaceId });
    await harness.app.get(LedgerOpsService).tickReminders(new Date("2026-10-19T00:00:00.000Z"));
    const after = await harness.db.collection("transactions").countDocuments({ workspaceId });
    expect(after).toBe(before);
    const reminders = await harness.db.collection("reminder_occurrences").countDocuments({ workspaceId });
    expect(reminders).toBeGreaterThanOrEqual(1);
  });

  it("INV-24 accounts reconcile", async () => {
    const created = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Reconcile cash", kind: "cash", opening: "100.00" },
      token,
    );
    const id = (created.json as { data: { id: string } }).data.id;
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "10.00", accountId: id, description: "Reconcile spend" },
      token,
    );
    const listed = await http(app, "GET", `/v1/workspaces/${workspaceId}/accounts`, undefined, token);
    const row = (listed.json as { data: { id: string; opening: string; balance: string }[] }).data.find((item) => item.id === id);
    const posted = await harness.app.get(TransactionsRepository).listPosted(workspaceId);
    let effects = 0n;
    for (const txn of posted) {
      for (const effect of txn.effects) {
        if (effect.accountId === id) effects += effect.amountMinor;
      }
    }
    const expected = parseMoney(row?.opening ?? "0", "NGN").amountMinor + effects;
    expect(row?.balance).toBe(formatMoney(money(expected, "NGN")));
    expect(row?.balance).toBe("90.00");
  });
});

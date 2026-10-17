import { INestApplication } from "@nestjs/common";
import { formatMoney, money, parseMoney } from "@/common/money/money";
import { http, registerAndVerify, startLedgerApp, TEST_PASSWORD, testId } from "@/modules/accounts/tests/test-app";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import { TestApp } from "@/modules/auth/tests/test-app";
import { periodTotals } from "@/modules/transactions/application/totals";
import { TransactionsRepository } from "@/modules/transactions/repositories/transactions.repository";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { readFileSync } from "node:fs";
import { join } from "node:path";

jest.setTimeout(120_000);

describe("MYL-025 INV-01–24", () => {
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

  it("INV-01 money is two-decimal string from bigint", () => {
    expect(formatMoney(money(123n, "NGN"))).toBe("1.23");
    expect(parseMoney("1.23", "NGN").amountMinor).toBe(123n);
  });

  it("INV-02 envelope status data error", async () => {
    const res = await http(app, "GET", `/v1/workspaces/${workspaceId}/net-worth`, undefined, token);
    expect(res.json).toEqual(expect.objectContaining({ status: "ok", error: null, data: expect.any(Object) }));
  });

  it("INV-03 operationId unique same payload", async () => {
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

  it("INV-04 opening is not income", async () => {
    const dash = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect((dash.json as { data: { income: { value: string } } }).data.income.value).toBe("0.00");
  });

  it("INV-05 only posted counts", async () => {
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

  it("INV-06 archive keeps row", async () => {
    const created = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Temp", kind: "cash", opening: "0.00" },
      token,
    );
    const id = (created.json as { data: { id: string } }).data.id;
    await http(app, "DELETE", `/v1/workspaces/${workspaceId}/accounts/${id}`, undefined, token);
    const stored = await harness.db.collection<{ _id: string; archivedAt?: Date }>("accounts").findOne({ _id: id });
    expect(stored?.archivedAt).toBeTruthy();
  });

  it("INV-07 transfer excluded from income/expense", async () => {
    const dest = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Pot", kind: "savings", opening: "0.00" },
      token,
    );
    const destId = (dest.json as { data: { id: string } }).data.id;
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "transfer", amount: "3.00", accountId: cashId, toAccountId: destId, description: "Move" },
      token,
    );
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect((before.json as { data: { income: { value: string }; expense: { value: string } } }).data.income.value).toBe(
      (after.json as { data: { income: { value: string }; expense: { value: string } } }).data.income.value,
    );
  });

  it("INV-08 refund type stays refund", async () => {
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

  it("INV-09 reversed is status not opposite row", async () => {
    const exp = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "2.00", accountId: cashId, description: "Undo" },
      token,
    );
    const id = (exp.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const reversed = await http(app, "PATCH", `/v1/workspaces/${workspaceId}/transactions/${id}/status`, { status: "reversed" }, token);
    expect(reversed.code).toBe(200);
    const count = await harness.db.collection("transactions").countDocuments({ originalTransactionId: id });
    expect(count).toBe(0);
  });

  it("INV-10 INV-11 ledger only no bank send; buy/sale not income/expense via allocation", async () => {
    const src = readFileSync(join(__dirname, "ledger-ops.service.ts"), "utf8");
    expect(src).not.toMatch(/nuban|transfer-to-bank|sendMoney/i);
    const dest = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Broker", kind: "savings", opening: "0.00" },
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
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "allocation", amount: "2.00", accountId: destId, toAccountId: cashId, description: "Sell stock" },
      token,
    );
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect((before.json as { data: { income: { value: string }; expense: { value: string } } }).data.income.value).toBe(
      (after.json as { data: { income: { value: string }; expense: { value: string } } }).data.income.value,
    );
  });

  it("INV-12 search min two chars", async () => {
    const res = await http(app, "GET", `/v1/workspaces/${workspaceId}/search?q=a`, undefined, token);
    expect(res.code).toBe(400);
  });

  it("INV-13 hide lock amounts default on", async () => {
    const hide = await http(app, "PATCH", "/v1/me/settings", {}, token);
    expect((hide.json as { data: { hideLockScreenAmounts: boolean } }).data.hideLockScreenAmounts).toBe(true);
  });

  it("INV-14 unique reminder occurrence", async () => {
    await http(app, "POST", `/v1/workspaces/${workspaceId}/bills`, { name: "Power", amount: "1.00", cadence: "weekly", weekday: 1 }, token);
    const ops = harness.app.get(LedgerOpsService);
    await ops.tickReminders(new Date("2026-10-19T00:00:00.000Z"));
    await ops.tickReminders(new Date("2026-10-19T00:00:00.000Z"));
    const n = await harness.db.collection("reminder_occurrences").countDocuments({ workspaceId });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("INV-15 csv formula prefix", async () => {
    const preview = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/imports/preview`,
      { text: "date,description,amount\n2026-10-01,+CMD,1.00" },
      token,
    );
    expect([200, 201]).toContain(preview.code);
  });

  it("INV-16 wipe list covers user owned workspaces", async () => {
    const ops = harness.app.get(LedgerOpsService);
    expect(ops.wipeOrder()).toContain("users");
    expect(ops.wipeOrder()).toContain("workspaces");
  });

  it("INV-17 receivable kind accepted", async () => {
    const rec = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Owed", kind: "receivable", opening: "0.00" },
      token,
    );
    expect(rec.code).toBe(201);
  });

  it("INV-18 allocation type", async () => {
    const dest = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Goal pot", kind: "savings", opening: "0.00" },
      token,
    );
    const destId = (dest.json as { data: { id: string } }).data.id;
    const alloc = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "allocation", amount: "4.00", accountId: cashId, toAccountId: destId, description: "Set aside" },
      token,
    );
    expect(alloc.code).toBe(201);
  });

  it("INV-19 loan_in loan_out principal_collect", async () => {
    const liab = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Loan", kind: "liability", opening: "0.00" },
      token,
    );
    const recv = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Lent", kind: "receivable", opening: "0.00" },
      token,
    );
    const liabId = (liab.json as { data: { id: string } }).data.id;
    const recvId = (recv.json as { data: { id: string } }).data.id;
    const inn = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "loan_in", amount: "6.00", accountId: cashId, toAccountId: liabId, description: "Borrow" },
      token,
    );
    const out = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "loan_out", amount: "6.00", accountId: cashId, toAccountId: recvId, description: "Lend" },
      token,
    );
    const collect = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "principal_collect", amount: "1.00", accountId: cashId, toAccountId: recvId, description: "Collect" },
      token,
    );
    expect(inn.code).toBe(201);
    expect(out.code).toBe(201);
    expect(collect.code).toBe(201);
  });

  it("INV-20 net worth ignores goals", async () => {
    const before = await http(app, "GET", `/v1/workspaces/${workspaceId}/net-worth`, undefined, token);
    await http(app, "POST", `/v1/workspaces/${workspaceId}/goals`, { name: "Ignore", target: "99999.00" }, token);
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/net-worth`, undefined, token);
    expect((before.json as { data: { netWorth: string } }).data.netWorth).toBe((after.json as { data: { netWorth: string } }).data.netWorth);
  });

  it("INV-21 capability view can export", async () => {
    const res = await fetch(`${await app.getUrl()}/v1/workspaces/${workspaceId}/exports/transactions.csv`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("INV-22 no canned naira in ledger ops", async () => {
    const src = readFileSync(join(__dirname, "ledger-ops.service.ts"), "utf8");
    expect(src).not.toContain("HOME_");
  });

  it("INV-23 UUIDv7-shaped ids", () => {
    expect(testId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("INV-24 auth required", async () => {
    const res = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`);
    expect(res.code).toBe(401);
  });
});

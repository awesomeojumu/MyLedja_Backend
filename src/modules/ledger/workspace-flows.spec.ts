import { INestApplication } from "@nestjs/common";
import { http, registerAndVerify, startLedgerApp, TEST_PASSWORD, testId } from "@/modules/accounts/tests/test-app";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import { TestApp } from "@/modules/auth/tests/test-app";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";

jest.setTimeout(120_000);

describe("ledger H–S G U N Q", () => {
  let harness: TestApp;
  let app: INestApplication;
  let mailer: CaptureMailer;
  let token: string;
  let workspaceId: string;
  let cashId: string;
  let savingsId: string;
  let userId: string;

  beforeAll(async () => {
    harness = await startLedgerApp();
    app = harness.app;
    mailer = harness.mailer;
    const ids = await registerAndVerify(app, mailer, "ledger@example.com");
    userId = ids.userId;
    workspaceId = ids.workspaceId;
    const login = await http(app, "POST", "/v1/auth/login", { email: "ledger@example.com", password: TEST_PASSWORD });
    token = (login.json as { accessToken: string }).accessToken;
    const cash = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Cash", kind: "cash", opening: "20000.00" },
      token,
    );
    const savings = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Savings", kind: "savings", opening: "0.00" },
      token,
    );
    cashId = (cash.json as { data: { id: string } }).data.id;
    savingsId = (savings.json as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("G1 G2 timezone weekStartsOn", async () => {
    const patched = await http(
      app,
      "PATCH",
      `/v1/workspaces/${workspaceId}/setup`,
      { timezone: "Africa/Lagos", weekStartsOn: "sunday" },
      token,
    );
    expect(patched.code).toBe(200);
    const got = await http(app, "GET", `/v1/workspaces/${workspaceId}`, undefined, token);
    const body = got.json as { timezone: string; weekStartsOn: string };
    expect(body.timezone).toBe("Africa/Lagos");
    expect(body.weekStartsOn).toBe("sunday");
  });

  it("H1–H4 budget per account four views", async () => {
    const budget = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/budgets`,
      { accountId: cashId, amount: "5000.00", primaryPeriod: "month" },
      token,
    );
    expect(budget.code).toBe(201);
    const id = (budget.json as { data: { id: string } }).data.id;
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "1000.00", accountId: cashId, description: "Food" },
      token,
    );
    const views = await http(app, "GET", `/v1/workspaces/${workspaceId}/budgets/${id}`, undefined, token);
    expect(views.code).toBe(200);
    const data = (views.json as { data: { spent: string; remaining: string; views: Record<string, { value: string }> } }).data;
    expect(data.views.day).toBeDefined();
    expect(data.views.week).toBeDefined();
    expect(data.views.month).toBeDefined();
    expect(data.views.year).toBeDefined();
    expect(data.spent).toBe("1000.00");
    expect(data.remaining).toBe("4000.00");
  });

  it("I1–I4 bills cadence tick unique paid", async () => {
    const bill = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/bills`,
      { name: "DSTV", amount: "50.00", cadence: "monthly", anchorDay: 17, accountId: cashId },
      token,
    );
    expect(bill.code).toBe(201);
    const billId = (bill.json as { data: { id: string } }).data.id;
    const ops = harness.app.get(LedgerOpsService);
    const first = await ops.tickReminders(new Date("2026-10-17T08:00:00.000Z"));
    const second = await ops.tickReminders(new Date("2026-10-17T08:01:00.000Z"));
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);
    const paid = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/bills/${billId}/paid`,
      { accountId: cashId, operationId: testId() },
      token,
    );
    expect(paid.code).toBe(201);
  });

  it("J1–J3 income stream match amount", async () => {
    const stream = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/income-streams`,
      { name: "Salary", expected: "100.00", taxClass: "paye" },
      token,
    );
    expect(stream.code).toBe(201);
    const streamId = (stream.json as { data: { id: string } }).data.id;
    const income = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "income", amount: "100.00", accountId: cashId, description: "October pay" },
      token,
    );
    const txnId = (income.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const match = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/income-streams/${streamId}/match`,
      { transactionId: txnId },
      token,
    );
    expect([200, 201]).toContain(match.code);
    const again = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/income-streams/${streamId}/match`,
      { transactionId: txnId },
      token,
    );
    expect(again.code).toBe(422);
  });

  it("K1–K3 goals allocate schedule", async () => {
    const goal = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/goals`,
      { name: "Emergency", target: "10000.00", fundingAccountId: savingsId },
      token,
    );
    expect(goal.code).toBe(201);
    const goalId = (goal.json as { data: { id: string } }).data.id;
    const allocate = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/goals/${goalId}/allocate`,
      { fromAccountId: cashId, amount: "200.00", operationId: testId() },
      token,
    );
    expect(allocate.code).toBe(201);
    const schedule = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/goals/${goalId}/schedule`,
      { amount: "50.00", nextAt: "2026-11-01T00:00:00.000Z" },
      token,
    );
    expect([200, 201]).toContain(schedule.code);
  });

  it("L1–L4 debts borrow repay lend collect", async () => {
    const owe = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/debts`,
      { direction: "i_owe", counterparty: "Ada", principal: "0.00" },
      token,
    );
    expect(owe.code).toBe(201);
    const debtId = (owe.json as { data: { id: string } }).data.id;
    const borrow = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/debts/${debtId}/borrow`,
      { cashAccountId: cashId, amount: "500.00", operationId: testId() },
      token,
    );
    expect(borrow.code).toBe(201);
    const repay = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/debts/${debtId}/repay`,
      { cashAccountId: cashId, principal: "10.00", interest: "2.00", operationId: testId() },
      token,
    );
    expect(repay.code).toBe(201);

    const lendDebt = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/debts`,
      { direction: "owed_to_me", counterparty: "Bola", principal: "0.00" },
      token,
    );
    const lendId = (lendDebt.json as { data: { id: string } }).data.id;
    const lend = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/debts/${lendId}/lend`,
      { cashAccountId: cashId, amount: "80.00", operationId: testId() },
      token,
    );
    expect(lend.code).toBe(201);
    const collect = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/debts/${lendId}/collect`,
      { cashAccountId: cashId, amount: "20.00", operationId: testId() },
      token,
    );
    expect(collect.code).toBe(201);
  });

  it("N1–N4 U4 refund occurredAt receivable reconcile split", async () => {
    const expense = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      {
        operationId: testId(),
        type: "expense",
        amount: "12.00",
        accountId: cashId,
        description: "Shoes",
        occurredAt: "2026-10-01T10:00:00.000Z",
      },
      token,
    );
    expect(expense.code).toBe(201);
    const expId = (expense.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const spentOf = async () => {
      const res = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard?from=2026-10-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z`, undefined, token);
      return Number.parseFloat((res.json as { data: { expense: { value: string } } }).data.expense.value);
    };
    const spentBefore = await spentOf();
    const refund = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      {
        operationId: testId(),
        type: "refund",
        amount: "4.00",
        accountId: cashId,
        originalTransactionId: expId,
        description: "Partial refund",
      },
      token,
    );
    expect(refund.code).toBe(201);
    const offset = await http(app, "GET", `/v1/workspaces/${workspaceId}/transactions/${expId}/offset`, undefined, token);
    expect((offset.json as { data: { remaining: string } }).data.remaining).toBe("8.00");
    // TC-07: the refund comes off the expense total, and can't exceed what's left of the original.
    expect(await spentOf()).toBeCloseTo(spentBefore - 4, 2);
    const tooMuch = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "refund", amount: "8.01", accountId: cashId, originalTransactionId: expId, description: "Too much" },
      token,
    );
    expect(tooMuch.code).toBe(400);

    const parent = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "9.00", accountId: cashId, description: "Split me" },
      token,
    );
    const parentId = (parent.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const split = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions/${parentId}/splits`,
      { lines: [{ amount: "3.00" }, { amount: "6.00" }] },
      token,
    );
    expect([200, 201]).toContain(split.code);

    const recv = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Invoice", kind: "receivable", opening: "0.00" },
      token,
    );
    expect(recv.code).toBe(201);

    const rec = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts/${cashId}/reconcile`,
      { externalBalance: "1.00", asOf: "2026-10-17" },
      token,
    );
    expect([200, 201]).toContain(rec.code);
    expect(typeof (rec.json as { data: { difference: string } }).data.difference).toBe("string");
  });

  it("plan lists return amounts, never a silent zero", async () => {
    const post = (path: string, body: Record<string, unknown>) =>
      http(app, "POST", `/v1/workspaces/${workspaceId}/${path}`, body, token);
    const list = async (path: string) =>
      ((await http(app, "GET", `/v1/workspaces/${workspaceId}/${path}`, undefined, token)).json as {
        data: Record<string, unknown>[];
      }).data;
    expect((await post("bills", { name: "Gym plan", amount: "5000.00", cadence: "monthly", accountId: cashId })).code).toBe(201);
    expect((await post("goals", { name: "Laptop fund", target: "7500.50" })).code).toBe(201);
    expect((await post("debts", { direction: "i_owe", counterparty: "Bisi", principal: "1200.00" })).code).toBe(201);
    expect((await post("income-streams", { name: "Side gig", expected: "30000.00", taxClass: "business" })).code).toBe(201);
    expect((await list("bills")).find((row) => row.name === "Gym plan")?.amount).toBe("5000.00");
    expect((await list("goals")).find((row) => row.name === "Laptop fund")?.target).toBe("7500.50");
    expect((await list("debts")).find((row) => row.counterparty === "Bisi")?.principal).toBe("1200.00");
    expect((await list("income-streams")).find((row) => row.name === "Side gig")?.expected).toBe("30000.00");
    const { MONGO_DB } = await import("@/database/mongo/mongo.constants");
    const db = app.get(MONGO_DB);
    await db.collection("bills").insertOne({
      _id: "bill-long",
      workspaceId,
      name: "DSTV Long",
      cadence: "monthly",
      amountMinor: { low: 500000, high: 0 },
    });
    expect((await list("bills")).find((row) => row.name === "DSTV Long")?.amount).toBe("5000.00");
    const today = new Date().toISOString().slice(0, 10);
    for (const bill of await list("bills")) {
      expect(String(bill.nextDue)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(bill.nextDue) >= today).toBe(true);
    }
  });

  it("the lock-screen setting round-trips through /auth/me", async () => {
    const me = async () => ((await http(app, "GET", "/v1/auth/me", undefined, token)).json as { hideLockScreenAmounts: boolean }).hideLockScreenAmounts;
    expect(await me()).toBe(true);
    expect((await http(app, "PATCH", "/v1/me/settings", { hideLockScreenAmounts: false }, token)).code).toBe(200);
    expect(await me()).toBe(false);
    await http(app, "PATCH", "/v1/me/settings", { hideLockScreenAmounts: true }, token);
    expect(await me()).toBe(true);
  });

  it("budget views use workspace timezone not Lagos", async () => {
    await http(app, "PATCH", `/v1/workspaces/${workspaceId}/setup`, { timezone: "America/New_York" }, token);
    const budget = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/budgets`,
      { accountId: cashId, amount: "8000.00", primaryPeriod: "day" },
      token,
    );
    const budgetId = (budget.json as { data: { id: string } }).data.id;
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      {
        operationId: testId(),
        type: "expense",
        amount: "250.00",
        accountId: cashId,
        description: "NY day",
        occurredAt: "2026-10-18T03:30:00.000Z",
      },
      token,
    );
    const ops = harness.app.get(LedgerOpsService);
    const now = new Date("2026-10-17T20:00:00.000Z");
    const ny = await ops.budgetViews(userId, workspaceId, budgetId, now);
    expect(ny.data.views.day.value).toBe("250.00");
    await http(app, "PATCH", `/v1/workspaces/${workspaceId}/setup`, { timezone: "Africa/Lagos" }, token);
    const lagos = await ops.budgetViews(userId, workspaceId, budgetId, now);
    expect(lagos.data.views.day.value).toBe("0.00");
    await http(app, "PATCH", `/v1/workspaces/${workspaceId}/setup`, { timezone: "Africa/Lagos" }, token);
  });

  it("M1 dashboard figures + S1 search min 2", async () => {
    const dash = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect(dash.code).toBe(200);
    const data = (dash.json as { data: { income: { value: string }; expense: { value: string }; netWorth: { value: string } } }).data;
    expect(data.income.value).toMatch(/^\d+\.\d{2}$/);
    expect(data.expense.value).toMatch(/^\d+\.\d{2}$/);
    const short = await http(app, "GET", `/v1/workspaces/${workspaceId}/search?q=D`, undefined, token);
    expect(short.code).toBe(400);
    const found = await http(app, "GET", `/v1/workspaces/${workspaceId}/search?q=DST`, undefined, token);
    expect(found.code).toBe(200);
    const bills = (found.json as { data: { bills: { label: string }[] } }).data.bills;
    expect(bills.some((row) => row.label === "DSTV")).toBe(true);
    const txSearch = await http(app, "GET", `/v1/workspaces/${workspaceId}/search?q=${encodeURIComponent("an")}`, undefined, token);
    const txHits = (txSearch.json as { data: { transactions: { amount?: string; type?: string }[] } }).data.transactions;
    for (const hit of txHits) {
      expect(hit.amount).toMatch(/^-?\d+\.\d{2}$/);
      expect(typeof hit.type).toBe("string");
    }
  });

  it("O1–O3 CSV preview commit export formula escape", async () => {
    const csv = `posted_at,narration,amount,type
2026-10-02,Market,25.00,expense
not-a-date,Bad,1.00,expense
2026-10-03,=HYPERLINK("http://x"),3.00,expense`;
    const preview = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/imports/preview`,
      { text: csv },
      token,
    );
    expect([200, 201]).toContain(preview.code);
    const previewData = preview.json as { data: { importId: string; accepted: unknown[]; rejected: unknown[] } };
    expect(previewData.data.accepted.length).toBe(2);
    expect(previewData.data.rejected.length).toBe(1);
    const commit = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/imports/${previewData.data.importId}/commit`,
      { operationId: testId(), accountId: cashId },
      token,
    );
    expect([200, 201]).toContain(commit.code);
    const again = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/imports/${previewData.data.importId}/commit`,
      { operationId: testId(), accountId: cashId },
      token,
    );
    expect((again.json as { data: { ids: string[] } }).data.ids).toEqual((commit.json as { data: { ids: string[] } }).data.ids);

    const res = await fetch(`${await app.getUrl()}/v1/workspaces/${workspaceId}/exports/transactions.csv`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(text).toContain("'=HYPERLINK");

    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "1.00", accountId: cashId, description: "\t=cmd" },
      token,
    );
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      { operationId: testId(), type: "expense", amount: "1.00", accountId: cashId, description: "\r=cmd" },
      token,
    );
    const guarded = await fetch(`${await app.getUrl()}/v1/workspaces/${workspaceId}/exports/transactions.csv`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const guardedText = await guarded.text();
    expect(guardedText).toContain("'=cmd");
  });

  it("Q1 hide amounts sessions deletion wipe order", async () => {
    const hide = await http(app, "PATCH", "/v1/me/settings", { hideLockScreenAmounts: true }, token);
    expect(hide.code).toBe(200);
    const sessions = await http(app, "GET", "/v1/me/sessions", undefined, token);
    expect(sessions.code).toBe(200);
    const sessionRows = (sessions.json as { data: { id: string; deviceLabel?: string }[] }).data;
    expect(sessionRows.length).toBeGreaterThan(0);
    expect(sessionRows[0].deviceLabel).toBeTruthy();
    const start = await http(app, "POST", "/v1/me/deletion", {}, token);
    expect(start.code).toBe(201);
    const ops = harness.app.get(LedgerOpsService);
    expect(ops.wipeOrder()).toEqual([
      "users",
      "sessions",
      "memberships",
      "workspaces",
      "accounts",
      "transactions",
      "operations",
      "categories",
      "merchants",
      "budgets",
      "bills",
      "reminder_occurrences",
      "income_streams",
      "income_matches",
      "goals",
      "goal_schedules",
      "debts",
      "imports",
      "import_rows",
      "reconciliation_events",
    ]);
  });

  it("C1 viewer can read dashboard and cannot write budgets", async () => {
    const guest = await registerAndVerify(app, mailer, "viewer@example.com");
    const login = await http(app, "POST", "/v1/auth/login", { email: "viewer@example.com", password: TEST_PASSWORD });
    const guestToken = (login.json as { accessToken: string }).accessToken;
    await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/members`,
      { userId: guest.userId, role: "viewer" },
      token,
    );
    const dash = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, guestToken);
    expect(dash.code).toBe(200);
    const search = await http(app, "GET", `/v1/workspaces/${workspaceId}/search?q=DS`, undefined, guestToken);
    expect(search.code).toBe(200);
    const write = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/budgets`,
      { accountId: cashId, amount: "1.00" },
      guestToken,
    );
    expect(write.code).toBe(403);
    const exported = await fetch(`${await app.getUrl()}/v1/workspaces/${workspaceId}/exports/transactions.csv`, {
      headers: { authorization: `Bearer ${guestToken}` },
    });
    expect(exported.status).toBe(403);
  });

  it("Q1 resume cursor then Q2 revoke rejects that token", async () => {
    const listed = await http(app, "GET", "/v1/me/sessions", undefined, token);
    const id = (listed.json as { data: { id: string }[] }).data[0]?.id;
    expect(id).toBeTruthy();
    await http(app, "DELETE", `/v1/me/sessions/${id}`, undefined, token);
    const after = await http(app, "GET", `/v1/workspaces/${workspaceId}/dashboard`, undefined, token);
    expect(after.code).toBe(401);
    const ops = harness.app.get(LedgerOpsService);
    const first = await ops.runDeletion(userId);
    const second = await ops.runDeletion(userId);
    expect(second.data.cursor).toBe((first.data.cursor ?? 0) + 1);
  });
});


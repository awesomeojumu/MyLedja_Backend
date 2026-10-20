import { INestApplication } from "@nestjs/common";
import { http, registerAndVerify, startLedgerApp, TEST_PASSWORD, testId } from "@/modules/accounts/tests/test-app";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import { TestApp } from "@/modules/auth/tests/test-app";

jest.setTimeout(120_000);

/** The month a date falls in, in Lagos time (UTC+1, no daylight saving). */
function lagosMonth(offset = 0): { key: string; year: number; month: number } {
  const lagos = new Date(Date.now() + 3600_000);
  const d = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth() + offset, 1));
  return { key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function lastDay(year: number, month: number): string {
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

type Group = { kind: string; count: number; amount: string; moved: string; noDeadline: number; items: { refId: string; amount: string; moved: string; monthsLeft: number; due: string | null }[] };
type MonthView = {
  month: string;
  income: { expected: string; received: string; streams: { name: string; account: string | null }[] };
  setAside: { amount: string; groups: Group[] };
  spending: { planned: string; spent: string; unplannedSpent: string; lines: { categoryId: string; name: string; planned: string; spent: string }[] };
  safeToSpend: string;
  safeLeft: string;
  free: string;
};

describe("monthly budget", () => {
  let harness: TestApp;
  let app: INestApplication;
  let mailer: CaptureMailer;
  let token: string;
  let ws: string;
  let gtb: string;
  let savings: string;

  const post = async (path: string, body: unknown) => http(app, "POST", `/v1/workspaces/${ws}${path}`, body, token);
  const view = async (month: string) => {
    const res = await http(app, "GET", `/v1/workspaces/${ws}/month-budgets/${month}`, undefined, token);
    expect(res.code).toBe(200);
    return (res.json as { data: MonthView }).data;
  };
  const group = (v: MonthView, kind: string) => v.setAside.groups.find((g) => g.kind === kind)!;

  beforeAll(async () => {
    harness = await startLedgerApp();
    app = harness.app;
    mailer = harness.mailer;
    const ids = await registerAndVerify(app, mailer, "budgeter@example.com");
    ws = ids.workspaceId;
    token = ((await http(app, "POST", "/v1/auth/login", { email: "budgeter@example.com", password: TEST_PASSWORD })).json as { accessToken: string }).accessToken;
    const made = await post("/accounts", { name: "GTBank", kind: "cash", opening: "2000000.00" });
    if (!(made.json as { data?: unknown }).data) throw new Error(JSON.stringify(made));
    gtb = (made.json as { data: { id: string } }).data.id;
    savings = ((await post("/accounts", { name: "Car fund", kind: "savings", opening: "0.00" })).json as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("works the month out from income, deadlines and the spending plan, and tracks progress", async () => {
    const now = lagosMonth();
    const rentDue = lagosMonth(3);

    expect((await post("/income-streams", { name: "Salary", expected: "1000000.00", taxClass: "paye", payDay: 25 })).code).toBe(201);
    expect((await post("/income-streams", { name: "Consulting", expected: "500000.00", taxClass: "business" })).code).toBe(201);
    // Yearly rent due on the 1st, three months from now: this month and the next two share it.
    const rent = ((await post("/bills", { name: "Rent", amount: "1500000.00", cadence: "yearly", anchorDay: 1, anchorMonth: rentDue.month + 1 })).json as { data: { id: string } }).data.id;
    const bad = await post("/bills", { name: "Odd", amount: "1.00", cadence: "yearly", anchorMonth: 13 });
    expect(bad.code).toBe(400);
    // A car by the end of the month eleven months from now: twelve months to save.
    const carDue = lagosMonth(11);
    const car = ((await post("/goals", { name: "Buy a car", target: "6000000.00", fundingAccountId: savings, dueAt: lastDay(carDue.year, carDue.month) })).json as { data: { id: string } }).data.id;
    await post("/goals", { name: "Someday", target: "100000.00", fundingAccountId: savings });
    // A ₦500k loan to clear by the end of the month four months from now: five months.
    const loanDue = lagosMonth(4);
    const loan = ((await post("/debts", { direction: "i_owe", counterparty: "Uncle", principal: "0.00", payoffBy: lastDay(loanDue.year, loanDue.month) })).json as { data: { id: string } }).data.id;
    expect((await post(`/debts/${loan}/borrow`, { cashAccountId: gtb, amount: "500000.00", operationId: testId() })).code).toBe(201);

    const food = ((await post("/categories", { name: "Food budget test", kind: "expense" })).json as { data: { id: string } }).data.id;
    const transport = ((await post("/categories", { name: "Transport budget test", kind: "expense" })).json as { data: { id: string } }).data.id;

    let v = await view(now.key);
    expect(v.income.expected).toBe("1500000.00");
    expect(v.income.streams.map((s) => s.name).sort()).toEqual(["Consulting", "Salary"]);
    const bills = group(v, "bill");
    expect(bills.items.find((i) => i.refId === rent)).toMatchObject({ amount: "500000.00", monthsLeft: 3 });
    const goals = group(v, "goal");
    expect(goals.items.find((i) => i.refId === car)).toMatchObject({ amount: "500000.00", monthsLeft: 12 });
    expect(goals.noDeadline).toBe(1);
    expect(group(v, "debt").items.find((i) => i.refId === loan)).toMatchObject({ amount: "100000.00", monthsLeft: 5 });
    expect(v.setAside.amount).toBe("1100000.00");
    expect(v.safeToSpend).toBe("400000.00");
    expect(v.spending.lines).toEqual([]);

    // Plan the month's spending.
    const put = await http(app, "PUT", `/v1/workspaces/${ws}/month-budgets/${now.key}/lines`, { lines: [{ categoryId: food, amount: "150000.00" }, { categoryId: transport, amount: "80000.00" }] }, token);
    expect(put.code).toBe(200);
    const dup = await http(app, "PUT", `/v1/workspaces/${ws}/month-budgets/${now.key}/lines`, { lines: [{ categoryId: food, amount: "1.00" }, { categoryId: food, amount: "2.00" }] }, token);
    expect(dup.code).toBe(400);
    const unknown = await http(app, "PUT", `/v1/workspaces/${ws}/month-budgets/${now.key}/lines`, { lines: [{ categoryId: "nope", amount: "1.00" }] }, token);
    expect(unknown.code).toBe(400);

    // Spend, earn, save toward the car, repay the loan, pay rent.
    await post("/transactions", { operationId: testId(), type: "expense", amount: "40000.00", accountId: gtb, categoryId: food, description: "Market" });
    await post("/transactions", { operationId: testId(), type: "expense", amount: "12000.00", accountId: gtb, categoryId: transport, description: "Bolt" });
    await post("/transactions", { operationId: testId(), type: "expense", amount: "3000.00", accountId: gtb, description: "Snacks" });
    await post("/transactions", { operationId: testId(), type: "income", amount: "500000.00", accountId: gtb, description: "Consulting pay" });
    expect((await post(`/goals/${car}/allocate`, { fromAccountId: gtb, amount: "100000.00", operationId: testId() })).code).toBe(201);
    expect((await post(`/debts/${loan}/repay`, { cashAccountId: gtb, principal: "100000.00", interest: "0.00", operationId: testId() })).code).toBe(201);
    expect((await post(`/bills/${rent}/paid`, { accountId: gtb, operationId: testId() })).code).toBeLessThan(300);

    v = await view(now.key);
    // Paying this month counts as progress; it doesn't move this month's targets.
    expect(group(v, "goal").items.find((i) => i.refId === car)).toMatchObject({ amount: "500000.00", moved: "100000.00" });
    expect(group(v, "debt").items.find((i) => i.refId === loan)).toMatchObject({ amount: "100000.00", moved: "100000.00" });
    expect(group(v, "bill").items.find((i) => i.refId === rent)).toMatchObject({ amount: "500000.00", moved: "500000.00" });
    expect(group(v, "bill").moved).toBe("500000.00");
    expect(v.income.received).toBe("500000.00");
    // Rent's payment is a bill, not everyday spending.
    expect(v.spending.spent).toBe("55000.00");
    expect(v.spending.planned).toBe("230000.00");
    expect(v.spending.unplannedSpent).toBe("3000.00");
    expect(v.spending.lines.find((l) => l.categoryId === food)).toMatchObject({ planned: "150000.00", spent: "40000.00" });
    expect(v.safeLeft).toBe("345000.00");
    expect(v.free).toBe("170000.00");

    // Next month copies this month's spending plan.
    const next = await view(lagosMonth(1).key);
    expect(next.spending.lines.map((l) => l.planned).sort()).toEqual(["150000.00", "80000.00"]);
  });

  it("refuses a bad month", async () => {
    const res = await http(app, "GET", `/v1/workspaces/${ws}/month-budgets/2027-13`, undefined, token);
    expect(res.code).toBe(400);
  });
});

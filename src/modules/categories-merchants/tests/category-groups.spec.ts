import { INestApplication } from "@nestjs/common";
import { http, registerAndVerify, startLedgerApp, TEST_PASSWORD, testId } from "@/modules/accounts/tests/test-app";
import { TestApp } from "@/modules/auth/tests/test-app";

jest.setTimeout(120_000);

type Category = { id: string; name: string; kind: string; groupId: string | null };
type Group = { id: string; name: string; kind: string };

describe("category groups and deleting categories", () => {
  let harness: TestApp;
  let app: INestApplication;
  let token: string;
  let ws: string;
  let cash: string;

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) => http(app, method, `/v1/workspaces/${ws}${path}`, body, token);
  const categories = async () => ((await call("GET", "/categories")).json as { data: Category[] }).data;
  const groups = async () => ((await call("GET", "/category-groups")).json as { data: Group[] }).data;

  beforeAll(async () => {
    harness = await startLedgerApp();
    app = harness.app;
    const ids = await registerAndVerify(app, harness.mailer, "grouper@example.com");
    ws = ids.workspaceId;
    token = ((await http(app, "POST", "/v1/auth/login", { email: "grouper@example.com", password: TEST_PASSWORD })).json as { accessToken: string }).accessToken;
    cash = ((await call("POST", "/accounts", { name: "Cash", kind: "cash", opening: "100000.00" })).json as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("puts income categories in an Income group the first time, once", async () => {
    const list = await categories();
    const income = await groups();
    expect(income).toHaveLength(1);
    expect(income[0]).toMatchObject({ name: "Income", kind: "income" });
    const incomeCats = list.filter((c) => c.kind === "income");
    expect(incomeCats.length).toBeGreaterThan(0);
    expect(incomeCats.every((c) => c.groupId === income[0].id)).toBe(true);
    expect(list.filter((c) => c.kind === "expense").every((c) => c.groupId === null)).toBe(true);
    // Deleting the group doesn't bring it back on the next list.
    expect((await call("DELETE", `/category-groups/${income[0].id}`)).code).toBe(200);
    expect(await groups()).toHaveLength(0);
    expect((await categories()).every((c) => c.groupId === null)).toBe(true);
  });

  it("creates, renames and groups categories; the group sets the type", async () => {
    const travel = ((await call("POST", "/category-groups", { name: "Getting around" })).json as { data: Group }).data;
    expect(travel.kind).toBe("expense");
    expect((await call("POST", "/category-groups", { name: "getting AROUND" })).code).toBe(400);
    expect((await call("POST", "/category-groups", { name: "  " })).code).toBe(400);
    const earn = ((await call("POST", "/category-groups", { name: "Earnings", kind: "income" })).json as { data: Group }).data;

    const bolt = ((await call("POST", "/categories", { name: "Rides", groupId: travel.id })).json as { data: Category }).data;
    expect(bolt).toMatchObject({ groupId: travel.id, kind: "expense" });
    // Moving an unused category into an income group makes it income.
    const moved = ((await call("PATCH", `/categories/${bolt.id}`, { groupId: earn.id })).json as { data: Category }).data;
    expect(moved).toMatchObject({ groupId: earn.id, kind: "income" });
    const ungrouped = ((await call("PATCH", `/categories/${bolt.id}`, { groupId: null, name: "Tips" })).json as { data: Category }).data;
    expect(ungrouped).toMatchObject({ groupId: null, name: "Tips" });
    expect((await call("POST", "/categories", { name: "X", groupId: "nope" })).code).toBe(400);

    const renamed = ((await call("PATCH", `/category-groups/${travel.id}`, { name: "Transport" })).json as { data: Group }).data;
    expect(renamed.name).toBe("Transport");
  });

  it("deletes a category in use only with a place to move its records", async () => {
    const food = ((await call("POST", "/categories", { name: "Food here", kind: "expense" })).json as { data: Category }).data;
    const groceries = ((await call("POST", "/categories", { name: "Groceries here", kind: "expense" })).json as { data: Category }).data;
    const salary = (await categories()).find((c) => c.kind === "income")!;
    await call("POST", "/transactions", { operationId: testId(), type: "expense", amount: "2500.00", accountId: cash, categoryId: food.id, description: "Lunch" });
    const month = new Date(Date.now() + 3600_000).toISOString().slice(0, 7);
    expect(
      (await call("PUT", `/month-budgets/${month}/lines`, { lines: [{ categoryId: food.id, amount: "10000.00" }, { categoryId: groceries.id, amount: "5000.00" }] })).code,
    ).toBe(200);

    expect((await call("POST", `/categories/${food.id}/delete`, {})).code).toBe(400);
    expect((await call("POST", `/categories/${food.id}/delete`, { moveTo: salary.id })).code).toBe(400);
    expect((await call("POST", `/categories/${food.id}/delete`, { moveTo: food.id })).code).toBe(400);
    const done = await call("POST", `/categories/${food.id}/delete`, { moveTo: groceries.id });
    expect(done.code).toBe(200);

    expect((await categories()).some((c) => c.id === food.id)).toBe(false);
    const view = ((await call("GET", `/month-budgets/${month}`)).json as { data: { spending: { lines: { categoryId: string; planned: string; spent: string }[] } } }).data;
    expect(view.spending.lines).toEqual([expect.objectContaining({ categoryId: groceries.id, planned: "15000.00", spent: "2500.00" })]);

    // Unused categories delete straight away.
    const spare = ((await call("POST", "/categories", { name: "Spare", kind: "expense" })).json as { data: Category }).data;
    expect((await call("POST", `/categories/${spare.id}/delete`, {})).code).toBe(200);

    const history = ((await call("GET", "/month-budgets")).json as { data: { month: string; current: boolean; planned: string }[] }).data;
    expect(history[0]).toMatchObject({ month, current: true, planned: "15000.00" });
  });
});

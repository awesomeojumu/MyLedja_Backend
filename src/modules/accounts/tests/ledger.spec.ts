import { INestApplication } from "@nestjs/common";
import { ACCOUNTS_COLLECTION, AccountDoc } from "@/modules/accounts/schemas/account";
import { http, registerAndVerify, startLedgerApp, TEST_PASSWORD, testId } from "@/modules/accounts/tests/test-app";
import { CaptureMailer } from "@/modules/auth/domain/mailer";
import { TestApp } from "@/modules/auth/tests/test-app";

jest.setTimeout(120_000);

describe("accounts, ledger, catalog, setup", () => {
  let harness: TestApp;
  let app: INestApplication;
  let mailer: CaptureMailer;
  let token: string;
  let workspaceId: string;

  beforeAll(async () => {
    harness = await startLedgerApp();
    app = harness.app;
    mailer = harness.mailer;
    const ids = await registerAndVerify(app, mailer, "ledger@example.com");
    workspaceId = ids.workspaceId;
    const login = await http(app, "POST", "/v1/auth/login", {
      email: "ledger@example.com",
      password: TEST_PASSWORD,
    });
    token = (login.json as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("FR-ACC + INV-06 + FR-ACC-09 + archive", async () => {
    const bad = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Bad", kind: "bank", institutionId: "not-a-bank", opening: "0.00" },
      token,
    );
    expect(bad.code).toBe(400);

    const created = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      {
        name: "GTBank Current",
        kind: "bank",
        institutionId: "gtbank",
        connectionType: "manual",
        opening: "10000.00",
        accountNumber: "0131883465",
      },
      token,
    );
    expect(created.code).toBe(201);
    const account = (created.json as { data: { id: string; mask: string; connectionType: string; institutionId: string; balance: string } }).data;
    expect(account.institutionId).toBe("gtbank");
    expect(account.connectionType).toBe("manual");
    expect(account.mask).toBe("3465");
    expect(account.balance).toBe("10000.00");

    const stored = await harness.db.collection<AccountDoc>(ACCOUNTS_COLLECTION).findOne({ _id: account.id });
    expect(stored?.accountNumberCipher).not.toContain("0131883465");
    expect(String(stored?.mask)).not.toBe("0131883465");
    expect(stored?.accountNumberCipher).toBeTruthy();

    const cash = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts`,
      { name: "Cash", kind: "cash", opening: "0.00", connectionType: "manual" },
      token,
    );
    expect(cash.code).toBe(201);
    const cashId = (cash.json as { data: { id: string } }).data.id;
    const kindBad = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts/${cashId}/kind`,
      { kind: "not-a-type" },
      token,
    );
    expect(kindBad.code).toBe(400);
    const kindOk = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts/${cashId}/kind`,
      { kind: "bank" },
      token,
    );
    expect(kindOk.code).toBe(201);
    expect((kindOk.json as { data: { kind: string } }).data.kind).toBe("bank");
    expect((await harness.db.collection<AccountDoc>(ACCOUNTS_COLLECTION).findOne({ _id: cashId }))?.kind).toBe("bank");

    const cats = await http(app, "GET", `/v1/workspaces/${workspaceId}/categories`, undefined, token);
    expect(cats.code).toBe(200);
    const salary = (cats.json as { data: { id: string; name: string }[] }).data.find((row) => row.name === "Salary");
    const food = (cats.json as { data: { id: string; name: string }[] }).data.find((row) => row.name === "Food & groceries");
    expect(salary && food).toBeTruthy();

    const mismatch = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      {
        operationId: testId(),
        type: "expense",
        amount: "1000.00",
        accountId: account.id,
        categoryId: salary?.id,
        description: "Wrong",
      },
      token,
    );
    expect(mismatch.code).toBe(422);

    const expense = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      {
        operationId: testId(),
        type: "expense",
        amount: "1000.00",
        accountId: account.id,
        categoryId: food?.id,
        description: "Market",
      },
      token,
    );
    expect(expense.code).toBe(201);
    const totals = (expense.json as { data: { totals: { income: string; expense: string } } }).data.totals;
    expect(totals.income).toBe("0.00");
    expect(totals.expense).toBe("1000.00");

    const listed = await http(app, "GET", `/v1/workspaces/${workspaceId}/accounts`, undefined, token);
    const gt = (listed.json as { data: { id: string; balance: string }[] }).data.find((row) => row.id === account.id);
    expect(gt?.balance).toBe("9000.00");

    const archived = await http(app, "DELETE", `/v1/workspaces/${workspaceId}/accounts/${account.id}`, undefined, token);
    expect(archived.code).toBe(200);
    expect((archived.json as { data: { archived: boolean } }).data.archived).toBe(true);
    const still = await harness.db.collection<AccountDoc>(ACCOUNTS_COLLECTION).findOne({ _id: account.id });
    expect(still).toBeTruthy();
    expect(still?.archivedAt).toBeTruthy();

    const liveAfterArchive = await http(app, "GET", `/v1/workspaces/${workspaceId}/accounts`, undefined, token);
    expect(
      (liveAfterArchive.json as { data: { id: string }[] }).data.some((row) => row.id === account.id),
    ).toBe(false);

    const one = await http(app, "GET", `/v1/workspaces/${workspaceId}/accounts/${cashId}`, undefined, token);
    expect(one.code).toBe(200);
    expect((one.json as { data: { id: string } }).data.id).toBe(cashId);

    const renamed = await http(
      app,
      "PATCH",
      `/v1/workspaces/${workspaceId}/accounts/${cashId}`,
      { name: "Till" },
      token,
    );
    expect(renamed.code).toBe(200);
    const renamedBody = (renamed.json as { data: { name: string; balance: string; opening: string } }).data;
    expect(renamedBody.name).toBe("Till");
    expect(renamedBody.balance).toBe((one.json as { data: { balance: string } }).data.balance);
    expect(renamedBody.opening).toBe((one.json as { data: { opening: string } }).data.opening);

    const archiveCash = await http(app, "DELETE", `/v1/workspaces/${workspaceId}/accounts/${cashId}`, undefined, token);
    expect(archiveCash.code).toBe(200);
    const renameArchived = await http(
      app,
      "PATCH",
      `/v1/workspaces/${workspaceId}/accounts/${cashId}`,
      { name: "Nope" },
      token,
    );
    expect(renameArchived.code).toBe(409);

    const restored = await http(app, "POST", `/v1/workspaces/${workspaceId}/accounts/${account.id}/restore`, {}, token);
    expect(restored.code).toBe(201);
    expect((restored.json as { data: { archived: boolean } }).data.archived).toBe(false);
    const liveAgain = await http(app, "GET", `/v1/workspaces/${workspaceId}/accounts`, undefined, token);
    expect((liveAgain.json as { data: { id: string }[] }).data.some((row) => row.id === account.id)).toBe(true);
    const postAgain = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/transactions`,
      {
        operationId: testId(),
        type: "expense",
        amount: "1.00",
        accountId: account.id,
        description: "After restore",
      },
      token,
    );
    expect(postAgain.code).toBe(201);

    const firstCompare = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts/${account.id}/reconcile`,
      { externalBalance: "8000.00" },
      token,
    );
    expect(firstCompare.code).toBe(201);
    const secondCompare = await http(
      app,
      "POST",
      `/v1/workspaces/${workspaceId}/accounts/${account.id}/reconcile`,
      { externalBalance: "8999.00" },
      token,
    );
    expect(secondCompare.code).toBe(201);
    const history = await http(
      app,
      "GET",
      `/v1/workspaces/${workspaceId}/accounts/${account.id}/reconciliations`,
      undefined,
      token,
    );
    expect(history.code).toBe(200);
    const events = (history.json as { data: { calculated: string; reconciled: boolean }[] }).data;
    expect(events).toHaveLength(2);
    const got = await http(app, "GET", `/v1/workspaces/${workspaceId}/accounts/${account.id}`, undefined, token);
    expect(events[0]?.calculated).toBe((got.json as { data: { balance: string } }).data.balance);
  });

  it("TC-01 TC-02 TC-11 four statuses aliases preview journey", async () => {
    const email = "journey@example.com";
    const ids = await registerAndVerify(app, mailer, email);
    const login = await http(app, "POST", "/v1/auth/login", { email, password: TEST_PASSWORD });
    const tok = (login.json as { accessToken: string }).accessToken;
    const ws = ids.workspaceId;

    const from = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/accounts`,
      { name: "Bank", kind: "bank", institutionId: "access", opening: "5000.00" },
      tok,
    );
    const to = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/accounts`,
      { name: "Cash", kind: "cash", opening: "0.00" },
      tok,
    );
    const fromId = (from.json as { data: { id: string } }).data.id;
    const toId = (to.json as { data: { id: string } }).data.id;

    const cats = await http(app, "GET", `/v1/workspaces/${ws}/categories`, undefined, tok);
    const food = (cats.json as { data: { id: string; name: string }[] }).data.find((row) => row.name === "Food & groceries");
    await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/merchants`,
      { name: "Shoprite", categoryId: food?.id, aliases: ["PAYSTACK*SHOPRITE", "PAYSTACK"] },
      tok,
    );

    const expense = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/transactions`,
      {
        operationId: testId(),
        type: "expense",
        amount: "1500.00",
        accountId: fromId,
        categoryId: food?.id,
        description: "PAYSTACK*SHOPRITE IKOYI",
      },
      tok,
    );
    expect(expense.code).toBe(201);
    const expBody = expense.json as { data: { transaction: { id: string; merchantId: string | null }; totals: { expense: string; income: string } } };
    expect(expBody.data.totals.expense).toBe("1500.00");
    expect(expBody.data.transaction.merchantId).toBeTruthy();

    const listed = await http(app, "GET", `/v1/workspaces/${ws}/accounts`, undefined, tok);
    const bank = (listed.json as { data: { id: string; balance: string }[] }).data.find((row) => row.id === fromId);
    expect(bank?.balance).toBe("3500.00");

    const transfer = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/transactions`,
      {
        operationId: testId(),
        type: "transfer",
        amount: "200.00",
        accountId: fromId,
        toAccountId: toId,
        description: "Move",
      },
      tok,
    );
    expect(transfer.code).toBe(201);
    const afterTransfer = (transfer.json as { data: { totals: { income: string; expense: string } } }).data.totals;
    expect(afterTransfer.income).toBe("0.00");
    expect(afterTransfer.expense).toBe("1500.00");

    const op = testId();
    const first = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/transactions`,
      { operationId: op, type: "expense", amount: "10.00", accountId: fromId, description: "Airtime" },
      tok,
    );
    const again = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/transactions`,
      { operationId: op, type: "expense", amount: "10.00", accountId: fromId, description: "Airtime" },
      tok,
    );
    expect(first.code).toBe(201);
    expect(again.code).toBe(201);
    expect((first.json as { data: { transaction: { id: string } } }).data.transaction.id).toBe(
      (again.json as { data: { transaction: { id: string } } }).data.transaction.id,
    );
    const clash = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/transactions`,
      { operationId: op, type: "expense", amount: "99.00", accountId: fromId, description: "Other" },
      tok,
    );
    expect(clash.code).toBe(422);

    const pending = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/transactions`,
      {
        operationId: testId(),
        type: "expense",
        amount: "5.00",
        accountId: fromId,
        description: "Hold",
        status: "pending",
      },
      tok,
    );
    const pendingId = (pending.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const voided = await http(
      app,
      "PATCH",
      `/v1/workspaces/${ws}/transactions/${pendingId}/status`,
      { status: "voided" },
      tok,
    );
    expect(voided.code).toBe(200);
    const illegal = await http(
      app,
      "PATCH",
      `/v1/workspaces/${ws}/transactions/${pendingId}/status`,
      { status: "posted" },
      tok,
    );
    expect(illegal.code).toBe(400);

    const reverseSrc = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/transactions`,
      { operationId: testId(), type: "expense", amount: "1.00", accountId: fromId, description: "Undo me" },
      tok,
    );
    const rid = (reverseSrc.json as { data: { transaction: { id: string } } }).data.transaction.id;
    const reversed = await http(
      app,
      "PATCH",
      `/v1/workspaces/${ws}/transactions/${rid}/status`,
      { status: "reversed" },
      tok,
    );
    expect(reversed.code).toBe(200);

    const extra = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/transactions`,
      { operationId: testId(), type: "expense", amount: "3.00", accountId: fromId, description: "MTN" },
      tok,
    );
    expect(extra.code).toBe(201);
    const preview = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/rules/preview`,
      { descriptionContains: "PAYSTACK" },
      tok,
    );
    expect(preview.code).toBe(200);
    const idsOnly = (preview.json as { data: { transactionIds: string[] } }).data.transactionIds;
    expect(idsOnly).toEqual([expBody.data.transaction.id]);

    const grandchild = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/categories`,
      { name: "Ride", kind: "expense", parentId: food?.id },
      tok,
    );
    expect(grandchild.code).toBe(201);
    const deep = await http(
      app,
      "POST",
      `/v1/workspaces/${ws}/categories`,
      { name: "Too deep", kind: "expense", parentId: (grandchild.json as { data: { id: string } }).data.id },
      tok,
    );
    expect(deep.code).toBe(400);
  });
});

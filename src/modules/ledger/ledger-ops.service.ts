import { createHash } from "node:crypto";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Db } from "mongodb";
import { isId, newId } from "@/common/ids";
import { formatMoney, money, parseMoney } from "@/common/money/money";
import { nairaOrNull } from "@/common/money/naira-or-null";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import { AccountsRepository } from "@/modules/accounts/repositories/accounts.repository";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";
import { CreateTransaction } from "@/modules/transactions/application/create-transaction";
import { netSpend, periodTotals, spendLines } from "@/modules/transactions/application/totals";
import { TransactionsRepository } from "@/modules/transactions/repositories/transactions.repository";
import { UsersRepository } from "@/modules/users/repositories/users.repository";
import { requireCapability } from "@/modules/workspaces/domain/capabilities";
import { ResolveMembership } from "@/modules/workspaces/policies/resolve-membership";
import { MembershipsRepository } from "@/modules/workspaces/repositories/memberships.repository";
import { WorkspacesRepository } from "@/modules/workspaces/repositories/workspaces.repository";
import { csvCell } from "@/modules/imports-exports/csv-cell";
import { LedgerFailure } from "@/modules/transactions/domain/ledger-failure";
import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";
import { clampDay, weekBounds, zonedInstant } from "@/modules/calendar/period";

/** Plan lists return amounts as decimal strings; a row stored without one returns null, never "0.00". */
const WIPE = [
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
] as const;

function figure(value: string, basis: string, currency = "NGN") {
  return { value, currency, basis };
}

type Row = { _id?: string; [key: string]: unknown };

@Injectable()
export class LedgerOpsService implements OnModuleInit {
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly memberships: ResolveMembership,
    private readonly membershipRows: MembershipsRepository,
    private readonly workspaces: WorkspacesRepository,
    private readonly accounts: AccountsRepository,
    private readonly txns: TransactionsRepository,
    private readonly createTxn: CreateTransaction,
    private readonly sessions: SessionsRepository,
    private readonly users: UsersRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.docs("reminder_occurrences").createIndex({ workspaceId: 1, billId: 1, dueDate: 1 }, { unique: true });
    await this.docs("income_matches").createIndex({ streamId: 1, transactionId: 1 }, { unique: true });
    await this.docs("import_rows").createIndex({ workspaceId: 1, importId: 1, rowHash: 1 }, { unique: true });
  }

  private docs(name: string) {
    return this.db.collection<Row>(name);
  }

  private async member(userId: string, workspaceId: string, write: boolean) {
    const membership = await this.memberships.execute(userId, workspaceId);
    requireCapability(membership.role, write ? "write_records" : "view");
    return membership;
  }

  async netWorth(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.accounts.list(workspaceId, false);
    let net = 0n;
    for (const row of rows) {
      if (row.kind === "liability") net -= row.balanceMinor;
      else net += row.balanceMinor;
    }
    return {
      status: "ok" as const,
      data: {
        netWorth: formatMoney(money(net, "NGN")),
        currency: "NGN",
        basis: "Account balances only. Goals ignored.",
      },
      error: null,
    };
  }

  async dashboard(userId: string, workspaceId: string, from?: string, to?: string) {
    await this.member(userId, workspaceId, false);
    const posted = await this.txns.listPosted(workspaceId);
    const start = from ? new Date(from) : new Date(0);
    const end = to ? new Date(to) : new Date();
    const inRange = posted.filter((row) => {
      const at = row.occurredAt ?? row.createdAt;
      return at >= start && at <= end;
    });
    const totals = periodTotals(inRange, "NGN", posted);
    const lines = spendLines(inRange, posted);
    const nw = await this.netWorth(userId, workspaceId);
    const budgets = await this.docs("budgets").find({ workspaceId }).toArray();
    let remaining = 0n;
    for (const budget of budgets) {
      const spent = netSpend(lines.filter((line) => line.accountId === String(budget.accountId)));
      remaining += BigInt(budget.amountMinor as bigint | number | string) - spent;
    }
    let netCash = 0n;
    for (const row of inRange) {
      for (const effect of row.effects) netCash += effect.amountMinor;
    }
    return {
      status: "ok" as const,
      data: {
        income: figure(totals.income, "Posted income in this range. Transfers excluded."),
        expense: figure(totals.expense, "Posted expenses less their refunds in this range. Transfers excluded."),
        refund: figure(totals.refund ?? "0.00", "Posted refunds, already taken off the expense total."),
        netCash: figure(formatMoney(money(netCash, "NGN")), "Posted effects in this range, including refunds."),
        netWorth: figure(nw.data.netWorth, nw.data.basis),
        budgetRemaining: figure(formatMoney(money(remaining, "NGN")), "Primary period remaining across account budgets."),
      },
      error: null,
    };
  }

  async createBudget(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    if (!isId(body.accountId) || typeof body.amount !== "string") throw new LedgerFailure("bad_request", "accountId and amount required.");
    const period = body.primaryPeriod === "day" || body.primaryPeriod === "week" || body.primaryPeriod === "year" ? body.primaryPeriod : "month";
    const amount = parseMoney(body.amount, "NGN");
    const doc = {
      _id: newId(),
      workspaceId,
      accountId: body.accountId,
      primaryPeriod: period,
      amountMinor: amount.amountMinor,
      currency: "NGN",
    };
    await this.docs("budgets").insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id }, error: null };
  }

  async listBudgets(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("budgets").find({ workspaceId }).toArray();
    return { status: "ok" as const, data: rows.map((row) => ({ id: row._id, accountId: row.accountId, primaryPeriod: row.primaryPeriod, amount: formatMoney(money(BigInt(row.amountMinor as bigint), "NGN")) })), error: null };
  }

  async budgetViews(userId: string, workspaceId: string, budgetId: string, now = new Date()) {
    await this.member(userId, workspaceId, false);
    const budget = await this.docs("budgets").findOne({ _id: budgetId, workspaceId });
    if (!budget) throw new LedgerFailure("not_found", "not found");
    const workspace = await this.workspaces.findById(workspaceId);
    const weekStartsOn = workspace?.weekStartsOn ?? "monday";
    const timezone = workspace?.timezone ?? "Africa/Lagos";
    const zone = (at: Date) => zonedInstant(at, timezone);
    const all = await this.txns.listPosted(workspaceId);
    const lines = spendLines(all).filter((line) => line.accountId === String(budget.accountId));
    const spend = (from: Date, to: Date) =>
      netSpend(
        lines.filter((line) => {
          const at = zone(line.at);
          return at >= from && at <= to;
        }),
      );
    const local = zone(now);
    const dayFrom = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
    const dayTo = new Date(dayFrom.getTime() + 86400000 - 1);
    const week = weekBounds(local, weekStartsOn);
    const monthFrom = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
    const monthTo = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 1);
    const yearFrom = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
    const yearTo = new Date(Date.UTC(local.getUTCFullYear() + 1, 0, 1) - 1);
    const basis = "Posted expenses less their refunds in this range. Transfers excluded.";
    const views = {
      day: figure(formatMoney(money(spend(dayFrom, dayTo), "NGN")), basis),
      week: figure(formatMoney(money(spend(week.from, week.to), "NGN")), basis),
      month: figure(formatMoney(money(spend(monthFrom, monthTo), "NGN")), basis),
      year: figure(formatMoney(money(spend(yearFrom, yearTo), "NGN")), basis),
    };
    const spent = views[budget.primaryPeriod as "day" | "week" | "month" | "year"] ?? views.month;
    const remainingMinor = BigInt(budget.amountMinor as bigint) - parseMoney(spent.value, "NGN").amountMinor;
    return {
      status: "ok" as const,
      data: { spent: spent.value, remaining: formatMoney(money(remainingMinor, "NGN")), views },
      error: null,
    };
  }

  async createBill(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    if (typeof body.name !== "string" || typeof body.amount !== "string") throw new LedgerFailure("bad_request", "name and amount required.");
    const cadence = body.cadence === "weekly" || body.cadence === "yearly" ? body.cadence : "monthly";
    const amount = parseMoney(body.amount, "NGN");
    const doc = {
      _id: newId(),
      workspaceId,
      name: body.name,
      amountMinor: amount.amountMinor,
      currency: "NGN",
      cadence,
      anchorDay: typeof body.anchorDay === "number" ? body.anchorDay : 1,
      weekday: typeof body.weekday === "number" ? body.weekday : 1,
      accountId: typeof body.accountId === "string" ? body.accountId : null,
    };
    await this.docs("bills").insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id }, error: null };
  }

  async listBills(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("bills").find({ workspaceId }).toArray();
    const now = new Date();
    return {
      status: "ok" as const,
      data: rows.map((row) => ({
        id: row._id,
        name: row.name,
        cadence: row.cadence,
        amount: nairaOrNull(row.amountMinor),
        nextDue: this.nextDue(
          { cadence: String(row.cadence ?? "monthly"), anchorDay: Number(row.anchorDay ?? 1) || 1, weekday: Number(row.weekday ?? 1) || 0 },
          now,
        ),
      })),
      error: null,
    };
  }

  /** The next due date on or after today (YYYY-MM-DD). Reminders are scheduled from this. */
  nextDue(bill: { cadence: string; anchorDay: number; weekday: number }, now: Date): string {
    const today = now.toISOString().slice(0, 10);
    const due = this.dueFor(bill, now);
    if (bill.cadence === "weekly" || due >= today) return due;
    return clampDay(now.getUTCFullYear(), now.getUTCMonth() + 1, bill.anchorDay).toISOString().slice(0, 10);
  }

  dueFor(bill: { cadence: string; anchorDay: number; weekday: number }, now: Date): string {
    if (bill.cadence === "weekly") {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      while (d.getUTCDay() !== bill.weekday) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    }
    const month = now.getUTCMonth();
    const year = now.getUTCFullYear();
    const date = clampDay(year, month, bill.anchorDay);
    return date.toISOString().slice(0, 10);
  }

  async tickReminders(now = new Date()): Promise<number> {
    const bills = await this.docs("bills").find({}).toArray();
    let wrote = 0;
    for (const bill of bills) {
      const dueDate = this.dueFor(bill as unknown as { cadence: string; anchorDay: number; weekday: number }, now);
      try {
        await this.docs("reminder_occurrences").insertOne({
          _id: newId(),
          workspaceId: bill.workspaceId,
          billId: bill._id,
          dueDate,
        });
        wrote += 1;
      } catch {
        /* unique */
      }
    }
    return wrote;
  }

  async markPaid(userId: string, workspaceId: string, billId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    if (!isId(body.accountId) || !isId(body.operationId)) throw new LedgerFailure("bad_request", "accountId and operationId required.");
    const bill = await this.docs("bills").findOne({ _id: billId, workspaceId });
    if (!bill) throw new LedgerFailure("not_found", "not found");
    return this.createTxn.execute(userId, workspaceId, {
      operationId: String(body.operationId),
      type: "expense",
      amount: formatMoney(money(BigInt(bill.amountMinor as bigint), "NGN")),
      accountId: String(body.accountId),
      categoryId: typeof body.categoryId === "string" ? body.categoryId : undefined,
      description: String(bill.name),
    });
  }

  async createStream(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    if (body.taxClass !== "paye" && body.taxClass !== "business" && body.taxClass !== "other") {
      throw new LedgerFailure("bad_request", "taxClass required.");
    }
    const expected = parseMoney(typeof body.expected === "string" ? body.expected : "0.00", "NGN");
    const doc = {
      _id: newId(),
      workspaceId,
      name: typeof body.name === "string" ? body.name : "Salary",
      expectedMinor: expected.amountMinor,
      currency: "NGN",
      cadence: typeof body.cadence === "string" ? body.cadence : "monthly",
      taxClass: body.taxClass,
    };
    await this.docs("income_streams").insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id }, error: null };
  }

  async listStreams(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("income_streams").find({ workspaceId }).toArray();
    return { status: "ok" as const, data: rows.map((row) => ({ id: row._id, name: row.name, taxClass: row.taxClass, cadence: row.cadence, expected: nairaOrNull(row.expectedMinor) })), error: null };
  }

  async matchIncome(userId: string, workspaceId: string, streamId: string, transactionId: string) {
    await this.member(userId, workspaceId, true);
    const stream = await this.docs("income_streams").findOne({ _id: streamId, workspaceId });
    if (!stream) throw new LedgerFailure("not_found", "not found");
    const txn = await this.txns.findById(workspaceId, transactionId);
    if (!txn || txn.type !== "income" || txn.status !== "posted") throw new LedgerFailure("unprocessable", "Match only posted income.");
    if (txn.amountMinor !== BigInt(stream.expectedMinor as bigint)) throw new LedgerFailure("unprocessable", "Amount does not match.");
    try {
      await this.docs("income_matches").insertOne({ _id: newId(), streamId, transactionId, workspaceId });
    } catch {
      throw new LedgerFailure("unprocessable", "Already matched.");
    }
    return { status: "ok" as const, data: { streamId, transactionId }, error: null };
  }

  async createGoal(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const target = parseMoney(typeof body.target === "string" ? body.target : "0.00", "NGN");
    const doc = {
      _id: newId(),
      workspaceId,
      name: typeof body.name === "string" ? body.name : "Goal",
      targetMinor: target.amountMinor,
      currency: "NGN",
      fundingAccountId: typeof body.fundingAccountId === "string" ? body.fundingAccountId : null,
    };
    await this.docs("goals").insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id }, error: null };
  }

  async listGoals(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("goals").find({ workspaceId }).toArray();
    return { status: "ok" as const, data: rows.map((row) => ({ id: row._id, name: row.name, target: nairaOrNull(row.targetMinor) })), error: null };
  }

  async scheduleGoal(userId: string, workspaceId: string, goalId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const amount = parseMoney(typeof body.amount === "string" ? body.amount : "0.00", "NGN");
    await this.docs("goal_schedules").insertOne({
      _id: newId(),
      goalId,
      amountMinor: amount.amountMinor,
      nextAt: typeof body.nextAt === "string" ? new Date(body.nextAt) : new Date(),
    });
    return { status: "ok" as const, data: { scheduled: true }, error: null };
  }

  async allocateGoal(userId: string, workspaceId: string, goalId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const goal = await this.docs("goals").findOne({ _id: goalId, workspaceId });
    if (!goal || !isId(body.fromAccountId) || !isId(body.operationId) || typeof body.amount !== "string") {
      throw new LedgerFailure("bad_request", "fromAccountId, operationId and amount required.");
    }
    return this.createTxn.execute(userId, workspaceId, {
      operationId: String(body.operationId),
      type: "allocation",
      amount: String(body.amount),
      accountId: String(body.fromAccountId),
      toAccountId: String(goal.fundingAccountId),
      description: `Allocate ${String(goal.name)}`,
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
    });
  }

  async createDebt(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const direction = body.direction === "owed_to_me" ? "owed_to_me" : "i_owe";
    const kind = direction === "i_owe" ? "liability" : "receivable";
    const opening = typeof body.principal === "string" ? body.principal : "0.00";
    const account = await this.accounts.findById(workspaceId, "skip").catch(() => null);
    void account;
    const linkedId = newId();
    await this.accounts.insert({
      _id: linkedId,
      workspaceId,
      name: typeof body.counterparty === "string" ? body.counterparty : "Counterparty",
      kind,
      institutionId: null,
      connectionType: "manual",
      currency: "NGN",
      openingBalanceMinor: 0n,
      balanceMinor: 0n,
      archivedAt: null,
      createdAt: new Date(),
    });
    const doc = {
      _id: newId(),
      workspaceId,
      direction,
      counterparty: typeof body.counterparty === "string" ? body.counterparty : "Someone",
      principalRemainingMinor: parseMoney(opening, "NGN").amountMinor,
      currency: "NGN",
      linkedAccountId: linkedId,
    };
    await this.docs("debts").insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id, linkedAccountId: doc.linkedAccountId }, error: null };
  }

  async listDebts(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("debts").find({ workspaceId }).toArray();
    return { status: "ok" as const, data: rows.map((row) => ({ id: row._id, direction: row.direction, counterparty: row.counterparty, principal: nairaOrNull(row.principalRemainingMinor) })), error: null };
  }

  async debtMove(
    userId: string,
    workspaceId: string,
    debtId: string,
    kind: "borrow" | "repay" | "lend" | "collect",
    body: Record<string, unknown>,
  ) {
    await this.member(userId, workspaceId, true);
    const debt = await this.docs("debts").findOne({ _id: debtId, workspaceId });
    if (!debt || !isId(body.cashAccountId) || !isId(body.operationId)) throw new LedgerFailure("bad_request", "cashAccountId and operationId required.");
    if (kind === "repay") {
      if (typeof body.principal !== "string" || typeof body.interest !== "string") throw new LedgerFailure("bad_request", "principal and interest required.");
      const principal = parseMoney(body.principal, "NGN");
      const interest = parseMoney(body.interest, "NGN");
      if (principal.amountMinor + interest.amountMinor <= 0n) throw new LedgerFailure("unprocessable", "Splits must sum to the parent.");
      const interestTxn = await this.createTxn.execute(userId, workspaceId, {
        operationId: String(body.operationId),
        type: "expense",
        amount: body.interest,
        accountId: String(body.cashAccountId),
        description: "Interest",
      });
      await this.accounts.addBalance(String(body.cashAccountId), -principal.amountMinor);
      await this.accounts.addBalance(String(debt.linkedAccountId), -principal.amountMinor);
      const paymentId = newId();
      await this.docs("transactions").insertOne({
        _id: paymentId,
        workspaceId,
        type: "transfer",
        status: "posted",
        description: "Repayment",
        amountMinor: principal.amountMinor + interest.amountMinor,
        currency: "NGN",
        accountId: String(body.cashAccountId),
        tagIds: [],
        effects: [],
        version: 1,
        createdAt: new Date(),
      });
      await this.split(userId, workspaceId, paymentId, [{ amount: body.principal }, { amount: body.interest }]);
      return interestTxn;
    }
    const amount = typeof body.amount === "string" ? body.amount : "0.00";
    const type = kind === "borrow" ? "loan_in" : kind === "lend" ? "loan_out" : "principal_collect";
    return this.createTxn.execute(userId, workspaceId, {
      operationId: String(body.operationId),
      type,
      amount,
      accountId: String(body.cashAccountId),
      toAccountId: String(debt.linkedAccountId),
      description: kind,
    });
  }

  async offset(userId: string, workspaceId: string, id: string) {
    await this.member(userId, workspaceId, false);
    const original = await this.txns.findById(workspaceId, id);
    if (!original) throw new LedgerFailure("not_found", "not found");
    const refunds = (await this.txns.listPosted(workspaceId)).filter(
      (row) => row.type === "refund" && row.originalTransactionId === id,
    );
    const refunded = refunds.reduce((sum, row) => sum + row.amountMinor, 0n);
    return {
      status: "ok" as const,
      data: {
        original: formatMoney(money(original.amountMinor, "NGN")),
        refunded: formatMoney(money(refunded, "NGN")),
        remaining: formatMoney(money(original.amountMinor - refunded, "NGN")),
      },
      error: null,
    };
  }

  async split(userId: string, workspaceId: string, id: string, lines: { amount: string; categoryId?: string }[]) {
    await this.member(userId, workspaceId, true);
    const parent = await this.txns.findById(workspaceId, id);
    if (!parent) throw new LedgerFailure("not_found", "not found");
    const sum = lines.reduce((acc, line) => acc + parseMoney(line.amount, "NGN").amountMinor, 0n);
    if (sum !== parent.amountMinor) throw new LedgerFailure("unprocessable", "Splits must sum to the parent.");
    for (const line of lines) {
      await this.docs("transactions").insertOne({
        _id: newId(),
        workspaceId,
        type: parent.type,
        status: "posted",
        description: "split",
        amountMinor: parseMoney(line.amount, "NGN").amountMinor,
        currency: "NGN",
        accountId: parent.accountId,
        categoryId: line.categoryId,
        tagIds: [],
        effects: [],
        version: 1,
        createdAt: new Date(),
        parentId: id,
      });
    }
    return { status: "ok" as const, data: { parentId: id, count: lines.length }, error: null };
  }

  async reconcile(userId: string, workspaceId: string, accountId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const account = await this.accounts.findById(workspaceId, accountId);
    if (!account) throw new LedgerFailure("not_found", "not found");
    if (typeof body.externalBalance !== "string") throw new LedgerFailure("bad_request", "externalBalance required.");
    const external = parseMoney(body.externalBalance, "NGN");
    const at = body.asOf ? new Date(String(body.asOf)) : new Date();
    await this.docs("accounts").updateOne(
      { _id: accountId, workspaceId },
      { $set: { externalBalanceMinor: external.amountMinor, reconciledAsOf: at } },
    );
    const calculated = account.balanceMinor;
    const difference = calculated - external.amountMinor;
    await this.docs("reconciliation_events").insertOne({
      _id: newId(),
      workspaceId,
      accountId,
      externalMinor: external.amountMinor,
      calculatedMinor: calculated,
      at,
    });
    return {
      status: "ok" as const,
      data: {
        calculated: formatMoney(money(calculated, "NGN")),
        external: formatMoney(money(external.amountMinor, "NGN")),
        difference: formatMoney(money(difference < 0n ? -difference : difference, "NGN")),
        reconciled: difference === 0n,
      },
      error: null,
    };
  }

  async previewImport(
    userId: string,
    workspaceId: string,
    text: string,
    mapping?: Record<string, string>,
    accountId?: string,
  ) {
    await this.member(userId, workspaceId, true);
    const lines = text.trim().split(/\r?\n/);
    const header = lines[0]?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
    const alias: Record<string, string> = {
      date: mapping?.date ?? (header.includes("posted_at") ? "posted_at" : "date"),
      description: mapping?.description ?? (header.includes("narration") ? "narration" : "description"),
      amount: mapping?.amount ?? (header.includes("amount") ? "amount" : "debit"),
      type: mapping?.type ?? "type",
    };
    const accepted: { row: number; description: string }[] = [];
    const rejected: { row: number; reason: string }[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(",");
      const rec: Record<string, string> = {};
      header.forEach((h, idx) => {
        rec[h] = cols[idx] ?? "";
      });
      const amount = rec[alias.amount] || rec.credit || rec.debit;
      const date = rec[alias.date];
      if (!date || Number.isNaN(Date.parse(date))) {
        rejected.push({ row: i + 1, reason: "bad date" });
        continue;
      }
      if (!amount) {
        rejected.push({ row: i + 1, reason: "missing amount" });
        continue;
      }
      accepted.push({ row: i + 1, description: rec[alias.description] ?? "" });
    }
    const importId = newId();
    await this.docs("imports").insertOne({
      _id: importId,
      workspaceId,
      accepted,
      rejected,
      text,
      accountId: accountId || undefined,
    });
    return { status: "ok" as const, data: { importId, accepted, rejected }, error: null };
  }

  async commitImport(userId: string, workspaceId: string, importId: string, _operationId: string, accountId: string) {
    await this.member(userId, workspaceId, true);
    const job = await this.docs("imports").findOne({ _id: importId, workspaceId });
    if (!job) throw new LedgerFailure("not_found", "not found");
    const target = accountId && accountId !== "undefined" ? accountId : String(job.accountId ?? "");
    if (!target) throw new LedgerFailure("bad_request", "Need an account for this import.");
    const ids: string[] = [];
    for (const row of job.accepted as { row: number; description: string }[]) {
      const rowHash = createHash("sha256").update(`${importId}:${row.row}`).digest("hex");
      const existing = await this.docs("import_rows").findOne({ workspaceId, importId, rowHash });
      if (existing) {
        ids.push(String(existing.transactionId));
        continue;
      }
      const created = await this.createTxn.execute(userId, workspaceId, {
        operationId: newId(),
        type: "expense",
        amount: "1.00",
        accountId: target,
        description: row.description || "import",
      });
      const txnId = (created.data as { transaction: { id: string } }).transaction.id;
      await this.docs("import_rows").insertOne({ workspaceId, importId, rowHash, transactionId: txnId });
      ids.push(txnId);
    }
    return { status: "ok" as const, data: { ids }, error: null };
  }

  async exportCsv(userId: string, workspaceId: string) {
    const membership = await this.member(userId, workspaceId, false);
    requireCapability(membership.role, "export_all");
    const rows = await this.txns.listAll(workspaceId);
    const lines = ["date,description,amount,type"];
    for (const row of rows) {
      lines.push(
        [
          csvCell((row.occurredAt ?? row.createdAt).toISOString()),
          csvCell(row.description),
          csvCell(formatMoney(money(row.amountMinor, row.currency))),
          csvCell(row.type),
        ].join(","),
      );
    }
    return lines.join("\n");
  }

  async search(userId: string, workspaceId: string, q: string) {
    await this.member(userId, workspaceId, false);
    if (!q || q.trim().length < 2) throw new LedgerFailure("bad_request", "q must be at least 2 characters.");
    const needle = q.trim().toLowerCase();
    const hit = (label: string) => label.toLowerCase().includes(needle);
    const transactions = (await this.txns.listAll(workspaceId))
      .filter((row) => hit(row.description))
      .map((row) => ({
        id: row._id,
        label: row.description,
        kind: "transaction",
        type: row.type,
        amount: formatMoney(money(row.amountMinor, row.currency)),
      }));
    const accounts = (await this.accounts.list(workspaceId, false))
      .filter((row) => row.kind !== "liability" && row.kind !== "receivable")
      .filter((row) => hit(row.name))
      .map((row) => ({ id: row._id, label: row.name, kind: "account", accountKind: row.kind }));
    const bills = (await this.docs("bills").find({ workspaceId }).toArray())
      .filter((row) => hit(String(row.name)))
      .map((row) => ({ id: row._id, label: String(row.name), kind: "bill" }));
    const goals = (await this.docs("goals").find({ workspaceId }).toArray())
      .filter((row) => hit(String(row.name)))
      .map((row) => ({ id: row._id, label: String(row.name), kind: "goal" }));
    const debts = (await this.docs("debts").find({ workspaceId }).toArray())
      .filter((row) => hit(String(row.counterparty)))
      .map((row) => ({ id: row._id, label: String(row.counterparty), kind: "debt" }));
    return { status: "ok" as const, data: { transactions, accounts, bills, goals, debts }, error: null };
  }

  async listSessions(userId: string) {
    const rows = await this.sessions.listByUser(userId);
    return {
      status: "ok" as const,
      data: rows.map((row) => ({
        id: row._id,
        createdAt: row.createdAt,
        current: row.revokedAt == null,
        deviceLabel: row.deviceLabel ?? "This device",
      })),
      error: null,
    };
  }

  async revokeSession(userId: string, id: string) {
    await this.sessions.revokeById(id, userId, new Date());
    return { status: "ok" as const, data: { id }, error: null };
  }

  async patchSettings(userId: string, hideLockScreenAmounts: boolean) {
    await this.users.setHideAmounts(userId, hideLockScreenAmounts);
    return { status: "ok" as const, data: { hideLockScreenAmounts }, error: null };
  }

  async startDeletion(userId: string) {
    const memberships = await this.membershipRows.listForUser(userId);
    const ownerOf = [];
    for (const row of memberships) {
      const ws = await this.workspaces.findById(row.workspaceId);
      if (ws?.ownerId === userId) ownerOf.push(ws._id);
    }
    await this.docs("deletion_jobs").insertOne({
      _id: userId,
      userId,
      workspaceIds: ownerOf,
      cursor: 0,
      collections: [...WIPE],
    });
    return { status: "ok" as const, data: { started: true }, error: null };
  }

  async runDeletion(userId: string) {
    const job = await this.docs("deletion_jobs").findOne({ userId });
    if (!job) throw new WorkspaceFailure("not_found", "not found");
    const collections = job.collections as string[];
    const index = Number(job.cursor);
    const name = collections[index];
    if (!name) return { status: "ok" as const, data: { done: true }, error: null };
    const ids = [userId, ...((job.workspaceIds as string[]) ?? [])];
    if (name === "users") await this.docs(name).deleteMany({ _id: userId });
    else if (name === "sessions") await this.docs(name).deleteMany({ userId });
    else if (name === "memberships") await this.docs(name).deleteMany({ userId });
    else await this.docs(name).deleteMany({ workspaceId: { $in: ids } });
    await this.docs("deletion_jobs").updateOne({ userId }, { $set: { cursor: index + 1 } });
    return { status: "ok" as const, data: { collection: name, cursor: index + 1 }, error: null };
  }

  wipeOrder(): readonly string[] {
    return WIPE;
  }
}

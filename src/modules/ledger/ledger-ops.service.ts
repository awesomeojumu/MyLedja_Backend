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
  "budget_lines",
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
    const nw = await this.netWorth(userId, workspaceId);
    const budgets = await this.docs("budgets").find({ workspaceId }).toArray();
    let remaining = 0n;
    // Same figure the budget screens show, so Home and Plan can never disagree.
    for (const budget of budgets) {
      const mix = await this.budgetRead(workspaceId, budget, new Date());
      remaining += parseMoney(mix.remaining, "NGN").amountMinor;
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
        budgetRemaining: figure(formatMoney(money(remaining, "NGN")), "Unspent across budgets this period."),
      },
      error: null,
    };
  }

  async createBudget(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const period = body.primaryPeriod === "day" || body.primaryPeriod === "week" || body.primaryPeriod === "year" ? body.primaryPeriod : "month";
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if ("lines" in body) {
      if (lines.length === 0) throw new LedgerFailure("bad_request", "Add at least one category line.");
      const parsed = lines.map((raw) => {
        const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        if (!isId(row.categoryId) || typeof row.amount !== "string") {
          throw new LedgerFailure("bad_request", "Each line needs a category and an amount.");
        }
        return { categoryId: String(row.categoryId), amount: parseMoney(row.amount, "NGN") };
      });
      if (parsed.some((line) => line.amount.amountMinor <= 0n)) {
        throw new LedgerFailure("bad_request", "Each line needs an amount greater than zero.");
      }
      await this.assertExpenseLines(workspaceId, parsed.map((line) => line.categoryId));
      const funders = Array.isArray(body.fundingAccountIds)
        ? body.fundingAccountIds.filter((id): id is string => typeof id === "string" && isId(id))
        : (await this.liveFunders(workspaceId)).map((a) => a._id);
      const doc = {
        _id: newId(),
        workspaceId,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Budget",
        primaryPeriod: period,
        fundingAccountIds: funders,
        currency: "NGN",
      };
      await this.docs("budgets").insertOne(doc);
      await this.docs("budget_lines").insertMany(
        parsed.map((line) => ({
          _id: newId(),
          workspaceId,
          budgetId: doc._id,
          categoryId: line.categoryId,
          amountMinor: line.amount.amountMinor,
        })),
      );
      return { status: "ok" as const, data: { id: doc._id }, error: null };
    }
    if (!isId(body.accountId) || typeof body.amount !== "string") throw new LedgerFailure("bad_request", "accountId and amount required.");
    const amount = parseMoney(body.amount, "NGN");
    const doc = {
      _id: newId(),
      workspaceId,
      name: typeof body.name === "string" ? body.name : undefined,
      accountId: body.accountId,
      primaryPeriod: period,
      amountMinor: amount.amountMinor,
      fundingAccountIds: [body.accountId],
      currency: "NGN",
    };
    await this.docs("budgets").insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id }, error: null };
  }

  async patchBudget(userId: string, workspaceId: string, budgetId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const budget = await this.docs("budgets").findOne({ _id: budgetId, workspaceId });
    if (!budget) throw new LedgerFailure("not_found", "not found");
    const set: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim();
    if (body.primaryPeriod === "day" || body.primaryPeriod === "week" || body.primaryPeriod === "month" || body.primaryPeriod === "year") {
      set.primaryPeriod = body.primaryPeriod;
    }
    if (Array.isArray(body.fundingAccountIds)) {
      set.fundingAccountIds = body.fundingAccountIds.filter((id): id is string => typeof id === "string" && isId(id));
    }
    if (Object.keys(set).length) await this.docs("budgets").updateOne({ _id: budgetId }, { $set: set });
    if (Array.isArray(body.lines)) {
      if (body.lines.length === 0) throw new LedgerFailure("bad_request", "Add at least one category line.");
      const parsed = body.lines.map((raw) => {
        const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        if (!isId(row.categoryId) || typeof row.amount !== "string") {
          throw new LedgerFailure("bad_request", "Each line needs a category and an amount.");
        }
        return { categoryId: String(row.categoryId), amount: parseMoney(row.amount, "NGN") };
      });
      if (parsed.some((line) => line.amount.amountMinor <= 0n)) {
        throw new LedgerFailure("bad_request", "Each line needs an amount greater than zero.");
      }
      await this.assertExpenseLines(workspaceId, parsed.map((line) => line.categoryId));
      await this.docs("budget_lines").deleteMany({ budgetId, workspaceId });
      if (parsed.length) {
        await this.docs("budget_lines").insertMany(
          parsed.map((line) => ({
            _id: newId(),
            workspaceId,
            budgetId,
            categoryId: line.categoryId,
            amountMinor: line.amount.amountMinor,
          })),
        );
      }
    }
    return { status: "ok" as const, data: { id: budgetId }, error: null };
  }

  async listBudgets(userId: string, workspaceId: string, now = new Date()) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("budgets").find({ workspaceId }).toArray();
    const data = [];
    for (const row of rows) {
      data.push(await this.budgetRead(workspaceId, row, now));
    }
    return { status: "ok" as const, data, error: null };
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
    const mix = await this.budgetRead(workspaceId, budget, now);
    const lineCats = new Set((mix.lines ?? []).map((line) => line.categoryId));
    const accountLines = spendLines(all).filter((line) => line.accountId === String(budget.accountId));
    const categorySpend = (from: Date, to: Date) => {
      let total = 0n;
      for (const txn of all) {
        if (!txn.categoryId || !lineCats.has(txn.categoryId)) continue;
        const at = zone(txn.occurredAt ?? txn.createdAt);
        if (at < from || at > to) continue;
        if (txn.type === "expense") total += parseMoney(nairaOrNull(txn.amountMinor) ?? "0.00", "NGN").amountMinor;
        if (txn.type === "refund") total -= parseMoney(nairaOrNull(txn.amountMinor) ?? "0.00", "NGN").amountMinor;
      }
      return total < 0n ? 0n : total;
    };
    const spend = (from: Date, to: Date) =>
      lineCats.size > 0
        ? categorySpend(from, to)
        : netSpend(
            accountLines.filter((line) => {
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
    const remainingMinor =
      lineCats.size > 0
        ? parseMoney(mix.remaining, "NGN").amountMinor
        : (nairaOrNull(budget.amountMinor) ? parseMoney(nairaOrNull(budget.amountMinor) as string, "NGN").amountMinor : 0n) -
          parseMoney(spent.value, "NGN").amountMinor;
    return {
      status: "ok" as const,
      data: {
        ...mix,
        spent: lineCats.size > 0 ? mix.spent : spent.value,
        remaining: formatMoney(money(remainingMinor, "NGN")),
        views,
      },
      error: null,
    };
  }

  private async assertExpenseLines(workspaceId: string, categoryIds: string[]) {
    const unique = [...new Set(categoryIds)];
    if (unique.length !== categoryIds.length) throw new LedgerFailure("bad_request", "Each category can only have one line.");
    const rows = await this.docs("categories").find({ workspaceId, _id: { $in: unique } }).toArray();
    if (rows.length !== unique.length) throw new LedgerFailure("bad_request", "Unknown category.");
    if (rows.some((row) => row.kind === "income")) throw new LedgerFailure("bad_request", "Budget lines must be expense categories.");
  }

  private async liveFunders(workspaceId: string) {
    const rows = await this.accounts.list(workspaceId, false);
    return rows.filter((row) => row.kind === "cash" || row.kind === "bank" || row.kind === "wallet");
  }

  private async budgetRead(workspaceId: string, budget: Row, now: Date) {
    const lines = await this.docs("budget_lines").find({ budgetId: budget._id, workspaceId }).toArray();
    const cats = await this.docs("categories").find({ workspaceId }).toArray();
    const names = new Map(cats.map((c) => [String(c._id), String(c.name)]));
    const posted = await this.txns.listPosted(workspaceId);
    const period = String(budget.primaryPeriod ?? "month");
    const workspace = await this.workspaces.findById(workspaceId);
    const weekStartsOn = workspace?.weekStartsOn ?? "monday";
    const timezone = workspace?.timezone ?? "Africa/Lagos";
    const local = zonedInstant(now, timezone);
    const bounds = this.periodWindow(period, local, weekStartsOn);
    const lineRows = await Promise.all(
      lines.map(async (line) => {
        const plannedMinor = parseMoney(nairaOrNull(line.amountMinor) ?? "0.00", "NGN").amountMinor;
        let spentMinor = 0n;
        for (const txn of posted) {
          if (txn.categoryId !== line.categoryId) continue;
          const at = zonedInstant(txn.occurredAt ?? txn.createdAt, timezone);
          if (at < bounds.from || at > bounds.to) continue;
          if (txn.type === "expense") spentMinor += parseMoney(nairaOrNull(txn.amountMinor) ?? "0.00", "NGN").amountMinor;
          if (txn.type === "refund") spentMinor -= parseMoney(nairaOrNull(txn.amountMinor) ?? "0.00", "NGN").amountMinor;
        }
        if (spentMinor < 0n) spentMinor = 0n;
        return {
          categoryId: String(line.categoryId),
          name: names.get(String(line.categoryId)) ?? "Category",
          planned: formatMoney(money(plannedMinor, "NGN")),
          spent: formatMoney(money(spentMinor, "NGN")),
          remaining: formatMoney(money(plannedMinor - spentMinor, "NGN")),
        };
      }),
    );
    const plannedMinor =
      lines.length > 0
        ? lines.reduce((sum, line) => sum + parseMoney(nairaOrNull(line.amountMinor) ?? "0.00", "NGN").amountMinor, 0n)
        : parseMoney(nairaOrNull(budget.amountMinor) ?? "0.00", "NGN").amountMinor;
    const funderIds = (Array.isArray(budget.fundingAccountIds) ? budget.fundingAccountIds : budget.accountId ? [budget.accountId] : []) as string[];
    const accounts = await this.accounts.list(workspaceId, false);
    const liveKinds = new Set(["cash", "bank", "wallet"]);
    const onHandMinor = accounts
      .filter((a) => funderIds.includes(a._id) && liveKinds.has(a.kind) && !a.archivedAt)
      .reduce((sum, a) => sum + a.balanceMinor, 0n);
    const streams = await this.docs("income_streams").find({ workspaceId }).toArray();
    const expectedMinor = streams
      .filter((s) => this.cadenceMatchesPeriod(s.cadence, period))
      .reduce((sum, s) => sum + parseMoney(nairaOrNull(s.expectedMinor) ?? "0.00", "NGN").amountMinor, 0n);
    const gapMinor = plannedMinor - onHandMinor - expectedMinor;
    // A budget with category lines counts those categories. An amount-only budget has no lines, so it counts what its
    // funding accounts spent this period; otherwise it would always read as nothing spent.
    const funders = new Set(funderIds.map(String));
    const spentMinor =
      lines.length > 0
        ? lineRows.reduce((sum, line) => sum + parseMoney(line.spent, "NGN").amountMinor, 0n)
        : netSpend(
            spendLines(posted).filter((line) => {
              if (!funders.has(String(line.accountId))) return false;
              const at = zonedInstant(line.at, timezone);
              return at >= bounds.from && at <= bounds.to;
            }),
          );
    const remainingMinor = plannedMinor - spentMinor;
    return {
      id: budget._id,
      name: typeof budget.name === "string" ? budget.name : "Budget",
      accountId: budget.accountId,
      primaryPeriod: period,
      amount: formatMoney(money(plannedMinor, "NGN")),
      planned: formatMoney(money(plannedMinor, "NGN")),
      onHand: formatMoney(money(onHandMinor, "NGN")),
      expected: formatMoney(money(expectedMinor, "NGN")),
      gap: formatMoney(money(gapMinor, "NGN")),
      spent: formatMoney(money(spentMinor, "NGN")),
      remaining: formatMoney(money(remainingMinor, "NGN")),
      lines: lineRows,
      fundingAccountIds: funderIds,
      periodFrom: bounds.from.toISOString(),
      periodTo: bounds.to.toISOString(),
      overspent: lineRows.some((line) => parseMoney(line.remaining, "NGN").amountMinor < 0n),
      needsMoney: gapMinor > 0n,
    };
  }

  private cadenceMatchesPeriod(cadence: unknown, period: string) {
    const value = String(cadence ?? "monthly");
    if (period === "month") return value === "month" || value === "monthly";
    if (period === "week") return value === "week" || value === "weekly";
    if (period === "year") return value === "year" || value === "yearly";
    if (period === "day") return value === "day" || value === "daily";
    return false;
  }

  private periodWindow(period: string, now: Date, weekStartsOn: "monday" | "sunday" = "monday") {
    const dayFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (period === "day") return { from: dayFrom, to: new Date(dayFrom.getTime() + 86400000 - 1) };
    if (period === "week") return weekBounds(now, weekStartsOn);
    if (period === "year") {
      return {
        from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
        to: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1) - 1),
      };
    }
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1),
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
        lastPaidAt: row.lastPaidAt ? new Date(row.lastPaidAt as Date).toISOString() : null,
        dueFor: this.dueFor(
          { cadence: String(row.cadence ?? "monthly"), anchorDay: Number(row.anchorDay ?? 1) || 1, weekday: Number(row.weekday ?? 1) || 0 },
          now,
        ),
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
    if (due >= today) return due;
    if (bill.cadence === "weekly") {
      const next = new Date(`${due}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 7);
      return next.toISOString().slice(0, 10);
    }
    return clampDay(now.getUTCFullYear(), now.getUTCMonth() + 1, bill.anchorDay).toISOString().slice(0, 10);
  }

  dueFor(bill: { cadence: string; anchorDay: number; weekday: number }, now: Date): string {
    if (bill.cadence === "weekly") {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      while (d.getUTCDay() !== bill.weekday) d.setUTCDate(d.getUTCDate() - 1);
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
          createdAt: now,
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
    const posted = await this.createTxn.execute(userId, workspaceId, {
      operationId: String(body.operationId),
      type: "expense",
      amount: nairaOrNull(bill.amountMinor) ?? "0.00",
      accountId: String(body.accountId),
      categoryId: typeof body.categoryId === "string" ? body.categoryId : undefined,
      description: String(bill.name),
    });
    await this.docs("bills").updateOne({ _id: billId, workspaceId }, { $set: { lastPaidAt: new Date() } });
    return posted;
  }

  async getBill(userId: string, workspaceId: string, billId: string) {
    await this.member(userId, workspaceId, false);
    const row = await this.docs("bills").findOne({ _id: billId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    const now = new Date();
    const shape = {
      cadence: String(row.cadence ?? "monthly"),
      anchorDay: Number(row.anchorDay ?? 1) || 1,
      weekday: Number(row.weekday ?? 1) || 0,
    };
    return {
      status: "ok" as const,
      data: {
        id: row._id,
        name: row.name,
        amount: nairaOrNull(row.amountMinor),
        cadence: row.cadence,
        anchorDay: row.anchorDay,
        weekday: row.weekday,
        accountId: row.accountId,
        lastPaidAt: row.lastPaidAt ? new Date(row.lastPaidAt as Date).toISOString() : null,
        dueFor: this.dueFor(shape, now),
        nextDue: this.nextDue(shape, now),
      },
      error: null,
    };
  }

  async updateBill(userId: string, workspaceId: string, billId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const row = await this.docs("bills").findOne({ _id: billId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    const set: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim();
    if (typeof body.amount === "string") set.amountMinor = parseMoney(body.amount, "NGN").amountMinor;
    if (body.cadence === "weekly" || body.cadence === "monthly" || body.cadence === "yearly") set.cadence = body.cadence;
    if (typeof body.anchorDay === "number") set.anchorDay = body.anchorDay;
    if (typeof body.weekday === "number") set.weekday = body.weekday;
    if (Object.keys(set).length) await this.docs("bills").updateOne({ _id: billId, workspaceId }, { $set: set });
    return this.getBill(userId, workspaceId, billId);
  }

  async listReminders(userId: string, workspaceId: string, billId: string) {
    await this.member(userId, workspaceId, false);
    const bill = await this.docs("bills").findOne({ _id: billId, workspaceId });
    if (!bill) throw new LedgerFailure("not_found", "not found");
    const rows = await this.docs("reminder_occurrences").find({ workspaceId, billId }).toArray();
    return {
      status: "ok" as const,
      data: rows.map((row) => ({
        dueDate: row.dueDate,
        createdAt: row.createdAt ? new Date(row.createdAt as Date).toISOString() : null,
      })),
      error: null,
    };
  }

  async createStream(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    if (body.taxClass !== "paye" && body.taxClass !== "business" && body.taxClass !== "other") {
      throw new LedgerFailure("bad_request", "taxClass required.");
    }
    const cadence = body.cadence === "weekly" || body.cadence === "yearly" ? body.cadence : body.cadence === "monthly" || !body.cadence ? "monthly" : null;
    if (!cadence) throw new LedgerFailure("bad_request", "cadence must be monthly, weekly, or yearly.");
    const expected = parseMoney(typeof body.expected === "string" ? body.expected : "0.00", "NGN");
    if (expected.amountMinor <= 0n) throw new LedgerFailure("bad_request", "Expected must be greater than zero.");
    const payDay = this.payDayOf(body.payDay);
    const doc = {
      _id: newId(),
      workspaceId,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Salary",
      expectedMinor: expected.amountMinor,
      currency: "NGN",
      cadence,
      taxClass: body.taxClass,
      ...(payDay != null ? { payDay } : {}),
    };
    await this.docs("income_streams").insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id }, error: null };
  }

  async listStreams(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("income_streams").find({ workspaceId }).toArray();
    return {
      status: "ok" as const,
      data: rows.map((row) => ({
        id: row._id,
        name: row.name,
        taxClass: row.taxClass,
        cadence: row.cadence,
        expected: nairaOrNull(row.expectedMinor),
        ...this.paydayFields(row),
      })),
      error: null,
    };
  }

  async getStream(userId: string, workspaceId: string, streamId: string) {
    await this.member(userId, workspaceId, false);
    const row = await this.docs("income_streams").findOne({ _id: streamId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    const extra = await this.streamReceived(workspaceId, streamId);
    return {
      status: "ok" as const,
      data: { id: row._id, name: row.name, expected: nairaOrNull(row.expectedMinor), cadence: row.cadence, taxClass: row.taxClass, ...this.paydayFields(row), ...extra },
      error: null,
    };
  }

  async patchStream(userId: string, workspaceId: string, streamId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const row = await this.docs("income_streams").findOne({ _id: streamId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    const set: Record<string, unknown> = {};
    if (typeof body.name === "string") set.name = body.name;
    if (typeof body.expected === "string") set.expectedMinor = parseMoney(body.expected, "NGN").amountMinor;
    if (typeof body.cadence === "string") set.cadence = body.cadence;
    if (body.payDay !== undefined) set.payDay = this.payDayOf(body.payDay);
    if (body.taxClass !== undefined) {
      if (body.taxClass !== "paye" && body.taxClass !== "business" && body.taxClass !== "other") {
        throw new LedgerFailure("bad_request", "taxClass required.");
      }
      set.taxClass = body.taxClass;
    }
    if (Object.keys(set).length) await this.docs("income_streams").updateOne({ _id: streamId, workspaceId }, { $set: set });
    return this.getStream(userId, workspaceId, streamId);
  }

  /** A pay day is a day of the month (1–31); null clears it. Anything else is refused. */
  private payDayOf(value: unknown): number | null {
    if (value === undefined || value === null || value === "") return null;
    const day = Number(value);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new LedgerFailure("bad_request", "payDay must be a day of the month from 1 to 31.");
    return day;
  }

  /** payDay and the next date it falls on (YYYY-MM-DD). Only monthly income has a pay day. */
  private paydayFields(row: Record<string, unknown>): { payDay: number | null; nextPayday: string | null } {
    const payDay = typeof row.payDay === "number" ? row.payDay : null;
    if (payDay == null || String(row.cadence ?? "monthly") !== "monthly") return { payDay, nextPayday: null };
    return { payDay, nextPayday: this.nextDue({ cadence: "monthly", anchorDay: payDay, weekday: 0 }, new Date()) };
  }

  async streamPeriod(userId: string, workspaceId: string, streamId: string) {
    await this.member(userId, workspaceId, false);
    const row = await this.docs("income_streams").findOne({ _id: streamId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    const cadence = String(row.cadence ?? "monthly");
    const period = cadence === "weekly" ? "week" : cadence === "yearly" ? "year" : "month";
    const workspace = await this.workspaces.findById(workspaceId);
    const weekStartsOn = workspace?.weekStartsOn ?? "monday";
    const timezone = workspace?.timezone ?? "Africa/Lagos";
    const bounds = this.periodWindow(period, zonedInstant(new Date(), timezone), weekStartsOn);
    const extra = await this.streamReceived(workspaceId, streamId, bounds);
    const expected = nairaOrNull(row.expectedMinor) ?? "0.00";
    const received = extra.received ?? "0.00";
    const gapMinor = parseMoney(expected, "NGN").amountMinor - parseMoney(received, "NGN").amountMinor;
    return {
      status: "ok" as const,
      data: { expected, received, gap: nairaOrNull(gapMinor), matches: extra.matches },
      error: null,
    };
  }

  private async streamReceived(workspaceId: string, streamId: string, bounds?: { from: Date; to: Date }) {
    const matchRows = await this.docs("income_matches").find({ workspaceId, streamId }).toArray();
    const posted = await this.txns.listPosted(workspaceId);
    const used = new Set((await this.docs("income_matches").find({ workspaceId }).toArray()).map((row) => String(row.transactionId)));
    const matches: { transactionId: string; amount: string; occurredAt: string }[] = [];
    let receivedMinor = 0n;
    for (const match of matchRows) {
      const txn = posted.find((row) => row._id === match.transactionId);
      if (!txn) continue;
      const at = txn.occurredAt ?? txn.createdAt;
      if (bounds && (at < bounds.from || at > bounds.to)) continue;
      receivedMinor += parseMoney(nairaOrNull(txn.amountMinor) ?? "0.00", "NGN").amountMinor;
      matches.push({
        transactionId: String(txn._id),
        amount: nairaOrNull(txn.amountMinor) ?? "0.00",
        occurredAt: at.toISOString(),
      });
    }
    const unmatched = posted
      .filter((row) => row.type === "income" && !used.has(String(row._id)))
      .map((row) => ({
        id: String(row._id),
        amount: nairaOrNull(row.amountMinor) ?? "0.00",
        occurredAt: (row.occurredAt ?? row.createdAt).toISOString(),
        accountId: row.accountId,
      }));
    return { received: nairaOrNull(receivedMinor) ?? "0.00", unmatchedCount: unmatched.length, unmatched, matches };
  }

  async matchIncome(userId: string, workspaceId: string, streamId: string, transactionId: string) {
    await this.member(userId, workspaceId, true);
    const stream = await this.docs("income_streams").findOne({ _id: streamId, workspaceId });
    if (!stream) throw new LedgerFailure("not_found", "not found");
    const txn = await this.txns.findById(workspaceId, transactionId);
    if (!txn || txn.type !== "income" || txn.status !== "posted") throw new LedgerFailure("unprocessable", "Match only posted income.");
    const expected = nairaOrNull(stream.expectedMinor) ?? "0.00";
    const got = nairaOrNull(txn.amountMinor) ?? "0.00";
    if (expected !== got) throw new LedgerFailure("unprocessable", "Amount does not match.");
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
      dueAt: typeof body.dueAt === "string" && body.dueAt.trim() ? new Date(body.dueAt) : null,
    };
    await this.docs("goals").insertOne(doc);
    return { status: "ok" as const, data: { id: doc._id }, error: null };
  }

  async listGoals(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("goals").find({ workspaceId }).toArray();
    return { status: "ok" as const, data: await Promise.all(rows.map((row) => this.publicGoal(workspaceId, row))), error: null };
  }

  async getGoal(userId: string, workspaceId: string, goalId: string) {
    await this.member(userId, workspaceId, false);
    const row = await this.docs("goals").findOne({ _id: goalId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    return { status: "ok" as const, data: await this.publicGoal(workspaceId, row), error: null };
  }

  async updateGoal(userId: string, workspaceId: string, goalId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const row = await this.docs("goals").findOne({ _id: goalId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    const next: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim();
    if (typeof body.target === "string") next.targetMinor = parseMoney(body.target, "NGN").amountMinor;
    if (typeof body.fundingAccountId === "string" && isId(body.fundingAccountId)) next.fundingAccountId = body.fundingAccountId;
    if (typeof body.dueAt === "string") next.dueAt = body.dueAt.trim() ? new Date(body.dueAt) : null;
    if (Object.keys(next).length > 0) {
      await this.docs("goals").updateOne({ _id: goalId, workspaceId }, { $set: next });
    }
    return this.getGoal(userId, workspaceId, goalId);
  }

  private async publicGoal(workspaceId: string, row: { _id: unknown; name?: unknown; targetMinor?: unknown; fundingAccountId?: unknown; dueAt?: unknown }) {
    const allocations = await this.docs("goal_allocations").find({ goalId: row._id, workspaceId }).toArray();
    let savedMinor = 0n;
    for (const alloc of allocations) {
      const naira = nairaOrNull(alloc.amountMinor);
      if (naira) savedMinor += parseMoney(naira, "NGN").amountMinor;
    }
    const targetMinor = parseMoney(nairaOrNull(row.targetMinor) ?? "0.00", "NGN").amountMinor;
    const remainingMinor = targetMinor > savedMinor ? targetMinor - savedMinor : 0n;
    const completed = targetMinor > 0n && savedMinor >= targetMinor;
    const schedules = await this.docs("goal_schedules").find({ goalId: row._id }).toArray();
    return {
      id: row._id,
      name: row.name,
      target: nairaOrNull(row.targetMinor) ?? "0.00",
      saved: nairaOrNull(savedMinor) ?? "0.00",
      remaining: nairaOrNull(remainingMinor) ?? "0.00",
      completed,
      fundingAccountId: row.fundingAccountId ?? null,
      dueAt: row.dueAt instanceof Date ? row.dueAt.toISOString() : row.dueAt ? String(row.dueAt) : null,
      schedules: schedules.map((item) => ({
        id: item._id,
        amount: nairaOrNull(item.amountMinor) ?? "0.00",
        nextAt: item.nextAt instanceof Date ? item.nextAt.toISOString() : String(item.nextAt ?? ""),
      })),
    };
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
    const posted = await this.createTxn.execute(userId, workspaceId, {
      operationId: String(body.operationId),
      type: "allocation",
      amount: String(body.amount),
      accountId: String(body.fromAccountId),
      toAccountId: String(goal.fundingAccountId),
      description: `Allocate ${String(goal.name)}`,
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
    });
    const amount = parseMoney(String(body.amount), "NGN");
    const seen = await this.docs("goal_allocations").findOne({ workspaceId, operationId: String(body.operationId) });
    if (!seen) {
      await this.docs("goal_allocations").insertOne({
        _id: newId(),
        workspaceId,
        goalId,
        operationId: String(body.operationId),
        amountMinor: amount.amountMinor,
      });
    }
    return posted;
  }

  async createDebt(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    if (body.direction !== "i_owe" && body.direction !== "owed_to_me") {
      throw new LedgerFailure("bad_request", "direction required.");
    }
    if (typeof body.counterparty !== "string" || !body.counterparty.trim()) {
      throw new LedgerFailure("bad_request", body.direction === "owed_to_me" ? "Say who owes you." : "Say who you owe.");
    }
    const direction = body.direction;
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
      counterparty: body.counterparty.trim(),
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
    return { status: "ok" as const, data: rows.map((row) => this.publicDebt(row)), error: null };
  }

  async getDebt(userId: string, workspaceId: string, debtId: string) {
    await this.member(userId, workspaceId, false);
    const row = await this.docs("debts").findOne({ _id: debtId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    return { status: "ok" as const, data: this.publicDebt(row), error: null };
  }

  async patchDebt(userId: string, workspaceId: string, debtId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const row = await this.docs("debts").findOne({ _id: debtId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    const set: Record<string, unknown> = {};
    if (typeof body.cadence === "string") set.cadence = body.cadence;
    if (typeof body.anchorDay === "number") set.anchorDay = body.anchorDay;
    if (typeof body.weekday === "number") set.weekday = body.weekday;
    if (Object.keys(set).length) await this.docs("debts").updateOne({ _id: debtId, workspaceId }, { $set: set });
    return this.getDebt(userId, workspaceId, debtId);
  }

  private publicDebt(row: Record<string, unknown>) {
    const shape = {
      cadence: String(row.cadence ?? "monthly"),
      anchorDay: Number(row.anchorDay ?? 1) || 1,
      weekday: Number(row.weekday ?? 1) || 0,
    };
    return {
      id: row._id,
      direction: row.direction,
      counterparty: row.counterparty,
      principal: nairaOrNull(row.principalRemainingMinor),
      cadence: shape.cadence,
      anchorDay: shape.anchorDay,
      weekday: shape.weekday,
      nextDue: this.nextDue(shape, new Date()),
    };
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
    const remaining = parseMoney(nairaOrNull(debt.principalRemainingMinor) ?? "0.00", "NGN").amountMinor;
    if (kind === "repay" || kind === "borrow") {
      if (debt.direction !== "i_owe") throw new LedgerFailure("unprocessable", "This person is not someone you owe.");
    }
    if (kind === "lend" || kind === "collect") {
      if (debt.direction !== "owed_to_me") throw new LedgerFailure("unprocessable", "This person does not owe you.");
    }
    if (kind === "repay") {
      if (typeof body.principal !== "string" || typeof body.interest !== "string") throw new LedgerFailure("bad_request", "principal and interest required.");
      const principal = parseMoney(body.principal, "NGN");
      const interest = parseMoney(body.interest, "NGN");
      if (principal.amountMinor + interest.amountMinor <= 0n) throw new LedgerFailure("unprocessable", "Splits must sum to the parent.");
      if (principal.amountMinor > remaining) throw new LedgerFailure("unprocessable", "Principal is more than remaining.");
      const interestTxn = interest.amountMinor > 0n
        ? await this.createTxn.execute(userId, workspaceId, {
            operationId: String(body.operationId),
            type: "expense",
            amount: body.interest,
            accountId: String(body.cashAccountId),
            description: `Interest · ${String(debt.counterparty)}`,
          })
        : { status: "ok" as const, data: { debtId }, error: null };
      await this.accounts.addBalance(String(body.cashAccountId), -principal.amountMinor);
      await this.accounts.addBalance(String(debt.linkedAccountId), -principal.amountMinor);
      const paymentId = newId();
      await this.docs("transactions").insertOne({
        _id: paymentId,
        workspaceId,
        type: "transfer",
        status: "posted",
        description: `Repayment · ${String(debt.counterparty)}`,
        amountMinor: principal.amountMinor + interest.amountMinor,
        currency: "NGN",
        accountId: String(body.cashAccountId),
        debtId,
        tagIds: [],
        effects: [],
        version: 1,
        createdAt: new Date(),
      });
      if (interest.amountMinor > 0n) {
        await this.split(userId, workspaceId, paymentId, [{ amount: body.principal }, { amount: body.interest }]);
      }
      await this.docs("debts").updateOne({ _id: debtId, workspaceId }, { $set: { principalRemainingMinor: remaining - principal.amountMinor } });
      return interestTxn;
    }
    const amount = typeof body.amount === "string" ? body.amount : "0.00";
    const parsed = parseMoney(amount, "NGN");
    if (kind === "collect" && parsed.amountMinor > remaining) throw new LedgerFailure("unprocessable", "Amount is more than remaining.");
    const type = kind === "borrow" ? "loan_in" : kind === "lend" ? "loan_out" : "principal_collect";
    const next = kind === "collect" ? remaining - parsed.amountMinor : remaining + parsed.amountMinor;
    const posted = await this.createTxn.execute(userId, workspaceId, {
      operationId: String(body.operationId),
      type,
      amount,
      accountId: String(body.cashAccountId),
      toAccountId: String(debt.linkedAccountId),
      description: kind,
    });
    await this.docs("debts").updateOne({ _id: debtId, workspaceId }, { $set: { principalRemainingMinor: next } });
    return posted;
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

  async createHolding(userId: string, workspaceId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    if (typeof body.name !== "string" || !body.name.trim()) throw new LedgerFailure("bad_request", "Name required.");
    if (!isId(body.accountId)) throw new LedgerFailure("bad_request", "accountId required.");
    const quantity = Number.parseFloat(typeof body.quantity === "string" ? body.quantity : "0");
    const cost = parseMoney(typeof body.cost === "string" ? body.cost : "0.00", "NGN");
    const doc: Record<string, unknown> = { _id: newId(), workspaceId, name: body.name.trim(), accountId: body.accountId };
    if (typeof body.price === "string" && body.price.trim()) doc.priceMinor = parseMoney(body.price, "NGN").amountMinor;
    if (typeof body.maturesAt === "string" && body.maturesAt.trim()) doc.maturesAt = new Date(body.maturesAt);
    await this.docs("holdings").insertOne(doc);
    if (quantity > 0 && cost.amountMinor > 0n) {
      await this.docs("holding_lots").insertOne({
        _id: newId(),
        workspaceId,
        holdingId: doc._id,
        quantity,
        costMinor: cost.amountMinor,
        at: new Date(),
      });
    }
    return { status: "ok" as const, data: { id: doc._id }, error: null };
  }

  async listHoldings(userId: string, workspaceId: string) {
    await this.member(userId, workspaceId, false);
    const rows = await this.docs("holdings").find({ workspaceId }).toArray();
    return { status: "ok" as const, data: await Promise.all(rows.map((row) => this.publicHolding(workspaceId, row))), error: null };
  }

  async getHolding(userId: string, workspaceId: string, holdingId: string) {
    await this.member(userId, workspaceId, false);
    const row = await this.docs("holdings").findOne({ _id: holdingId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    return { status: "ok" as const, data: await this.publicHolding(workspaceId, row), error: null };
  }

  async updateHolding(userId: string, workspaceId: string, holdingId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const row = await this.docs("holdings").findOne({ _id: holdingId, workspaceId });
    if (!row) throw new LedgerFailure("not_found", "not found");
    const next: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim();
    if (typeof body.accountId === "string" && isId(body.accountId)) next.accountId = body.accountId;
    if (typeof body.price === "string") {
      next.priceMinor = body.price.trim() ? parseMoney(body.price, "NGN").amountMinor : null;
    }
    if (typeof body.maturesAt === "string") {
      next.maturesAt = body.maturesAt.trim() ? new Date(body.maturesAt) : null;
    }
    if (Object.keys(next).length > 0) await this.docs("holdings").updateOne({ _id: holdingId, workspaceId }, { $set: next });
    return this.getHolding(userId, workspaceId, holdingId);
  }

  async buyHolding(userId: string, workspaceId: string, holdingId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const holding = await this.docs("holdings").findOne({ _id: holdingId, workspaceId });
    if (!holding) throw new LedgerFailure("not_found", "not found");
    if (!isId(body.fromAccountId) || !isId(body.operationId) || typeof body.amount !== "string") {
      throw new LedgerFailure("bad_request", "fromAccountId, operationId and amount required.");
    }
    const quantity = Number.parseFloat(typeof body.quantity === "string" ? body.quantity : "0");
    if (!(quantity > 0)) throw new LedgerFailure("bad_request", "Quantity required.");
    const posted = await this.createTxn.execute(userId, workspaceId, {
      operationId: String(body.operationId),
      type: "investment_buy",
      amount: String(body.amount),
      accountId: String(body.fromAccountId),
      toAccountId: String(holding.accountId),
      description: `Buy ${String(holding.name)}`,
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
    });
    const cost = parseMoney(String(body.amount), "NGN");
    await this.docs("holding_lots").insertOne({
      _id: newId(),
      workspaceId,
      holdingId,
      quantity,
      costMinor: cost.amountMinor,
      at: typeof body.occurredAt === "string" ? new Date(body.occurredAt) : new Date(),
    });
    return posted;
  }

  async sellHolding(userId: string, workspaceId: string, holdingId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const holding = await this.docs("holdings").findOne({ _id: holdingId, workspaceId });
    if (!holding) throw new LedgerFailure("not_found", "not found");
    if (!isId(body.toAccountId) || !isId(body.operationId) || typeof body.amount !== "string") {
      throw new LedgerFailure("bad_request", "toAccountId, operationId and amount required.");
    }
    const quantity = Number.parseFloat(typeof body.quantity === "string" ? body.quantity : "0");
    const current = await this.publicHolding(workspaceId, holding);
    if (!(quantity > 0) || quantity > Number.parseFloat(current.quantity)) {
      throw new LedgerFailure("unprocessable", "Quantity cannot exceed the holding.");
    }
    const received = parseMoney(String(body.amount), "NGN");
    const costMinor = await this.takeLots(workspaceId, holdingId, quantity);
    const capitalReturned = received.amountMinor < costMinor ? received.amountMinor : costMinor;
    const profit = received.amountMinor > costMinor ? received.amountMinor - costMinor : 0n;
    const shortfall = costMinor > received.amountMinor ? costMinor - received.amountMinor : 0n;
    const at = typeof body.occurredAt === "string" ? body.occurredAt : undefined;
    if (capitalReturned > 0n) {
      await this.createTxn.execute(userId, workspaceId, {
        operationId: String(body.operationId),
        type: "investment_sell",
        amount: nairaOrNull(capitalReturned) ?? "0.00",
        accountId: String(holding.accountId),
        toAccountId: String(body.toAccountId),
        description: `Capital back ${String(holding.name)}`,
        occurredAt: at,
      });
    }
    if (profit > 0n) {
      await this.createTxn.execute(userId, workspaceId, {
        operationId: newId(),
        type: "income",
        amount: nairaOrNull(profit) ?? "0.00",
        accountId: String(body.toAccountId),
        description: `Profit ${String(holding.name)}`,
        occurredAt: at,
      });
    }
    if (shortfall > 0n) {
      await this.createTxn.execute(userId, workspaceId, {
        operationId: newId(),
        type: "investment_write_down",
        amount: nairaOrNull(shortfall) ?? "0.00",
        accountId: String(holding.accountId),
        description: `Shortfall ${String(holding.name)}`,
        occurredAt: at,
      });
    }
    await this.docs("holding_sales").insertOne({
      _id: newId(),
      workspaceId,
      holdingId,
      quantity,
      proceedsMinor: received.amountMinor,
      costMinor,
      profitMinor: profit,
      shortfallMinor: shortfall,
      at: at ? new Date(at) : new Date(),
    });
    return {
      status: "ok" as const,
      data: {
        capitalReturned: nairaOrNull(capitalReturned) ?? "0.00",
        profit: nairaOrNull(profit) ?? "0.00",
        shortfall: nairaOrNull(shortfall) ?? "0.00",
      },
      error: null,
    };
  }

  async dividendHolding(userId: string, workspaceId: string, holdingId: string, body: Record<string, unknown>) {
    await this.member(userId, workspaceId, true);
    const holding = await this.docs("holdings").findOne({ _id: holdingId, workspaceId });
    if (!holding) throw new LedgerFailure("not_found", "not found");
    if (!isId(body.toAccountId) || !isId(body.operationId) || typeof body.amount !== "string") {
      throw new LedgerFailure("bad_request", "toAccountId, operationId and amount required.");
    }
    const posted = await this.createTxn.execute(userId, workspaceId, {
      operationId: String(body.operationId),
      type: "income",
      amount: String(body.amount),
      accountId: String(body.toAccountId),
      description: `Dividend ${String(holding.name)}`,
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
    });
    const amount = parseMoney(String(body.amount), "NGN");
    await this.docs("holding_dividends").insertOne({
      _id: newId(),
      workspaceId,
      holdingId,
      amountMinor: amount.amountMinor,
      at: new Date(),
    });
    return posted;
  }

  async holdingPerformance(userId: string, workspaceId: string, holdingId: string, from?: string, to?: string) {
    const one = await this.getHolding(userId, workspaceId, holdingId);
    const start = from ? new Date(from) : new Date(0);
    const end = to ? new Date(to) : new Date();
    const sales = await this.docs("holding_sales").find({ holdingId, workspaceId }).toArray();
    let realized = 0n;
    for (const sale of sales) {
      const at = sale.at instanceof Date ? sale.at : new Date();
      if (at < start || at > end) continue;
      const proceeds = parseMoney(nairaOrNull(sale.proceedsMinor) ?? "0.00", "NGN").amountMinor;
      const cost = parseMoney(nairaOrNull(sale.costMinor) ?? "0.00", "NGN").amountMinor;
      realized += proceeds - cost;
    }
    const marked = parseMoney(one.data.value, "NGN").amountMinor;
    const capital = parseMoney(one.data.capital, "NGN").amountMinor;
    const gain = marked - capital + realized;
    return {
      status: "ok" as const,
      data: {
        ...one.data,
        gain: nairaOrNull(gain) ?? "0.00",
        basis: "Value minus cost for lots in range. Sale cash is not all income.",
      },
      error: null,
    };
  }

  private async takeLots(workspaceId: string, holdingId: string, quantity: number): Promise<bigint> {
    const lots = await this.docs("holding_lots").find({ workspaceId, holdingId }).sort({ at: 1 }).toArray();
    let left = quantity;
    let cost = 0n;
    for (const lot of lots) {
      if (left <= 0) break;
      const qty = Number(lot.quantity);
      if (!(qty > 0)) continue;
      const take = Math.min(qty, left);
      const lotCost = parseMoney(nairaOrNull(lot.costMinor) ?? "0.00", "NGN").amountMinor;
      cost += (lotCost * BigInt(Math.round(take * 10000))) / BigInt(Math.round(qty * 10000));
      const nextQty = qty - take;
      if (nextQty <= 0) await this.docs("holding_lots").deleteOne({ _id: lot._id });
      else {
        await this.docs("holding_lots").updateOne(
          { _id: lot._id },
          { $set: { quantity: nextQty, costMinor: lotCost - (lotCost * BigInt(Math.round(take * 10000))) / BigInt(Math.round(qty * 10000)) } },
        );
      }
      left -= take;
    }
    return cost;
  }

  private markedValueMinor(quantity: number, priceMinor: bigint | null, costMinor: bigint): bigint {
    if (priceMinor == null) return costMinor;
    const units = BigInt(Math.round(quantity * 10000));
    return (priceMinor * units) / 10000n;
  }

  private async publicHolding(workspaceId: string, row: { _id: unknown; name?: unknown; accountId?: unknown; priceMinor?: unknown; maturesAt?: unknown }) {
    const lots = await this.docs("holding_lots").find({ workspaceId, holdingId: row._id }).toArray();
    let quantity = 0;
    let costMinor = 0n;
    const listed = lots.map((lot) => {
      quantity += Number(lot.quantity);
      const naira = nairaOrNull(lot.costMinor);
      if (naira) costMinor += parseMoney(naira, "NGN").amountMinor;
      return {
        id: lot._id,
        quantity: String(lot.quantity),
        cost: naira ?? "0.00",
        at: lot.at instanceof Date ? lot.at.toISOString() : String(lot.at ?? ""),
      };
    });
    const cost = nairaOrNull(costMinor) ?? "0.00";
    const priceMinor =
      row.priceMinor == null || row.priceMinor === ""
        ? null
        : parseMoney(nairaOrNull(row.priceMinor) ?? "0.00", "NGN").amountMinor;
    const value = nairaOrNull(this.markedValueMinor(quantity, priceMinor, costMinor)) ?? cost;
    const dividends = await this.docs("holding_dividends").find({ workspaceId, holdingId: row._id }).toArray();
    let dividendMinor = 0n;
    for (const payout of dividends) {
      const naira = nairaOrNull(payout.amountMinor);
      if (naira) dividendMinor += parseMoney(naira, "NGN").amountMinor;
    }
    const maturesAt =
      row.maturesAt instanceof Date ? row.maturesAt.toISOString() : row.maturesAt ? String(row.maturesAt) : null;
    return {
      id: row._id,
      name: row.name,
      accountId: row.accountId,
      quantity: String(quantity),
      capital: cost,
      cost,
      price: priceMinor == null ? null : nairaOrNull(priceMinor),
      value,
      maturesAt,
      dividends: nairaOrNull(dividendMinor) ?? "0.00",
      lots: listed,
    };
  }

  wipeOrder(): readonly string[] {
    return WIPE;
  }
}

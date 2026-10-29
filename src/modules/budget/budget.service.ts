import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import { Errors } from '../../common/errors/errors.js';
import { parseMinor, toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { CategoriesRepository } from '../categories/categories.repository.js';
import type { CategoriesService } from '../categories/categories.service.js';
import type { LedgerAccountDoc } from '../ledger/ledger.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { budgetMonths, monthFigures, monthOf, monthRange, netWorth, type PeriodTotal } from '../ledger/read.js';
import type { GoalAllocationsRepository } from '../goals/goals.repository.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import type { WorkspacesRepository } from '../workspaces/workspaces.repository.js';
import type { BudgetCategory, BudgetMonth, BudgetTemplate, Dashboard } from './budget.contract.js';
import type { BudgetMonthsRepository, BudgetTemplateDoc, BudgetTemplatesRepository } from './budget.repository.js';

export const BudgetErrors = {
  notSpending: () =>
    Errors.validation('categoryId', 'Pick a spending category. Income categories are not in the budget.'),
  hidden: () => Errors.validation('categoryId', 'This category is hidden from the budget.'),
  sameCategory: () => Errors.validation('toCategoryId', 'Pick two different categories.'),
  nothingToMove: () => Errors.validation('amount', "There isn't that much left to move from this category."),
  negativeAssigned: () => Errors.validation('assigned', "Assigned amounts can't be negative."),
};

type CatView = {
  id: string;
  kind: 'income' | 'expense';
  hidden: boolean;
  budgetable: boolean;
  carryOver: boolean;
  sortOrder: number;
};

/** Budgets (B1.9) and the Phase 1 Dashboard (B1.10), reading period_totals and budget_months. */
export class BudgetService {
  /**
   * Phase 5: exchange rates and holdings for net worth (TECH-SPEC 6.7), so the Dashboard's figure matches
   * Accounts: other currencies converted at the date's rate, holdings at market value.
   */
  wealthFor?: (
    ctx: WorkspaceContext,
    dates: string[],
  ) => Promise<{
    convert: (amount: bigint, from: string, date: string) => bigint | null;
    holdings: Map<string, { holding: { currency: string }; position: { value: bigint } }[]>;
  }>;

  /** Phase 5: the Health and Investments cards (DESIGN.md page 5). */
  phase5Cards?: (
    ctx: WorkspaceContext,
    month: string,
  ) => Promise<{
    health: {
      ready: boolean;
      score: number | null;
      band: 'strong' | 'okay' | 'needs_attention' | null;
      change: number | null;
    } | null;
    investments: { value: string; unrealised: string; change: string } | null;
  }>;

  constructor(
    private readonly database: Database,
    private readonly repos: BudgetMonthsRepository,
    private readonly templates: BudgetTemplatesRepository,
    private readonly ledger: LedgerService,
    private readonly categories: CategoriesService,
    private readonly categoriesRepo: CategoriesRepository,
    private readonly workspaces: WorkspacesRepository,
    private readonly transactions: TransactionsService,
    private readonly goalAllocations: GoalAllocationsRepository,
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(ctx: WorkspaceContext, month: string, count = 1): Promise<{ months: z.input<typeof BudgetMonth>[] }> {
    const end = month;
    const start = shiftMonth(end, -(count - 1));
    return { months: await this.compute(ctx, start, end) };
  }

  async assign(
    ctx: WorkspaceContext,
    month: string,
    categoryId: string,
    body: { assigned: string; carryOver?: boolean },
  ): Promise<z.input<typeof BudgetMonth>> {
    const assigned = parseMinor(body.assigned);
    if (assigned < 0n) throw BudgetErrors.negativeAssigned();
    await this.database.transaction(async (session) => {
      const cat = await this.requireSpending(ctx, categoryId, session);
      await this.repos.setAssigned(ctx, month, categoryId, assigned, this.now(), { session });
      if (body.carryOver !== undefined && body.carryOver !== cat.carryOver) {
        await this.categoriesRepo.updateOne(
          ctx,
          { _id: categoryId },
          { $set: { carryOver: body.carryOver, updatedAt: this.now() }, $inc: { version: 1 } },
          { session },
        );
        await this.ledger.feed(ctx, [{ collection: 'categories', docId: categoryId, op: 'upsert' }], session);
      }
      await this.ledger.feed(
        ctx,
        [{ collection: 'budget_months', docId: `${categoryId}:${month}`, op: 'upsert' }],
        session,
      );
      await this.audit.record(
        ctx,
        {
          action: 'budget.assigned',
          target: { collection: 'budget_months', id: `${categoryId}:${month}` },
          after: { month, categoryId, assigned: body.assigned, carryOver: body.carryOver },
        },
        { session },
      );
    });
    return (await this.get(ctx, month, 1)).months[0]!;
  }

  async move(
    ctx: WorkspaceContext,
    month: string,
    body: { fromCategoryId: string; toCategoryId: string; amount: string },
  ): Promise<z.input<typeof BudgetMonth>> {
    if (body.fromCategoryId === body.toCategoryId) throw BudgetErrors.sameCategory();
    const amount = parseMinor(body.amount);
    if (amount <= 0n) throw Errors.validation('amount', 'Enter an amount greater than zero.');
    await this.database.transaction(async (session) => {
      await this.requireSpending(ctx, body.fromCategoryId, session);
      await this.requireSpending(ctx, body.toCategoryId, session);
      const snap = await this.compute(ctx, month, month, session);
      const from = snap[0]!.categories.find((c) => c.categoryId === body.fromCategoryId);
      if (!from || parseMinor(from.available) < amount) throw BudgetErrors.nothingToMove();
      const fromAssigned = await this.assignedOf(ctx, body.fromCategoryId, month, session);
      const toAssigned = await this.assignedOf(ctx, body.toCategoryId, month, session);
      if (fromAssigned < amount) throw BudgetErrors.nothingToMove();
      await this.repos.setAssigned(ctx, month, body.fromCategoryId, fromAssigned - amount, this.now(), { session });
      await this.repos.setAssigned(ctx, month, body.toCategoryId, toAssigned + amount, this.now(), { session });
      await this.ledger.feed(
        ctx,
        [
          { collection: 'budget_months', docId: `${body.fromCategoryId}:${month}`, op: 'upsert' },
          { collection: 'budget_months', docId: `${body.toCategoryId}:${month}`, op: 'upsert' },
        ],
        session,
      );
      await this.audit.record(
        ctx,
        {
          action: 'budget.moved',
          target: { collection: 'budget_months', id: `${body.fromCategoryId}:${month}` },
          after: { month, ...body },
        },
        { session },
      );
    });
    return (await this.get(ctx, month, 1)).months[0]!;
  }

  async cover(
    ctx: WorkspaceContext,
    month: string,
    body: { covers: { categoryId: string; fromCategoryId: string; amount: string }[] },
  ): Promise<z.input<typeof BudgetMonth>> {
    await this.database.transaction(async (session) => {
      const deltas = new Map<string, bigint>();
      for (const c of body.covers) {
        if (c.categoryId === c.fromCategoryId) throw BudgetErrors.sameCategory();
        const amount = parseMinor(c.amount);
        if (amount <= 0n) throw Errors.validation('amount', 'Enter an amount greater than zero.');
        await this.requireSpending(ctx, c.categoryId, session);
        await this.requireSpending(ctx, c.fromCategoryId, session);
        deltas.set(c.fromCategoryId, (deltas.get(c.fromCategoryId) ?? 0n) - amount);
        deltas.set(c.categoryId, (deltas.get(c.categoryId) ?? 0n) + amount);
      }
      const snap = await this.compute(ctx, month, month, session);
      const available = new Map(snap[0]!.categories.map((c) => [c.categoryId, parseMinor(c.available)]));
      for (const c of body.covers) {
        const left = available.get(c.fromCategoryId) ?? 0n;
        const amount = parseMinor(c.amount);
        if (left < amount) throw BudgetErrors.nothingToMove();
        available.set(c.fromCategoryId, left - amount);
      }
      for (const [categoryId, delta] of deltas) {
        const current = await this.assignedOf(ctx, categoryId, month, session);
        const next = current + delta;
        if (next < 0n) throw BudgetErrors.nothingToMove();
        await this.repos.setAssigned(ctx, month, categoryId, next, this.now(), { session });
      }
      await this.ledger.feed(
        ctx,
        [...deltas.keys()].map((categoryId) => ({
          collection: 'budget_months' as const,
          docId: `${categoryId}:${month}`,
          op: 'upsert' as const,
        })),
        session,
      );
      await this.audit.record(
        ctx,
        {
          action: 'budget.covered',
          target: { collection: 'budget_months', id: month },
          after: { month, covers: body.covers },
        },
        { session },
      );
    });
    return (await this.get(ctx, month, 1)).months[0]!;
  }

  async listTemplates(ctx: WorkspaceContext): Promise<{ templates: z.input<typeof BudgetTemplate>[] }> {
    const docs = await this.templates.list(ctx);
    return { templates: docs.map(templateView) };
  }

  async saveTemplate(
    ctx: WorkspaceContext,
    templateId: string,
    body: { name: string; rules: { categoryId: string; assigned: string }[] },
  ): Promise<z.input<typeof BudgetTemplate>> {
    return this.database.transaction(async (session) => {
      for (const rule of body.rules) await this.requireSpending(ctx, rule.categoryId, session);
      const now = this.now();
      const rules = body.rules.map((r) => ({ categoryId: r.categoryId, assignedMinor: parseMinor(r.assigned) }));
      const after = await this.templates.findOneAndUpdate(
        ctx,
        { _id: templateId },
        {
          $set: { name: body.name, rules, updatedAt: now },
          $inc: { version: 1 },
          $setOnInsert: { createdAt: now },
        },
        { session, upsert: true },
      );
      await this.ledger.feed(ctx, [{ collection: 'templates', docId: templateId, op: 'upsert' }], session);
      return templateView(after!);
    });
  }

  async applyTemplate(
    ctx: WorkspaceContext,
    month: string,
    templateId: string,
    preview: boolean,
  ): Promise<z.input<typeof BudgetMonth>> {
    const tpl = await this.templates.findOne(ctx, { _id: templateId });
    if (!tpl) throw Errors.notFound();
    if (!preview) {
      await this.database.transaction(async (session) => {
        for (const rule of tpl.rules) {
          await this.requireSpending(ctx, rule.categoryId, session);
          await this.repos.setAssigned(ctx, month, rule.categoryId, rule.assignedMinor, this.now(), { session });
          await this.ledger.feed(
            ctx,
            [{ collection: 'budget_months', docId: `${rule.categoryId}:${month}`, op: 'upsert' }],
            session,
          );
        }
        await this.audit.record(
          ctx,
          { action: 'budget.template_applied', target: { collection: 'templates', id: templateId }, after: { month } },
          { session },
        );
      });
    }
    return (await this.get(ctx, month, 1)).months[0]!;
  }

  async dashboard(ctx: WorkspaceContext, month: string): Promise<z.input<typeof Dashboard>> {
    const last = shiftMonth(month, -1);
    const seriesStart = shiftMonth(month, -11);
    const incomeStart = shiftMonth(month, -5);
    const historyStart = await this.historyStart(ctx, seriesStart);

    const [ws, tree, totals, accountDocs, recent, budgetNow, budgetLast, getStarted] = await Promise.all([
      this.workspaces.get(ctx),
      this.categories.tree(ctx),
      this.ledger.totals.months(ctx, historyStart, month),
      this.ledger.accounts.find(ctx, { accountType: { $ne: null }, systemKey: null } as never),
      this.transactions.list(ctx, { status: 'live', limit: 8 } as never),
      this.compute(ctx, month, month),
      this.compute(ctx, last, last),
      this.getStarted(ctx),
    ]);
    if (!ws) throw Errors.notFound();
    const currency = ws.currency;
    const cats = tree.categories as CatView[];
    const budgetableIncomeIds = new Set(cats.filter((c) => c.kind === 'income' && c.budgetable).map((c) => c.id));
    const accountOf = accountLookup(await this.ledger.accounts.find(ctx, {}));
    const categoryLedger = await this.ledger.accounts.byCategories(
      ctx,
      cats.map((c) => c.id),
    );
    const ledgerToCategory = new Map(categoryLedger.filter((a) => a.categoryId).map((a) => [a._id, a.categoryId!]));
    const budgetableLedgerIds = new Set(
      categoryLedger.filter((a) => a.categoryId && budgetableIncomeIds.has(a.categoryId)).map((a) => a._id),
    );

    const periodRows = asPeriodTotals(totals);
    const fig = (m: string) => monthFigures(periodRows, m, accountOf);
    const thisFig = fig(month);
    const lastFig = fig(last);
    const budgetableIncome = (m: string) => {
      let sum = 0n;
      for (const [id, v] of fig(m).incomeByAccount) if (budgetableLedgerIds.has(id)) sum += v;
      return sum;
    };
    const incomeAmt = budgetableIncome(month);
    const incomeLast = budgetableIncome(last);
    const spentAmt = thisFig.spent;
    const spentLast = lastFig.spent;
    const thisBudget = budgetNow[0]!;
    const lastBudget = budgetLast[0]!;
    const leftNow = parseMinor(thisBudget.leftToSpend);
    const leftLast = parseMinor(lastBudget.leftToSpend);
    const tile = (amount: bigint, lastMonth: bigint) => ({
      amount: toMinorString(amount),
      lastMonth: toMinorString(lastMonth),
      change: toMinorString(amount - lastMonth),
    });

    const balanceThrough = (endMonth: string) => {
      const map = new Map<string, bigint>();
      for (const t of periodRows) {
        if (t.month > endMonth) continue;
        map.set(t.ledgerAccountId, (map.get(t.ledgerAccountId) ?? 0n) + (t.debitsMinor - t.creditsMinor));
      }
      return map;
    };
    const today = this.now().toISOString().slice(0, 10);
    const dateOf = (m: string) => {
      const end = `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;
      return end < today ? end : today;
    };
    const wealth = await this.wealthFor?.(ctx, monthRange(seriesStart, month).map(dateOf));
    const worthAt = (endMonth: string) => {
      const date = dateOf(endMonth);
      const partial = new Set<string>();
      const w = netWorth(
        balanceThrough(endMonth),
        accountDocs.map((a) => ({
          id: a._id,
          kind: a.kind,
          currency: a.currency,
          systemKey: null,
        })),
        currency,
        (amount, from) => wealth?.convert(amount, from, date) ?? null,
      );
      w.partial.forEach((c) => partial.add(c));
      let amount = w.amount;
      for (const { holding, position } of wealth?.holdings.get(date) ?? []) {
        const v =
          holding.currency === currency ? position.value : wealth!.convert(position.value, holding.currency, date);
        if (v === null) partial.add(holding.currency);
        else amount += v;
      }
      return { amount, partial: [...partial].sort() };
    };
    const currentWorth = worthAt(month);
    const series = monthRange(seriesStart, month).map((m) => ({
      month: m,
      amount: toMinorString(worthAt(m).amount),
    }));

    const incomeVsSpending = monthRange(incomeStart, month).map((m) => ({
      month: m,
      income: toMinorString(budgetableIncome(m)),
      spent: toMinorString(fig(m).spent),
    }));

    const spendingByDay = await this.spendingByDay(ctx, month, last, accountOf);
    const progress = [...thisBudget.categories]
      .filter((c) => c.usedBasisPoints !== null)
      .sort((a, b) => (b.usedBasisPoints ?? 0) - (a.usedBasisPoints ?? 0))
      .slice(0, 5);

    const whereMap = new Map<string, bigint>();
    for (const [ledgerId, amt] of thisFig.spentByAccount) {
      const catId = ledgerToCategory.get(ledgerId);
      if (!catId || amt === 0n) continue;
      whereMap.set(catId, (whereMap.get(catId) ?? 0n) + amt);
    }
    const whereItWent = [...whereMap.entries()]
      .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1))
      .map(([categoryId, amount]) => ({ categoryId, amount: toMinorString(amount) }));

    return {
      month,
      netWorth: {
        amount: toMinorString(currentWorth.amount),
        partial: currentWorth.partial,
        series,
      },
      tiles: {
        income: tile(incomeAmt, incomeLast),
        spent: tile(spentAmt, spentLast),
        netCash: tile(incomeAmt - spentAmt, incomeLast - spentLast),
        budgetLeft: tile(leftNow, leftLast),
      },
      leftToSpend: { amount: thisBudget.leftToSpend, planned: thisBudget.planned },
      incomeVsSpending,
      spendingByDay,
      budgetProgress: progress,
      whereItWent,
      recent: recent.items,
      getStarted,
      ...((await this.phase5Cards?.(ctx, month)) ?? { health: null, investments: null }),
    };
  }

  private async getStarted(ctx: WorkspaceContext) {
    const [accountCount, assignedCount, nonOpening] = await Promise.all([
      this.ledger.accounts.count(ctx, { accountType: { $ne: null }, systemKey: null } as never),
      this.repos.count(ctx, { assignedMinor: { $gt: 0n } } as never),
      this.ledger.transactions.count(ctx, {
        status: 'posted',
        type: { $nin: ['opening_balance', 'reversal'] },
      } as never),
    ]);
    return {
      hidden: false,
      steps: [
        { key: 'account', done: accountCount > 0 },
        { key: 'transaction', done: nonOpening > 0 },
        { key: 'budget', done: assignedCount > 0 },
        { key: 'bill', done: false },
        { key: 'income_stream', done: false },
        { key: 'two_factor', done: false },
      ],
    };
  }

  private async spendingByDay(
    ctx: WorkspaceContext,
    thisMonth: string,
    lastMonth: string,
    accountOf: (id: string) => { kind: string } | null,
  ) {
    const thisDays = daysInMonth(thisMonth);
    const lastDays = daysInMonth(lastMonth);
    const from = `${lastMonth}-01`;
    const to = `${thisMonth}-${String(thisDays).padStart(2, '0')}`;
    const events = await this.ledger.transactions.find(
      ctx,
      { status: 'posted', date: { $gte: from, $lte: to } } as never,
      {},
    );
    const daySpend = (month: string, day: number) => {
      let sum = 0n;
      const date = `${month}-${String(day).padStart(2, '0')}`;
      for (const e of events) {
        if (e.date !== date) continue;
        for (const l of e.lines) {
          if (accountOf(l.ledgerAccountId)?.kind === 'expense') sum += l.amountMinor;
        }
      }
      return sum;
    };
    const out: { day: number; thisMonth: string; lastMonth: string }[] = [];
    let thisCum = 0n;
    let lastCum = 0n;
    for (let day = 1; day <= thisDays; day++) {
      thisCum += daySpend(thisMonth, day);
      if (day <= lastDays) lastCum += daySpend(lastMonth, day);
      out.push({ day, thisMonth: toMinorString(thisCum), lastMonth: toMinorString(lastCum) });
    }
    return out;
  }

  private async compute(
    ctx: WorkspaceContext,
    windowStart: string,
    windowEnd: string,
    session?: ClientSession,
  ): Promise<z.input<typeof BudgetMonth>[]> {
    const ws = await this.workspaces.get(ctx, { session });
    if (!ws) throw Errors.notFound();
    const style = ws.budgetStyle;
    const tree = await this.categories.tree(ctx);
    const cats = (tree.categories as CatView[]).filter((c) => c.kind === 'expense' && !c.hidden);
    const incomeCats = (tree.categories as CatView[]).filter((c) => c.kind === 'income');
    const historyStart = minMonth(await this.historyStart(ctx, windowStart, session), windowStart);
    const months = monthRange(historyStart, windowEnd);
    const totals = asPeriodTotals(await this.ledger.totals.months(ctx, historyStart, windowEnd, { session }));
    const assignedDocs = await this.repos.forMonths(ctx, historyStart, windowEnd, { session });
    const assigned = new Map(assignedDocs.map((d) => [`${d.categoryId}|${d.month}`, BigInt(d.assignedMinor)]));
    const allAccounts = await this.ledger.accounts.find(ctx, {}, { session });
    const accountOf = accountLookup(allAccounts);
    const categoryLedger = allAccounts.filter((a) => a.categoryId);
    const catLedgerId = new Map(categoryLedger.map((a) => [a.categoryId!, a._id]));
    const budgetableLedger = new Set(
      incomeCats
        .filter((c) => c.budgetable)
        .map((c) => catLedgerId.get(c.id))
        .filter(Boolean) as string[],
    );
    const carry = new Map(cats.map((c) => [c.id, c.carryOver]));
    const goalSpendByCatMonth = await this.goalSpendByCategoryMonth(ctx, historyStart, windowEnd, session);
    const earmarksByMonth = await this.goalEarmarksByMonth(ctx, historyStart, windowEnd, session);
    const raw = budgetMonths({
      style,
      months,
      categoryIds: cats.map((c) => c.id),
      assigned: (id, m) => assigned.get(`${id}|${m}`) ?? 0n,
      activity: (id, m) => {
        const ledgerId = catLedgerId.get(id);
        if (!ledgerId) return 0n;
        const rawSpent = monthFigures(totals, m, accountOf).spentByAccount.get(ledgerId) ?? 0n;
        // E19: goal spend posts to the category but is not overspending (TECH-SPEC 6.6).
        return rawSpent - (goalSpendByCatMonth.get(`${id}|${m}`) ?? 0n);
      },
      budgetableIncome: (m) => {
        let sum = 0n;
        for (const [id, v] of monthFigures(totals, m, accountOf).incomeByAccount) {
          if (budgetableLedger.has(id)) sum += v;
        }
        return sum;
      },
      goalAllocations: (m) => earmarksByMonth.get(m) ?? 0n,
      carriesOver: (id) => carry.get(id) ?? false,
    });

    return raw
      .filter((bm) => bm.month >= windowStart && bm.month <= windowEnd)
      .map((bm) => {
        const fig = monthFigures(totals, bm.month, accountOf);
        let planned = 0n;
        let spent = 0n;
        let leftToSpend = 0n;
        let overspentCount = 0;
        const categories: z.input<typeof BudgetCategory>[] = [];
        for (const c of cats) {
          const row = bm.categories.get(c.id)!;
          planned += row.assigned;
          spent += row.activity;
          if (row.available > 0n) leftToSpend += row.available;
          if (row.state === 'over_plan') overspentCount += 1;
          categories.push({
            categoryId: c.id,
            carried: toMinorString(row.carried),
            assigned: toMinorString(row.assigned),
            activity: toMinorString(row.activity),
            available: toMinorString(row.available),
            usedBasisPoints: row.usedBasisPoints === null ? null : Number(row.usedBasisPoints),
            state: row.state,
            carryOver: style === 'envelope' ? true : c.carryOver,
          });
        }
        let budgetable = 0n;
        for (const [id, v] of fig.incomeByAccount) if (budgetableLedger.has(id)) budgetable += v;
        return {
          month: bm.month,
          style,
          categories,
          income: { received: toMinorString(fig.income), budgetable: toMinorString(budgetable) },
          planned: toMinorString(planned),
          spent: toMinorString(spent),
          leftToPlan: bm.leftToPlan === null ? null : toMinorString(bm.leftToPlan),
          overspentFromLastMonth: toMinorString(bm.overspentFromLastMonth),
          overspentCount,
          leftToSpend: toMinorString(leftToSpend),
        };
      });
  }

  /** Category activity to exclude for E19 goal spends (TECH-SPEC 6.6). */
  private async goalSpendByCategoryMonth(
    ctx: WorkspaceContext,
    fromMonth: string,
    toMonth: string,
    session?: ClientSession,
  ): Promise<Map<string, bigint>> {
    const from = `${fromMonth}-01`;
    const to = `${toMonth}-31`;
    const events = await this.ledger.transactions.find(
      ctx,
      {
        status: 'posted',
        type: 'expense',
        'links.goalId': { $type: 'string' },
        date: { $gte: from, $lte: to },
      } as never,
      { session },
    );
    const out = new Map<string, bigint>();
    for (const e of events) {
      const m = monthOf(e.date);
      for (const l of e.lines) {
        if (!l.categoryId || l.amountMinor <= 0n) continue;
        const key = `${l.categoryId}|${m}`;
        out.set(key, (out.get(key) ?? 0n) + l.amountMinor);
      }
    }
    return out;
  }

  /** E18 earmarks in each month for left_to_plan (TECH-SPEC 6.6). */
  private async goalEarmarksByMonth(
    ctx: WorkspaceContext,
    fromMonth: string,
    toMonth: string,
    session?: ClientSession,
  ): Promise<Map<string, bigint>> {
    const rows = await this.goalAllocations.find(ctx, {}, { session });
    const out = new Map<string, bigint>();
    for (const a of rows) {
      if (a.kind === 'spend') continue;
      const m = monthOf(a.date);
      if (m < fromMonth || m > toMonth) continue;
      out.set(m, (out.get(m) ?? 0n) + BigInt(a.amountMinor));
    }
    return out;
  }

  private async historyStart(ctx: WorkspaceContext, fallback: string, session?: ClientSession) {
    const [earliestAssign, earliestTotal] = await Promise.all([
      this.repos.earliest(ctx, { session }),
      this.ledger.totals.find(ctx, {}, { session, sort: { month: 1 }, limit: 1 }),
    ]);
    const candidates = [fallback];
    if (earliestAssign) candidates.push(earliestAssign.month);
    if (earliestTotal[0]) candidates.push(earliestTotal[0].month);
    return candidates.reduce((a, b) => (a < b ? a : b));
  }

  private async assignedOf(ctx: WorkspaceContext, categoryId: string, month: string, session: ClientSession) {
    const doc = await this.repos.byCategoryMonth(ctx, categoryId, month, { session });
    return BigInt(doc?.assignedMinor ?? 0n);
  }

  private async requireSpending(ctx: WorkspaceContext, categoryId: string, session: ClientSession) {
    const cat = await this.categoriesRepo.byId(ctx, categoryId, { session });
    if (!cat) throw Errors.notFound();
    if (cat.kind !== 'expense') throw BudgetErrors.notSpending();
    if (cat.hidden) throw BudgetErrors.hidden();
    return cat;
  }
}

function accountLookup(accounts: LedgerAccountDoc[]) {
  const byId = new Map(accounts.map((a) => [a._id, a]));
  return (id: string) => {
    const a = byId.get(id);
    return a ? { kind: a.kind } : null;
  };
}

function asPeriodTotals(
  rows: { ledgerAccountId: string; month: string; debitsMinor: bigint; creditsMinor: bigint }[],
): PeriodTotal[] {
  return rows.map((r) => ({
    ledgerAccountId: r.ledgerAccountId,
    month: r.month,
    debitsMinor: BigInt(r.debitsMinor),
    creditsMinor: BigInt(r.creditsMinor),
  }));
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function minMonth(a: string, b: string) {
  return a < b ? a : b;
}

function templateView(doc: BudgetTemplateDoc): z.input<typeof BudgetTemplate> {
  return {
    id: doc._id,
    name: doc.name,
    rules: doc.rules.map((r) => ({ categoryId: r.categoryId, assigned: toMinorString(r.assignedMinor) })),
    version: doc.version,
  };
}

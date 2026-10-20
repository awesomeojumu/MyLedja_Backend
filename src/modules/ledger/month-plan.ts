/**
 * The monthly budget's set-asides: for every bill, goal and debt with a deadline, how much of this month's income
 * has to go toward it so it's covered on time. Pure functions over minor units (kobo) as bigint.
 */

export type SetAsideKind = "bill" | "goal" | "debt";

export interface SetAside {
  kind: SetAsideKind;
  refId: string;
  name: string;
  /** What this month has to put toward it. */
  amountMinor: bigint;
  /** The whole amount due by the deadline (bill amount, goal still to save, debt left to pay). */
  totalMinor: bigint;
  /** YYYY-MM-DD, or null when there's no deadline (then nothing is set aside, and the item is flagged). */
  due: string | null;
  monthsLeft: number;
}

/** "2027-01" → { year: 2027, month: 0 }. */
export function parseMonth(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11) return null;
  return { year: Number(m[1]), month };
}

export function monthKey(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousMonth(key: string): string {
  const p = parseMonth(key);
  if (!p) throw new Error("bad month");
  return monthKey(p.year, p.month - 1);
}

function clampDay(year: number, month: number, day: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(Math.max(day, 1), last)));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * How many months, starting with this one, end on or before the due date: money set aside by the end of each of
 * them is ready in time. Rent due 1 April gives January–March (3); a loan cleared by 31 May gives January–May (5).
 * Due this month or already overdue → 1, so the whole amount is needed now.
 */
export function monthsUntil(month: { year: number; month: number }, due: Date): number {
  let n = 0;
  while (n < 600 && Date.UTC(month.year, month.month + n + 1, 0) <= due.getTime()) n += 1;
  return Math.max(1, n);
}

/** Round up to whole kobo so the total is always covered. */
function share(totalMinor: bigint, months: number): bigint {
  if (totalMinor <= 0n) return 0n;
  const n = BigInt(Math.max(1, months));
  return (totalMinor + n - 1n) / n;
}

export interface BillInput {
  id: string;
  name: string;
  amountMinor: bigint;
  cadence: string;
  anchorDay: number;
  /** 1–12; only yearly bills use it. */
  anchorMonth?: number | null;
  weekday: number;
  lastPaidAt: Date | null;
}

/** Weekly bills fall due once per matching weekday in the month. */
function weekdaysInMonth(year: number, month: number, weekday: number): number {
  let n = 0;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) if (new Date(Date.UTC(year, month, d)).getUTCDay() === weekday) n += 1;
  return n;
}

/**
 * The next time a yearly bill falls due on or after the start of this month. If it was paid within the 11 months
 * before that date, that cycle is done and the next one is a year later.
 */
export function yearlyDue(bill: BillInput, month: { year: number; month: number }): Date {
  const anchorMonth = Math.min(12, Math.max(1, bill.anchorMonth ?? month.month + 1)) - 1;
  const start = Date.UTC(month.year, month.month, 1);
  let due = clampDay(month.year, anchorMonth, bill.anchorDay);
  if (due.getTime() < start) due = clampDay(month.year + 1, anchorMonth, bill.anchorDay);
  if (bill.lastPaidAt) {
    const cycleOpens = Date.UTC(due.getUTCFullYear(), due.getUTCMonth() - 11, 1);
    if (bill.lastPaidAt.getTime() >= cycleOpens) due = clampDay(due.getUTCFullYear() + 1, anchorMonth, bill.anchorDay);
  }
  return due;
}

/**
 * @param earlier What earlier months' budgets already set aside for each ref in the current cycle (refId → kobo).
 */
export function billSetAside(bill: BillInput, monthKeyValue: string, earlier: Map<string, bigint>): SetAside {
  const month = parseMonth(monthKeyValue)!;
  if (bill.cadence === "weekly") {
    const total = bill.amountMinor * BigInt(weekdaysInMonth(month.year, month.month, bill.weekday));
    const due = clampDay(month.year, month.month + 1, 0);
    return { kind: "bill", refId: bill.id, name: bill.name, amountMinor: total, totalMinor: total, due: iso(due), monthsLeft: 1 };
  }
  if (bill.cadence === "yearly") {
    const due = yearlyDue(bill, month);
    const monthsLeft = monthsUntil(month, due);
    const left = bill.amountMinor - (earlier.get(bill.id) ?? 0n);
    return { kind: "bill", refId: bill.id, name: bill.name, amountMinor: share(left, monthsLeft), totalMinor: bill.amountMinor, due: iso(due), monthsLeft };
  }
  const due = clampDay(month.year, month.month, bill.anchorDay);
  return { kind: "bill", refId: bill.id, name: bill.name, amountMinor: bill.amountMinor, totalMinor: bill.amountMinor, due: iso(due), monthsLeft: 1 };
}

export interface GoalInput {
  id: string;
  name: string;
  targetMinor: bigint;
  savedMinor: bigint;
  dueAt: Date | null;
}

/** What's still to save, spread over the months to the goal's date. No date → nothing planned (flagged instead). */
export function goalSetAside(goal: GoalInput, monthKeyValue: string): SetAside {
  const month = parseMonth(monthKeyValue)!;
  const left = goal.targetMinor > goal.savedMinor ? goal.targetMinor - goal.savedMinor : 0n;
  if (!goal.dueAt) return { kind: "goal", refId: goal.id, name: goal.name, amountMinor: 0n, totalMinor: left, due: null, monthsLeft: 0 };
  const monthsLeft = monthsUntil(month, goal.dueAt);
  return { kind: "goal", refId: goal.id, name: goal.name, amountMinor: share(left, monthsLeft), totalMinor: left, due: iso(goal.dueAt), monthsLeft };
}

export interface DebtInput {
  id: string;
  name: string;
  remainingMinor: bigint;
  payoffBy: Date | null;
}

export function debtSetAside(debt: DebtInput, monthKeyValue: string): SetAside {
  const month = parseMonth(monthKeyValue)!;
  if (!debt.payoffBy) return { kind: "debt", refId: debt.id, name: debt.name, amountMinor: 0n, totalMinor: debt.remainingMinor, due: null, monthsLeft: 0 };
  const monthsLeft = monthsUntil(month, debt.payoffBy);
  return { kind: "debt", refId: debt.id, name: debt.name, amountMinor: share(debt.remainingMinor, monthsLeft), totalMinor: debt.remainingMinor, due: iso(debt.payoffBy), monthsLeft };
}

/** A month's expected income from monthly, weekly and yearly streams. */
export function expectedIncome(streams: { expectedMinor: bigint; cadence: string; payDay?: number | null; weekday?: number }[], monthKeyValue: string): bigint {
  const month = parseMonth(monthKeyValue)!;
  let total = 0n;
  for (const s of streams) {
    if (s.cadence === "weekly") total += s.expectedMinor * BigInt(weekdaysInMonth(month.year, month.month, s.weekday ?? 5));
    else if (s.cadence === "yearly") total += 0n;
    else total += s.expectedMinor;
  }
  return total;
}

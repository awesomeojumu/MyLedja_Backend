import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { expect } from 'vitest';
import { AppError } from '../../src/common/errors/errors.js';
import { buildEvent, buildReversal, type Resolver } from '../../src/modules/ledger/builders.js';
import { checkLines } from '../../src/modules/ledger/checks.js';
import { EventInput } from '../../src/modules/ledger/ledger.inputs.js';
import {
  type AccountRef,
  type EventType,
  type LedgerKind,
  type Line,
  SYSTEM_ACCOUNTS,
  SYSTEM_KEYS,
  type SystemKey,
} from '../../src/modules/ledger/ledger.types.js';
import {
  balances,
  budgetMonths,
  monthFigures,
  netWorth,
  periodTotals,
  shownBalance,
} from '../../src/modules/ledger/read.js';

type Amounts = Record<string, string>;
type LineSpec = { account: string; amount: string };

export type CaseStep = {
  ref?: string;
  operation?: string;
  post?: Record<string, unknown>;
  correct?: string;
  reverse?: string;
  input?: Record<string, unknown>;
  expectLines?: LineSpec[];
  expectReversalLines?: LineSpec[];
  expectError?: { status: number; code: string; message: string };
  expectDuplicateOf?: string;
};

export type LedgerCase = {
  id: number;
  title: string;
  steps: CaseStep[];
  budget?: { style: 'envelope' | 'tracking'; months: string[]; assigned: Record<string, Amounts> };
  expect: {
    balances?: Amounts;
    months?: Record<string, { income: string; spent: string; spentByCategory: Amounts }>;
    netWorth?: string;
    eventCount?: number;
    statuses?: Record<string, string>;
    budget?: Record<
      string,
      { leftToPlan: string | null; overspentFromLastMonth: string; categories: Record<string, Record<string, string>> }
    >;
  };
};

export type CasesFile = {
  currency: string;
  accounts: {
    key: string;
    kind: LedgerKind;
    accountType: string;
    name: string;
    personDebt?: 'receivable' | 'payable';
  }[];
  categories: { key: string; kind: 'income' | 'expense'; name: string; budgetable?: boolean; system?: SystemKey }[];
  cases: LedgerCase[];
};

export const CASES_PATH = resolve(import.meta.dirname, '../fixtures/ledger-cases.json');
export const loadCases = (): CasesFile => JSON.parse(readFileSync(CASES_PATH, 'utf8')) as CasesFile;

export type EngineEvent = { id: string; type: EventType; status: string; date: string; lines: Line[] };

/** What a case runs against: the pure builders in memory, or the real ledger service and database. */
export interface Engine {
  /** Ids of fixture accounts by key, categories by key (their ledger account) and system accounts as "system:<key>". */
  readonly ledgerIds: Map<string, string>;
  readonly realIds: Map<string, string>;
  readonly categoryIds: Map<string, string>;
  readonly refs: Map<string, AccountRef>;
  post(input: EventInput, operationId: string): Promise<{ event: EngineEvent; duplicate: boolean }>;
  correct(id: string, input: EventInput, operationId: string): Promise<{ reversal: EngineEvent; event: EngineEvent }>;
  reverse(id: string, operationId: string): Promise<EngineEvent>;
  events(): Promise<EngineEvent[]>;
}

/** Replaces "@key" with the account or category id and "#ref" with an earlier event's id. */
function bind(raw: Record<string, unknown>, engine: Engine, events: Map<string, string>): EventInput {
  const swap = (v: unknown, field: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => swap(x, field));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, k)]));
    if (typeof v !== 'string') return v;
    if (v.startsWith('#')) return events.get(v.slice(1)) ?? v;
    if (v.startsWith('@')) {
      const key = v.slice(1);
      const id = field === 'categoryId' ? engine.categoryIds.get(key) : engine.realIds.get(key);
      if (!id) throw new Error(`unknown ${field} ${v}`);
      return id;
    }
    return v;
  };
  return EventInput.parse(swap(raw, ''));
}

const linesOf = (lines: readonly Line[], engine: Engine) => {
  const keyOf = new Map([...engine.ledgerIds].map(([k, id]) => [id, `@${k}`]));
  return lines.map((l) => ({
    account: keyOf.get(l.ledgerAccountId) ?? l.ledgerAccountId,
    amount: l.amountMinor.toString(),
  }));
};

export async function runCase(c: LedgerCase, file: CasesFile, engine: Engine) {
  const events = new Map<string, string>();
  for (const step of c.steps) {
    const operationId = step.operation ? `case-${c.id}-${step.operation}` : uuidv7();
    const attempt = async () => {
      if (step.post) {
        const { event, duplicate } = await engine.post(bind(step.post, engine, events), operationId);
        if (step.expectDuplicateOf) {
          expect(duplicate, `case ${c.id}: duplicate`).toBe(true);
          expect(event.id).toBe(events.get(step.expectDuplicateOf.slice(1)));
        }
        if (step.expectLines) expect(linesOf(event.lines, engine), `case ${c.id} lines`).toEqual(step.expectLines);
        return event;
      }
      if (step.correct) {
        const id = events.get(step.correct.slice(1))!;
        const { reversal, event } = await engine.correct(id, bind(step.input!, engine, events), operationId);
        if (step.expectReversalLines) expect(linesOf(reversal.lines, engine)).toEqual(step.expectReversalLines);
        if (step.expectLines) expect(linesOf(event.lines, engine)).toEqual(step.expectLines);
        return event;
      }
      if (step.reverse) return engine.reverse(events.get(step.reverse.slice(1))!, operationId);
      throw new Error(`case ${c.id}: a step needs post, correct or reverse`);
    };
    if (step.expectError) {
      const err = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, `case ${c.id}: expected ${step.expectError.code}`).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(step.expectError.status);
      expect((err as AppError).body()).toMatchObject({
        code: step.expectError.code,
        message: step.expectError.message,
      });
      continue;
    }
    const event = await attempt();
    if (step.ref) events.set(step.ref, event.id);
  }

  const all = await engine.events();
  const accountOf = (id: string) => engine.refs.get(id) ?? null;
  const bal = balances(all);
  const totals = periodTotals(all);
  const e = c.expect;
  if (e.balances) {
    for (const [key, amount] of Object.entries(e.balances)) {
      const ref = engine.refs.get(engine.realIds.get(key)!)!;
      expect(shownBalance(ref.kind, bal.get(ref.id) ?? 0n).toString(), `case ${c.id}: balance of ${key}`).toBe(amount);
    }
  }
  for (const [month, want] of Object.entries(e.months ?? {})) {
    const f = monthFigures(totals, month, accountOf);
    const byCategory: Amounts = {};
    for (const key of engine.categoryIds.keys()) {
      const v = f.spentByAccount.get(engine.ledgerIds.get(key)!) ?? 0n;
      if (v !== 0n) byCategory[key] = v.toString();
    }
    expect(
      { income: f.income.toString(), spent: f.spent.toString(), spentByCategory: byCategory },
      `case ${c.id}: ${month}`,
    ).toEqual(want);
  }
  if (e.netWorth !== undefined) {
    expect(netWorth(bal, [...engine.refs.values()], file.currency).amount.toString(), `case ${c.id}: net worth`).toBe(
      e.netWorth,
    );
  }
  if (e.eventCount !== undefined) expect(all.length, `case ${c.id}: events`).toBe(e.eventCount);
  for (const [ref, status] of Object.entries(e.statuses ?? {})) {
    expect(all.find((x) => x.id === events.get(ref))?.status, `case ${c.id}: ${ref} status`).toBe(status);
  }
  if (c.budget && e.budget) {
    const budgetable = new Set(file.categories.filter((x) => x.budgetable).map((x) => engine.ledgerIds.get(x.key)!));
    const months = budgetMonths({
      style: c.budget.style,
      months: c.budget.months,
      categoryIds: Object.keys(Object.values(c.budget.assigned)[0] ?? {}),
      assigned: (cat, m) => BigInt(c.budget!.assigned[m]?.[cat] ?? '0'),
      activity: (cat, m) => monthFigures(totals, m, accountOf).spentByAccount.get(engine.ledgerIds.get(cat)!) ?? 0n,
      budgetableIncome: (m) => {
        let sum = 0n;
        for (const [id, v] of monthFigures(totals, m, accountOf).incomeByAccount) if (budgetable.has(id)) sum += v;
        return sum;
      },
    });
    for (const bm of months) {
      const want = e.budget[bm.month];
      if (!want) continue;
      const cats: Record<string, Record<string, string>> = {};
      for (const [key, v] of bm.categories) {
        cats[key] = {
          carried: v.carried.toString(),
          assigned: v.assigned.toString(),
          activity: v.activity.toString(),
          available: v.available.toString(),
          state: v.state,
        };
      }
      expect(
        {
          leftToPlan: bm.leftToPlan === null ? null : bm.leftToPlan.toString(),
          overspentFromLastMonth: bm.overspentFromLastMonth.toString(),
          categories: cats,
        },
        `case ${c.id}: budget ${bm.month}`,
      ).toEqual(want);
    }
  }
}

/** The pure engine: builders, checks and the read formulas, with no database. What the app runs offline. */
export function memoryEngine(file: CasesFile): Engine {
  const refs = new Map<string, AccountRef>();
  const ledgerIds = new Map<string, string>();
  const realIds = new Map<string, string>();
  const categoryIds = new Map<string, string>();
  const system = new Map<SystemKey, AccountRef>();
  for (const key of SYSTEM_KEYS) {
    const ref: AccountRef = {
      id: uuidv7(),
      kind: SYSTEM_ACCOUNTS[key].kind,
      currency: file.currency,
      systemKey: key,
      categoryId: null,
      archived: false,
    };
    refs.set(ref.id, ref);
    system.set(key, ref);
    ledgerIds.set(`system:${key}`, ref.id);
  }
  for (const a of file.accounts) {
    const ref: AccountRef = {
      id: uuidv7(),
      kind: a.kind,
      currency: file.currency,
      systemKey: null,
      categoryId: null,
      archived: false,
      personDebt: a.personDebt ?? null,
    };
    refs.set(ref.id, ref);
    realIds.set(a.key, ref.id);
    ledgerIds.set(a.key, ref.id);
  }
  for (const c of file.categories) {
    const categoryId = uuidv7();
    const ref: AccountRef = c.system
      ? { ...system.get(c.system)!, categoryId }
      : { id: uuidv7(), kind: c.kind, currency: file.currency, systemKey: null, categoryId, archived: false };
    refs.set(ref.id, ref);
    if (c.system) system.set(c.system, ref);
    categoryIds.set(c.key, categoryId);
    ledgerIds.set(c.key, ref.id);
  }
  const byCategory = new Map([...refs.values()].filter((r) => r.categoryId).map((r) => [r.categoryId!, r]));
  const events: (EngineEvent & { operationId: string; refundOf?: string })[] = [];

  const resolver = (): Resolver => ({
    account: (id) => refs.get(id) ?? null,
    category: (id) => byCategory.get(id) ?? null,
    system: (key) => system.get(key)!,
    original: (id) => {
      const e = events.find((x) => x.id === id);
      if (!e) return null;
      const refunded = events
        .filter((x) => x.refundOf === id && x.status === 'posted')
        .reduce((s, x) => s + x.lines.filter((l) => l.amountMinor > 0n).reduce((t, l) => t + l.amountMinor, 0n), 0n);
      return { type: e.type, status: e.status, lines: e.lines, refunded };
    },
  });
  const accountOf = (id: string) => refs.get(id) ?? null;

  const engine: Engine = {
    ledgerIds,
    realIds,
    categoryIds,
    refs,
    async post(input, operationId) {
      const first = events.find((e) => e.operationId === operationId);
      if (first) return { event: first, duplicate: true };
      const built = buildEvent(input, resolver());
      checkLines(built.type, built.lines, accountOf);
      const event = {
        id: uuidv7(),
        type: built.type,
        status: 'posted',
        date: input.date,
        lines: built.lines,
        operationId,
        refundOf: built.refundOf,
      };
      events.push(event);
      return { event, duplicate: false };
    },
    async reverse(id, operationId) {
      const orig = events.find((e) => e.id === id);
      if (!orig || orig.status !== 'posted' || orig.type === 'reversal') throw new Error('not reversible');
      orig.status = 'reversed';
      const lines = buildReversal(orig.lines);
      checkLines('reversal', lines, accountOf);
      const event = { id: uuidv7(), type: 'reversal' as const, status: 'posted', date: orig.date, lines, operationId };
      events.push(event);
      return event;
    },
    async correct(id, input, operationId) {
      const reversal = await engine.reverse(id, `${operationId}:reversal`);
      const { event } = await engine.post(input, operationId);
      return { reversal, event };
    },
    async events() {
      return events;
    },
  };
  return engine;
}

import type { z } from 'zod';
import type { RecurrenceRule, ScheduleEnd } from './schedules.contract.js';

type Rule = z.output<typeof RecurrenceRule>;
type End = z.output<typeof ScheduleEnd>;

const pad = (n: number) => String(n).padStart(2, '0');

export function parseLocalDate(s: string): { y: number; m: number; d: number } {
  const [ys, ms, ds] = s.split('-');
  return { y: Number(ys), m: Number(ms), d: Number(ds) };
}

export function formatLocalDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** TECH-SPEC 6.4: 29–31 and "last day" clamp to the month's last calendar day. */
export function dayInMonth(y: number, m: number, dayOfMonth: number | null): number {
  const last = daysInMonth(y, m);
  if (dayOfMonth === 0 || dayOfMonth === null) return last;
  return Math.min(dayOfMonth, last);
}

function addDays(y: number, m: number, d: number, days: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return formatLocalDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function addMonths(y: number, m: number, count: number): { y: number; m: number } {
  let nm = m + count;
  let ny = y;
  while (nm > 12) {
    nm -= 12;
    ny += 1;
  }
  while (nm < 1) {
    nm += 12;
    ny -= 1;
  }
  return { y: ny, m: nm };
}

export function compareDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function monthOccurrence(y: number, m: number, rule: Rule): string {
  const dom = rule.unit === 'year' ? dayInMonth(y, m, rule.dayOfMonth) : dayInMonth(y, m, rule.dayOfMonth);
  return formatLocalDate(y, m, dom);
}

/** Advance one step in the recurrence from `date`. */
export function advanceDate(date: string, rule: Rule): string {
  const p = parseLocalDate(date);
  if (rule.unit === 'day') return addDays(p.y, p.m, p.d, rule.every);
  if (rule.unit === 'week') return addDays(p.y, p.m, p.d, rule.every * 7);
  if (rule.unit === 'month') {
    const { y, m } = addMonths(p.y, p.m, rule.every);
    return monthOccurrence(y, m, rule);
  }
  const ny = p.y + rule.every;
  return monthOccurrence(ny, p.m, rule);
}

function firstScheduledOnOrAfter(startDate: string, rule: Rule): string {
  if (rule.unit === 'month' || rule.unit === 'year') {
    let { y, m } = parseLocalDate(startDate);
    for (let i = 0; i < 240; i++) {
      const c = monthOccurrence(y, m, rule);
      if (compareDate(c, startDate) >= 0) return c;
      if (rule.unit === 'month') ({ y, m } = addMonths(y, m, rule.every));
      else y += rule.every;
    }
  }
  return startDate;
}

/** First date on or after `notBefore` that matches the schedule. */
export function nextOccurrenceOnOrAfter(notBefore: string, startDate: string, rule: Rule, end: End): string | null {
  let d = firstScheduledOnOrAfter(startDate, rule);
  let seen = 0;
  for (let i = 0; i < 500; i++) {
    if (compareDate(d, notBefore) >= 0) {
      if (end.kind === 'on' && compareDate(d, end.date) > 0) return null;
      if (end.kind === 'after' && seen >= end.count) return null;
      return d;
    }
    seen += 1;
    if (end.kind === 'after' && seen >= end.count) return null;
    d = advanceDate(d, rule);
    if (end.kind === 'on' && compareDate(d, end.date) > 0) return null;
  }
  return null;
}

/** All occurrence dates for `month` (YYYY-MM). */
export function occurrencesInMonth(startDate: string, rule: Rule, end: End, month: string): string[] {
  const { y, m } = parseLocalDate(`${month}-01`);
  const monthStart = `${month}-01`;
  const monthEnd = formatLocalDate(y, m, daysInMonth(y, m));
  const out: string[] = [];
  let d = firstScheduledOnOrAfter(startDate, rule);
  let seen = 0;
  for (let i = 0; i < 500; i++) {
    if (compareDate(d, monthEnd) > 0) break;
    if (end.kind === 'on' && compareDate(d, end.date) > 0) break;
    if (end.kind === 'after' && seen >= end.count) break;
    if (compareDate(d, monthStart) >= 0) {
      out.push(d);
      seen += 1;
    }
    d = advanceDate(d, rule);
  }
  return out;
}

export function firstNextDate(startDate: string, rule: Rule, end: End, today: string): string | null {
  return nextOccurrenceOnOrAfter(today, startDate, rule, end);
}

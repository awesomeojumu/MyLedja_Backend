import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import type { AppConfig } from '../../config/config.schema.js';
import { AppError, Errors } from '../../common/errors/errors.js';
import { newId } from '../../common/ids/ids.js';
import { MoneyError, parseMajor, toMinorString } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { Database } from '../../db/client.js';
import type { AccountsService } from '../accounts/accounts.service.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { CategoriesRepository } from '../categories/categories.repository.js';
import type { EventInput } from '../ledger/ledger.inputs.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { ColumnMapping, Import, ImportRow } from './imports.contract.js';
import { DATE_FORMATS } from './imports.contract.js';
import type { ImportDoc, ImportsRepository } from './imports.repository.js';

type Mapping = z.output<typeof ColumnMapping>;
type Row = z.output<typeof ImportRow>;

export const ImportErrors = {
  notMappable: () => new AppError(409, 'not_mappable', 'This import is already posted or undone.'),
  notPostable: () => new AppError(409, 'not_postable', 'Map the columns before posting, or undo first.'),
  notUndoable: () => new AppError(409, 'not_undoable', 'Only a posted import can be undone.'),
  nothingToPost: () => new AppError(400, 'nothing_to_post', 'Tick at least one row without an error to post.'),
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** CSV statement import (build plan B1.12, DESIGN.md page 9). */
export class ImportsService {
  constructor(
    private readonly database: Database,
    private readonly repos: ImportsRepository,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly categories: CategoriesRepository,
    private readonly audit: AuditRepository,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upload(
    ctx: WorkspaceContext,
    body: { id?: string; accountId: string; fileName: string; content: string },
  ): Promise<z.input<typeof Import>> {
    const account = await this.accounts.real(ctx, body.accountId);
    const grid = parseCsv(body.content);
    if (grid.length === 0) throw Errors.validation('content', 'This file is empty');
    const preview = grid.slice(0, 10);
    const suggested = suggestMapping(preview, account.importMapping as Mapping | null | undefined);
    const stored = await this.tryStore(body.fileName, body.content);
    const doc = await this.database.transaction(async (session) => {
      if (body.id) {
        const same = await this.repos.byId(ctx, body.id, { session });
        if (same) return same;
      }
      const now = this.now();
      const created = await this.repos.insertOne(
        ctx,
        {
          _id: body.id ?? newId(),
          accountId: body.accountId,
          fileName: body.fileName,
          content: body.content,
          status: 'uploaded',
          preview,
          mapping: suggested,
          rows: [],
          counts: emptyCounts(),
          stored,
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        { session },
      );
      await this.ledger.feed(ctx, [{ collection: 'imports', docId: created._id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        { action: 'import.uploaded', target: { collection: 'imports', id: created._id } },
        { session },
      );
      return created;
    });
    return this.view(doc);
  }

  async get(ctx: WorkspaceContext, id: string) {
    return this.view(await this.require(ctx, id));
  }

  async map(ctx: WorkspaceContext, id: string, mapping: Mapping): Promise<z.input<typeof Import>> {
    validateMapping(mapping);
    const doc = await this.database.transaction(async (session) => {
      const before = await this.require(ctx, id, session);
      if (before.status === 'posted' || before.status === 'undone') throw ImportErrors.notMappable();
      const account = await this.accounts.real(ctx, before.accountId, session);
      const grid = parseCsv(before.content);
      const dataRows = mapping.hasHeader ? grid.slice(1) : grid;
      const existing = await this.accountEvents(ctx, before.accountId, session);
      const rows = dataRows.map((cells, index) => parseRow(index, cells, mapping, existing));
      await this.accounts.saveImportMapping(ctx, before.accountId, mapping, session);
      const after = await this.repos.findOneAndUpdate(
        ctx,
        { _id: id, version: before.version },
        {
          $set: {
            status: 'mapped',
            mapping,
            rows,
            counts: countOf(rows),
            preview: grid.slice(0, 10),
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw ImportErrors.notMappable();
      await this.ledger.feed(ctx, [{ collection: 'imports', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        {
          action: 'import.mapped',
          target: { collection: 'imports', id },
          after: { accountId: account._id, counts: after.counts },
        },
        { session },
      );
      return after;
    });
    return this.view(doc);
  }

  async post(
    ctx: WorkspaceContext,
    id: string,
    body: { rows: { index: number; include: boolean; categoryId?: string | null }[] },
    operationId: string,
  ): Promise<z.input<typeof Import>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.require(ctx, id, session);
      if (before.status !== 'mapped') throw ImportErrors.notPostable();
      const overrides = new Map(body.rows.map((r) => [r.index, r]));
      const rows: Row[] = before.rows.map((r) => {
        const o = overrides.get(r.index);
        if (!o) return { ...r };
        return {
          ...r,
          include: o.include,
          categoryId: o.categoryId !== undefined ? o.categoryId : r.categoryId,
        };
      });
      const toPost = rows.filter((r) => r.include && r.error === null);
      if (toPost.length === 0) throw ImportErrors.nothingToPost();

      const unc = await this.categories.byStarterKey(ctx, 'uncategorized', { session });
      const otherIncome = await this.categories.byStarterKey(ctx, 'other_income', { session });
      if (!unc || !otherIncome) throw Errors.notFound();

      for (const row of toPost) {
        const amount = BigInt(row.amount!);
        const abs = amount < 0n ? -amount : amount;
        const categoryId = row.categoryId ?? (amount > 0n ? otherIncome._id : unc._id);
        const input: EventInput =
          amount > 0n
            ? {
                type: 'income',
                accountId: before.accountId,
                categoryId,
                amount: toMinorString(abs),
                date: row.date!,
                notes: notesOf(row),
              }
            : {
                type: 'expense',
                accountId: before.accountId,
                categoryId,
                amount: toMinorString(abs),
                date: row.date!,
                notes: notesOf(row),
              };
        const event = await this.ledger.postIn(
          ctx,
          input,
          { operationId: `${operationId}:${row.index}`, importId: before._id },
          session,
        );
        const i = rows.findIndex((r) => r.index === row.index);
        rows[i] = { ...rows[i]!, transactionId: event._id, categoryId, include: true, error: null };
      }

      const after = await this.repos.findOneAndUpdate(
        ctx,
        { _id: id, version: before.version },
        {
          $set: {
            status: 'posted',
            rows,
            counts: countOf(rows),
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw ImportErrors.notPostable();
      await this.ledger.feed(ctx, [{ collection: 'imports', docId: id, op: 'upsert' }], session);
      await this.audit.record(
        ctx,
        {
          action: 'import.posted',
          target: { collection: 'imports', id },
          after: { posted: after.counts.posted },
        },
        { session },
      );
      return after;
    });
    return this.view(doc);
  }

  async undo(ctx: WorkspaceContext, id: string, operationId: string): Promise<z.input<typeof Import>> {
    const doc = await this.database.transaction(async (session) => {
      const before = await this.require(ctx, id, session);
      if (before.status !== 'posted') throw ImportErrors.notUndoable();
      const rows: Row[] = before.rows.map((r) => ({ ...r }));
      for (const row of rows) {
        if (!row.transactionId) continue;
        await this.ledger.reverseIn(
          ctx,
          row.transactionId,
          { operationId: `${operationId}:undo:${row.index}`, importId: before._id },
          session,
        );
        const i = rows.findIndex((r) => r.index === row.index);
        rows[i] = { ...rows[i]!, transactionId: null, include: false };
      }
      const after = await this.repos.findOneAndUpdate(
        ctx,
        { _id: id, version: before.version },
        {
          $set: {
            status: 'undone',
            rows,
            counts: countOf(rows),
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!after) throw ImportErrors.notUndoable();
      await this.ledger.feed(ctx, [{ collection: 'imports', docId: id, op: 'upsert' }], session);
      await this.audit.record(ctx, { action: 'import.undone', target: { collection: 'imports', id } }, { session });
      return after;
    });
    return this.view(doc);
  }

  private async require(ctx: WorkspaceContext, id: string, session?: ClientSession) {
    const doc = await this.repos.byId(ctx, id, { session });
    if (!doc) throw Errors.notFound();
    return doc;
  }

  private view(doc: ImportDoc): z.input<typeof Import> {
    return {
      id: doc._id,
      accountId: doc.accountId,
      fileName: doc.fileName,
      status: doc.status,
      preview: doc.preview,
      mapping: doc.mapping,
      rows: doc.rows,
      counts: doc.counts,
      stored: doc.stored,
      version: doc.version,
    };
  }

  /** Existing live movements on the account, for duplicate checks. */
  private async accountEvents(ctx: WorkspaceContext, accountId: string, session?: ClientSession) {
    const docs = await this.ledger.transactions.find(
      ctx,
      {
        status: 'posted',
        type: { $in: ['income', 'expense', 'refund', 'opening_balance', 'balance_adjustment'] },
        'lines.ledgerAccountId': accountId,
      } as never,
      { session },
    );
    const account = await this.accounts.real(ctx, accountId, session);
    const out: ExistingEvent[] = [];
    for (const d of docs) {
      const line = d.lines.find((l) => l.ledgerAccountId === accountId);
      if (!line) continue;
      const shown = account.kind === 'liability' ? -line.amountMinor : line.amountMinor;
      out.push({
        id: d._id,
        date: d.date,
        amount: shown,
        description: normalize(d.notes ?? ''),
      });
    }
    return out;
  }

  /** Stub / no-op Cloudinary upload: mark stored when config has Cloudinary. */
  private async tryStore(_fileName: string, _content: string): Promise<boolean> {
    if (!this.config.cloudinary) return false;
    // Phase 1: no real Cloudinary SDK call; presence of config is enough for `stored: true`.
    await Promise.resolve();
    return true;
  }
}

type ExistingEvent = { id: string; date: string; amount: bigint; description: string };

function emptyCounts() {
  return { rows: 0, new: 0, duplicates: 0, errors: 0, posted: 0 };
}

function countOf(rows: Row[]) {
  return {
    rows: rows.length,
    new: rows.filter((r) => !r.error && !r.duplicateOf).length,
    duplicates: rows.filter((r) => r.duplicateOf !== null).length,
    errors: rows.filter((r) => r.error !== null).length,
    posted: rows.filter((r) => r.transactionId !== null).length,
  };
}

function notesOf(row: Row): string | null {
  const parts = [row.description, row.notes].map((s) => s?.trim()).filter((s): s is string => !!s);
  return parts.length ? parts.join(' — ') : null;
}

function validateMapping(m: Mapping) {
  const hasAmount = m.amount !== null;
  const hasSplit = m.moneyIn !== null || m.moneyOut !== null;
  if (hasAmount === hasSplit) {
    throw Errors.validation(
      'mapping.amount',
      'Map one Amount column, or Money in and Money out — not both, and not neither.',
    );
  }
  if (!hasAmount && (m.moneyIn === null || m.moneyOut === null)) {
    throw Errors.validation('mapping.moneyIn', 'Map both Money in and Money out.');
  }
}

/** Simple RFC4180-ish CSV: split lines, handle quoted fields with commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, '');
  while (i < s.length) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0) || row.length > 1) rows.push(row);
      row = [];
      if (c === '\r' && s[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0) || row.length > 1) rows.push(row);
  }
  return rows;
}

export function suggestMapping(preview: string[][], saved: Mapping | null | undefined): Mapping | null {
  if (saved && isMapping(saved)) return saved;
  if (preview.length === 0) return null;
  const header = preview[0]!.map((h) => h.trim().toLowerCase());
  const hasHeader = header.some((h) =>
    /date|amount|description|payee|memo|narration|money\s*in|money\s*out|credit|debit|details|notes/.test(h),
  );
  if (!hasHeader) {
    return {
      date: 0,
      amount: 1,
      moneyIn: null,
      moneyOut: null,
      description: Math.min(2, (preview[0]?.length ?? 1) - 1),
      payee: null,
      notes: null,
      dateFormat: 'YYYY-MM-DD',
      hasHeader: false,
    };
  }
  const find = (...needles: RegExp[]) => {
    const i = header.findIndex((h) => needles.some((n) => n.test(h)));
    return i >= 0 ? i : null;
  };
  const date = find(/^date$/, /trans.*date/, /value\s*date/, /posted/) ?? 0;
  const amount = find(/^amount$/, /^amt$/, /transaction\s*amount/);
  const moneyIn = find(/money\s*in/, /^credit$/, /^cr$/, /deposit/);
  const moneyOut = find(/money\s*out/, /^debit$/, /^dr$/, /withdrawal/);
  const description =
    find(/^description$/, /^narration$/, /^details$/, /^memo$/, /^particulars$/) ?? Math.min(header.length - 1, 2);
  const payee = find(/^payee$/, /^beneficiary$/, /^counterparty$/);
  const notes = find(/^notes$/, /^memo$/, /^reference$/);
  const dateFormat = guessDateFormat(
    preview.slice(1).map((r) => r[date] ?? ''),
    'YYYY-MM-DD',
  );
  if (amount !== null) {
    return {
      date,
      amount,
      moneyIn: null,
      moneyOut: null,
      description,
      payee,
      notes: notes === description ? null : notes,
      dateFormat,
      hasHeader: true,
    };
  }
  return {
    date,
    amount: null,
    moneyIn: moneyIn ?? null,
    moneyOut: moneyOut ?? null,
    description,
    payee,
    notes: notes === description ? null : notes,
    dateFormat,
    hasHeader: true,
  };
}

function isMapping(v: unknown): v is Mapping {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.date === 'number' &&
    typeof m.description === 'number' &&
    typeof m.hasHeader === 'boolean' &&
    typeof m.dateFormat === 'string' &&
    (DATE_FORMATS as readonly string[]).includes(m.dateFormat)
  );
}

function guessDateFormat(samples: string[], fallback: Mapping['dateFormat']): Mapping['dateFormat'] {
  for (const raw of samples) {
    const s = raw.trim();
    if (!s) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'YYYY-MM-DD';
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
      const [a, b] = s.split('/').map(Number);
      if (a! > 12) return 'DD/MM/YYYY';
      if (b! > 12) return 'MM/DD/YYYY';
      return 'DD/MM/YYYY';
    }
    if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(s)) return 'DD-MM-YYYY';
    if (/^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/.test(s)) return 'DD MMM YYYY';
  }
  return fallback;
}

function parseRow(index: number, cells: string[], mapping: Mapping, existing: ExistingEvent[]): Row {
  const cell = (i: number | null) => (i === null || i < 0 || i >= cells.length ? '' : cells[i]!.trim());
  let error: string | null = null;
  let date: string | null = null;
  let amount: string | null = null;
  const description = cell(mapping.description);
  const payeeName = mapping.payee !== null ? cell(mapping.payee) || null : null;
  const notes = mapping.notes !== null ? cell(mapping.notes) || null : null;

  try {
    date = parseDate(cell(mapping.date), mapping.dateFormat);
  } catch {
    error = 'Check the date';
  }

  try {
    const minor = parseAmount(cells, mapping);
    if (minor === 0n) error = error ?? 'Enter an amount other than ₦0.00';
    else amount = toMinorString(minor);
  } catch {
    error = error ?? 'Check the amount';
  }

  let duplicateOf: string | null = null;
  let include = true;
  if (!error && date && amount !== null) {
    const desc = normalize(description);
    const amt = BigInt(amount);
    for (const e of existing) {
      if (e.amount !== amt) continue;
      if (daysApart(e.date, date) > 3) continue;
      if (!similar(desc, e.description)) continue;
      duplicateOf = e.id;
      include = false;
      break;
    }
  }
  if (error) include = false;

  return {
    index,
    date,
    amount,
    description,
    payeeName,
    notes,
    categoryId: null,
    duplicateOf,
    include,
    error,
    transactionId: null,
  };
}

function parseAmount(cells: string[], mapping: Mapping): bigint {
  const cell = (i: number | null) => (i === null || i < 0 || i >= cells.length ? '' : cells[i]!.trim());
  if (mapping.amount !== null) {
    const raw = cell(mapping.amount);
    if (!raw) throw new MoneyError('amount_unreadable');
    return parseLooseAmount(raw);
  }
  const inn = cell(mapping.moneyIn);
  const out = cell(mapping.moneyOut);
  const inAmt = inn ? parseLooseAmount(inn) : 0n;
  const outAmt = out ? parseLooseAmount(out) : 0n;
  if (inAmt !== 0n && outAmt !== 0n) throw new MoneyError('amount_unreadable');
  if (inAmt !== 0n) return inAmt < 0n ? -inAmt : inAmt;
  if (outAmt !== 0n) return outAmt > 0n ? -outAmt : outAmt;
  throw new MoneyError('amount_unreadable');
}

/** Accepts major-unit bank figures ("1,500.00", "-25000", "DR 1500") into signed minor units. */
function parseLooseAmount(raw: string): bigint {
  let s = raw.trim().replace(/^₦/, '').replace(/\s/g, '');
  let sign = 1n;
  if (/^(dr|debit)/i.test(s)) {
    sign = -1n;
    s = s.replace(/^(dr|debit)[:\s-]*/i, '');
  } else if (/^(cr|credit)/i.test(s)) {
    s = s.replace(/^(cr|credit)[:\s-]*/i, '');
  }
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1n;
    s = s.slice(1, -1);
  }
  const parsed = parseMajor(s);
  return sign * parsed;
}

export function parseDate(raw: string, format: Mapping['dateFormat']): string {
  const s = raw.trim();
  if (!s) throw new Error('empty');
  let y: number;
  let m: number;
  let d: number;
  if (format === 'YYYY-MM-DD') {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!match) throw new Error('bad');
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else if (format === 'DD/MM/YYYY' || format === 'MM/DD/YYYY') {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!match) throw new Error('bad');
    if (format === 'DD/MM/YYYY') {
      d = Number(match[1]);
      m = Number(match[2]);
    } else {
      m = Number(match[1]);
      d = Number(match[2]);
    }
    y = Number(match[3]);
  } else if (format === 'DD-MM-YYYY') {
    const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
    if (!match) throw new Error('bad');
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
  } else {
    const match = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/.exec(s);
    if (!match) throw new Error('bad');
    d = Number(match[1]);
    m = MONTHS[match[2]!.toLowerCase()] ?? 0;
    y = Number(match[3]);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error('bad');
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || !check.toISOString().startsWith(iso)) throw new Error('bad');
  return iso;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function similar(a: string, b: string): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function daysApart(a: string, b: string) {
  return Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000);
}

import { getDocumentProxy } from 'unpdf';
import { readSheet } from 'read-excel-file/node';

/** Reading bank statements without AI (build plan B4.3): PDF text lines and Excel grids into dated, signed rows. */

export type ParsedRow = { date: string; description: string; amountMinor: bigint };

/** The banks MyLedja knows by name; detection only labels the import, the reading below is the same for all. */
export const BANKS: { key: string; name: string; pattern: RegExp }[] = [
  { key: 'gtbank', name: 'GTBank', pattern: /guaranty\s+trust|\bgtbank\b|\bgtco\b/i },
  { key: 'access', name: 'Access Bank', pattern: /access\s+bank/i },
  { key: 'zenith', name: 'Zenith Bank', pattern: /zenith\s+bank/i },
  { key: 'uba', name: 'UBA', pattern: /united\s+bank\s+for\s+africa|\buba\b/i },
  { key: 'kuda', name: 'Kuda', pattern: /\bkuda\b/i },
  { key: 'premiumtrust', name: 'PremiumTrust Bank', pattern: /premium\s*trust/i },
  { key: 'bank78', name: 'Bank78', pattern: /bank\s*78/i },
];

export function detectBank(text: string): string | null {
  return BANKS.find((b) => b.pattern.test(text))?.key ?? null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Nigerian statements put the day first: 05/10/2026, 05-10-26, 05-Oct-2026, 5 Oct 2026, or 2026-10-05. */
export function parseStatementDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})/.exec(s)))
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[/\-. ]([A-Za-z]{3,9})[/\-., ]+(\d{2,4})/.exec(s))) {
    d = Number(match[1]);
    m = MONTHS[match[2]!.slice(0, 3).toLowerCase()] ?? 0;
    y = Number(match[3]);
  } else return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1,234.56" or "(1,234.56)" or "-1234.56" into kobo; null when it isn't an amount. */
export function parseMoney(raw: string): bigint | null {
  const s = raw.trim().replace(/[₦NGN\s]/g, '');
  const match = /^(\()?(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\))?(CR|DR)?$/i.exec(s);
  if (!match) return null;
  const minor = BigInt(match[3]!.replace(/,/g, '')) * 100n + BigInt((match[4] ?? '0').padEnd(2, '0'));
  const negative = !!match[2] || (!!match[1] && !!match[5]) || match[6]?.toUpperCase() === 'DR';
  return negative ? -minor : minor;
}

const AMOUNT = /\(?-?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:CR|DR))?/gi;

/**
 * Text lines from a statement: each line that starts with a date and ends with a running balance is a
 * transaction. Money in or out comes from how the balance moved, which works whatever the bank's column order.
 */
export function rowsFromText(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  let lastBalance: bigint | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (/opening\s+balance|balance\s+b\/?f|brought\s+forward/i.test(line)) {
      const amounts = line.match(AMOUNT);
      const v = amounts ? parseMoney(amounts[amounts.length - 1]!) : null;
      if (v !== null) lastBalance = v;
      continue;
    }
    const date = parseStatementDate(line);
    if (!date) continue;
    const amounts = [...line.matchAll(AMOUNT)];
    if (amounts.length < 2) continue;
    const balance = parseMoney(amounts[amounts.length - 1]![0]);
    const moved = parseMoney(amounts[amounts.length - 2]![0]);
    if (balance === null || moved === null) continue;
    const first = amounts[0]!.index ?? line.length;
    // The description sits between the date(s) and the first amount.
    const description = line
      .slice(0, first)
      .replace(/^\S+(\s+\d{1,2}[/\-. ]\S+[/\-. ]\d{2,4})?/, '')
      .trim();
    let amountMinor: bigint;
    if (lastBalance !== null) amountMinor = balance - lastBalance;
    else
      amountMinor = /\bcr\b|credit|deposit|transfer from|inflow/i.test(line)
        ? moved < 0n
          ? -moved
          : moved
        : -(moved < 0n ? -moved : moved);
    lastBalance = balance;
    if (amountMinor === 0n) continue;
    rows.push({ date, description: description || line.slice(0, 120), amountMinor });
  }
  return rows;
}

/** Text from a PDF, rebuilt line by line from the position of each piece of text. */
export async function pdfText(content: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(content));
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const items = (await page.getTextContent()).items as { str?: string; transform?: number[] }[];
    const lines = new Map<number, { x: number; s: string }[]>();
    for (const it of items) {
      if (!it.str?.trim() || !it.transform) continue;
      const y = Math.round(it.transform[5]! / 2) * 2;
      const x = it.transform[4]!;
      lines.set(y, [...(lines.get(y) ?? []), { x, s: it.str }]);
    }
    const sorted = [...lines.entries()].sort((a, b) => b[0] - a[0]);
    pages.push(
      sorted
        .map(([, parts]) =>
          parts
            .sort((a, b) => a.x - b.x)
            .map((q) => q.s)
            .join(' '),
        )
        .join('\n'),
    );
  }
  return pages.join('\n');
}

export async function excelGrid(content: Buffer): Promise<string[][]> {
  const rows = await readSheet(content);
  return rows.map((r) =>
    r.map((c: unknown) =>
      c instanceof Date ? c.toISOString().slice(0, 10) : c === null || c === undefined ? '' : String(c),
    ),
  );
}

const HEADERS = {
  date: /^(trans(action)?\.?\s*date|date|posted\s*date|date\s*posted|tran\s*date|date\s*\/\s*time|txn\s*date)$/i,
  description: /(description|narration|remarks|details|particulars|to\s*\/\s*from|transaction\s*details)/i,
  debit: /^(debit|debits|withdrawal|withdrawals|money\s*out|dr|debit\s*amount|outflow)s?$/i,
  credit: /^(credit|credits|lodgement|lodgements|deposit|deposits|money\s*in|cr|credit\s*amount|inflow)s?$/i,
  amount: /^(amount|amount\s*\(ngn\)|transaction\s*amount)$/i,
};

/** An Excel or CSV grid: finds the header row by its column names, then reads each row below it. */
export function rowsFromGrid(grid: string[][]): ParsedRow[] {
  const headerAt = grid.findIndex(
    (r) =>
      r.some((c) => HEADERS.date.test(c.trim())) &&
      r.some((c) => HEADERS.debit.test(c.trim()) || HEADERS.amount.test(c.trim())),
  );
  if (headerAt < 0) return rowsFromText(grid.map((r) => r.join(' ')).join('\n'));
  const head = grid[headerAt]!.map((c) => c.trim());
  const col = (re: RegExp) => head.findIndex((c) => re.test(c));
  const date = col(HEADERS.date);
  const desc = col(HEADERS.description);
  const debit = col(HEADERS.debit);
  const credit = col(HEADERS.credit);
  const amount = col(HEADERS.amount);
  const rows: ParsedRow[] = [];
  for (const r of grid.slice(headerAt + 1)) {
    const d = parseStatementDate(r[date] ?? '');
    if (!d) continue;
    let minor: bigint | null = null;
    if (debit >= 0 || credit >= 0) {
      const out = debit >= 0 ? parseMoney(r[debit] ?? '') : null;
      const inn = credit >= 0 ? parseMoney(r[credit] ?? '') : null;
      if (inn && inn !== 0n) minor = inn < 0n ? -inn : inn;
      else if (out && out !== 0n) minor = -(out < 0n ? -out : out);
    } else if (amount >= 0) minor = parseMoney(r[amount] ?? '');
    if (minor === null || minor === 0n) continue;
    rows.push({ date: d, description: (desc >= 0 ? r[desc] : '')?.trim() || 'Transaction', amountMinor: minor });
  }
  return rows;
}

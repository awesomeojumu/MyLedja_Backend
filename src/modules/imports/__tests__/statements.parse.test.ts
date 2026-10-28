import { describe, expect, it } from 'vitest';
import { detectBank, parseMoney, parseStatementDate, rowsFromGrid, rowsFromText } from '../statements/parse.js';

// Layouts written from the banks' published statement formats (B4.3). Replace with real samples when the owner has them.
const sum = (rows: { amountMinor: bigint }[]) => rows.reduce((s, r) => s + r.amountMinor, 0n);

describe('statement parsing (B4.3)', () => {
  it('reads dates day first, in each bank style', () => {
    expect(parseStatementDate('05-Oct-2026')).toBe('2026-10-05');
    expect(parseStatementDate('05/10/2026')).toBe('2026-10-05');
    expect(parseStatementDate('5 Oct 2026')).toBe('2026-10-05');
    expect(parseStatementDate('05-10-26')).toBe('2026-10-05');
    expect(parseStatementDate('2026-10-05')).toBe('2026-10-05');
    expect(parseStatementDate('Opening')).toBeNull();
  });

  it('reads amounts exactly, with debit markers', () => {
    expect(parseMoney('1,234.56')).toBe(123_456n);
    expect(parseMoney('(1,234.56)')).toBe(-123_456n);
    expect(parseMoney('500.00DR')).toBe(-50_000n);
    expect(parseMoney('abc')).toBeNull();
  });

  it('GTBank PDF text: money in or out from the running balance', () => {
    const text = `Guaranty Trust Bank
Opening Balance 812,300.00
05-Oct-2026 05-Oct-2026 POS SHOPRITE LEKKI 18,450.00 793,850.00
06-Oct-2026 06-Oct-2026 SALARY OCTOBER 640,000.00 1,433,850.00`;
    expect(detectBank(text)).toBe('gtbank');
    const rows = rowsFromText(text);
    expect(rows.map((r) => r.amountMinor)).toEqual([-1_845_000n, 64_000_000n]);
    expect(sum(rows)).toBe(143_385_000n - 81_230_000n);
  });

  it('Access Bank PDF text', () => {
    const text = `Access Bank Plc
Balance B/F 100,000.00
01/10/2026 01/10/2026 AIRTIME MTN 2,000.00 98,000.00
03/10/2026 03/10/2026 TRF FROM TUNDE 42,000.00 140,000.00`;
    expect(detectBank(text)).toBe('access');
    expect(rowsFromText(text).map((r) => r.amountMinor)).toEqual([-200_000n, 4_200_000n]);
  });

  it('Zenith Bank Excel grid', () => {
    const grid = [
      ['Zenith Bank Plc'],
      ['DATE POSTED', 'VALUE DATE', 'DESCRIPTION', 'DEBIT', 'CREDIT', 'BALANCE'],
      ['02/10/2026', '02/10/2026', 'DSTV SUBSCRIPTION', '24,500.00', '', '475,500.00'],
      ['04/10/2026', '04/10/2026', 'INWARD TRANSFER', '', '150,000.00', '625,500.00'],
    ];
    expect(detectBank(grid.flat().join(' '))).toBe('zenith');
    expect(rowsFromGrid(grid).map((r) => [r.description, r.amountMinor])).toEqual([
      ['DSTV SUBSCRIPTION', -2_450_000n],
      ['INWARD TRANSFER', 15_000_000n],
    ]);
  });

  it('UBA Excel grid with a narration column', () => {
    const grid = [
      ['United Bank for Africa'],
      ['Tran Date', 'Value Date', 'Narration', 'Chq. No', 'Debit', 'Credit', 'Balance'],
      ['10-Oct-2026', '10-Oct-2026', 'EKEDC PREPAID', '', '15,000.00', '', '85,000.00'],
    ];
    expect(detectBank(grid.flat().join(' '))).toBe('uba');
    expect(rowsFromGrid(grid)).toEqual([
      { date: '2026-10-10', description: 'EKEDC PREPAID', amountMinor: -1_500_000n },
    ]);
  });

  it('Kuda Excel grid with Money In and Money out', () => {
    const grid = [
      ['Kuda MFB'],
      ['Date/Time', 'Money In', 'Money out', 'Category', 'To / From', 'Description', 'Balance'],
      ['2026-10-12', '', '3,500.00', 'Transport', 'BOLT', 'Ride', '50,000.00'],
      ['2026-10-13', '20,000.00', '', 'Transfer', 'MUM', 'Gift', '70,000.00'],
    ];
    expect(detectBank(grid.flat().join(' '))).toBe('kuda');
    expect(rowsFromGrid(grid).map((r) => r.amountMinor)).toEqual([-350_000n, 2_000_000n]);
  });
});

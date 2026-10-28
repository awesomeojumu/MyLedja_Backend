import { describe, expect, it } from 'vitest';
import { redact, transactionLines } from '../redact.js';

// A real-looking statement page (build plan B4.2): none of the personal values may reach an AI provider.
const STATEMENT = `GUARANTY TRUST BANK PLC
Customer Statement
Account Name: ADAEZE OKONKWO
Account Number: 0123456789
BVN: 22123456789
Address: 14 Admiralty Way, Lekki Phase 1, Lagos
Phone: +234 803 123 4567 / 08031234567
Email: ada.okonkwo@example.com
Card: 5399 8312 3456 7890
Opening Balance 812,300.00
05-Oct-2026 05-Oct-2026 POS SHOPRITE LEKKI 18,450.00 793,850.00
06-Oct-2026 06-Oct-2026 TRANSFER FROM ADAEZE OKONKWO 0123456789 640,000.00 1,433,850.00
07-Oct-2026 07-Oct-2026 NIP TRF TO OPAY 8031234567 REF 012****789 50,000.00 1,383,850.00`;

describe('redact (B4.2)', () => {
  const out = redact(STATEMENT, ['Adaeze Okonkwo']);
  const sent = transactionLines(out).join('\n');

  it.each([
    ['account number', '0123456789'],
    ['BVN', '22123456789'],
    ['street address', 'Admiralty Way'],
    ['phone', '803 123 4567'],
    ['phone', '08031234567'],
    ['email', 'ada.okonkwo@example.com'],
    ['card number', '5399 8312 3456 7890'],
    ['masked account number', '012****789'],
    ['holder name', 'ADAEZE'],
    ['holder name', 'OKONKWO'],
  ])('removes the %s', (_kind, value) => {
    expect(out).not.toContain(value);
    expect(sent).not.toContain(value);
  });

  it('keeps dates and amounts, and sends only transaction lines', () => {
    const lines = transactionLines(out);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('18,450.00');
    expect(lines[1]).toContain('640,000.00');
    expect(sent).not.toContain('Customer Statement');
    expect(sent).not.toContain('Opening Balance');
  });
});

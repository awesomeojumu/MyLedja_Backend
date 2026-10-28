/**
 * Removes what must never reach an AI provider before a statement is read (TECH-SPEC 5.8, build plan B4.2):
 * account numbers, BVN, card numbers, phone numbers, email and street addresses, and the holder's name.
 * Amounts and dates stay, because they're what's being read.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Card numbers: four groups of four (the last may be longer), or 13 to 19 digits run together; never part of an amount.
const CARD = /\b(?:\d{4}[ -]){3}\d{1,7}\b(?![.,]\d)|\b\d{13,19}\b(?![.,]\d)/g;
// Nigerian phone numbers: +234 or 0, then 7, 8 or 9, then 9 more digits, with or without spaces.
const PHONE = /(?:\+?234[\s-]?|\b0)[789][01]\d(?:[\s-]?\d){7}\b/g;
// NUBAN account numbers (10 digits) and BVN (11 digits), standing alone.
const LONG_NUMBER = /\b\d{10,12}\b/g;
// A masked account number such as 012****789 still identifies the account.
const MASKED = /\b\d{2,4}[*xX]{3,}\d{2,4}\b/g;
const STREET =
  /\b\d{1,5}[A-Za-z]?,?\s+(?:[A-Za-z']+\s){0,4}(?:street|st\.?|road|rd\.?|avenue|ave\.?|close|crescent|lane|way|drive|estate|boulevard|blvd)\b[^\n]*/gi;

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(text: string, holderNames: string[] = []): string {
  let out = text.replace(EMAIL, '[email]').replace(STREET, '[address]').replace(MASKED, '[account]');
  out = out.replace(CARD, '[card]');
  out = out.replace(PHONE, '[phone]').replace(LONG_NUMBER, '[number]');
  for (const name of holderNames) {
    const parts = name.split(/\s+/).filter((p) => p.length >= 3);
    for (const p of [name, ...parts])
      if (p.trim()) out = out.replace(new RegExp(`\\b${escape(p.trim())}\\b`, 'gi'), '[name]');
  }
  return out;
}

const DATE_START = /^\s*(\d{1,2}[/\-. ](?:\d{1,2}|[A-Za-z]{3,9})[/\-. ]\d{2,4}|\d{4}-\d{2}-\d{2})/;

/** Only the lines that look like transactions (start with a date) are ever sent. */
export function transactionLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => DATE_START.test(l) && /\d[\d,]*\.\d{2}/.test(l));
}

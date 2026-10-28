/**
 * Money is whole minor units (kobo for naira) as bigint. Never a float (TECH-SPEC 6.5).
 */

export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = { NGN: 2, USD: 2, GBP: 2, EUR: 2, JPY: 0 };

export class MoneyError extends Error {
  constructor(readonly code: 'amount_unreadable' | 'currency_unknown' | 'rate_unreadable' | 'parts_invalid') {
    super(code);
    this.name = 'MoneyError';
  }
}

export function exponentOf(currency: string): number {
  const e = CURRENCY_EXPONENT[currency];
  if (e === undefined) throw new MoneyError('currency_unknown');
  return e;
}

const MINOR_STRING = /^-?(0|[1-9]\d*)$/;

/** Parses a JSON amount: a string of minor units ("1845000"). */
export function parseMinor(value: string): bigint {
  if (!MINOR_STRING.test(value) || value === '-0') throw new MoneyError('amount_unreadable');
  return BigInt(value);
}

/** Writes an amount for JSON. */
export function toMinorString(amount: bigint): string {
  return amount.toString();
}

/**
 * Parses what a person types ("18450", "18,450.5", "₦18,450.00") into minor units.
 * Thousands commas must be in the right places, so "1,2,3" is refused.
 */
export function parseMajor(input: string, currency = 'NGN'): bigint {
  const exp = exponentOf(currency);
  let s = input.trim().replace(/^₦/, '').replace(/\s/g, '');
  let negative = false;
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = true;
    s = s.slice(1);
  }
  const fraction = exp > 0 ? `(?:\\.(\\d{1,${exp}}))?` : '';
  const m = new RegExp(`^(\\d{1,3}(?:,\\d{3})+|\\d+)${fraction}$`).exec(s);
  if (!m) throw new MoneyError('amount_unreadable');
  const whole = m[1]!.replace(/,/g, '');
  const frac = (m[2] ?? '').padEnd(exp, '0');
  const minor = BigInt(whole + frac);
  return negative ? -minor : minor;
}

/** "₦1,284,560.50", or "−₦18,450.00" for negatives (DESIGN.md 2.6). Server use: emails and exports. */
export function formatNaira(amount: bigint): string {
  return formatAmount(amount, 'NGN', '₦');
}

export function formatAmount(amount: bigint, currency: string, symbol: string): string {
  const exp = exponentOf(currency);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const digits = abs.toString().padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp);
  const frac = exp > 0 ? '.' + digits.slice(digits.length - exp) : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${symbol}${grouped}${frac}`;
}

/** n ÷ d rounded half away from zero. */
export function divRoundHalfAwayFromZero(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new MoneyError('parts_invalid');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d;
  const r = n % d;
  if (2n * (r < 0n ? -r : r) >= d) return n < 0n ? q - 1n : q + 1n;
  return q;
}

/** n ÷ d rounded half to even (banker's rounding), for currency conversion (TECH-SPEC 6.5). */
export function divRoundHalfEven(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new MoneyError('parts_invalid');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d;
  const r = n % d;
  const twice = 2n * (r < 0n ? -r : r);
  if (twice > d || (twice === d && q % 2n !== 0n)) return n < 0n ? q - 1n : q + 1n;
  return q;
}

/** A percentage of an amount, as basis points (8% = 800), rounded half away from zero. */
export function percentOf(amount: bigint, basisPoints: bigint): bigint {
  return divRoundHalfAwayFromZero(amount * basisPoints, 10_000n);
}

/**
 * Splits a total by weights. Each part is rounded half away from zero, and any leftover minor units
 * go to the largest part, so the parts add up to the total exactly.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0 || weights.some((w) => w < 0n)) throw new MoneyError('parts_invalid');
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new MoneyError('parts_invalid');
  const parts = weights.map((w) => divRoundHalfAwayFromZero(total * w, sum));
  const leftover = total - parts.reduce((a, b) => a + b, 0n);
  let largest = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i]! > weights[largest]!) largest = i;
  parts[largest]! += leftover;
  return parts;
}

/** An instalment schedule: every instalment rounded the same way, the last one absorbs the difference. */
export function instalments(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new MoneyError('parts_invalid');
  const each = divRoundHalfAwayFromZero(total, BigInt(count));
  const parts = Array.from({ length: count }, () => each);
  parts[count - 1] = total - each * BigInt(count - 1);
  return parts;
}

const RATE = /^(0|[1-9]\d*)(?:\.(\d{1,10}))?$/;

/**
 * Converts one balance at a rate ("1550" naira per dollar, up to 10 decimal places), rounding half to even.
 * Totals are made by converting each balance and then adding, never by converting a sum.
 */
export function convert(amount: bigint, fromCurrency: string, toCurrency: string, rate: string): bigint {
  const m = RATE.exec(rate);
  if (!m) throw new MoneyError('rate_unreadable');
  const fracDigits = m[2] ?? '';
  const rateScaled = BigInt(m[1]! + fracDigits);
  const scale = 10n ** BigInt(fracDigits.length);
  const shift = exponentOf(toCurrency) - exponentOf(fromCurrency);
  const num = amount * rateScaled * (shift >= 0 ? 10n ** BigInt(shift) : 1n);
  const den = scale * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  return divRoundHalfEven(num, den);
}

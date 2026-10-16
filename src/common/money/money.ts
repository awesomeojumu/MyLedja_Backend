import { CurrencyCode, currencyScale, isCurrencyCode } from "./currencies";

/** An exact amount: integer minor units plus its currency (ADR-0001). */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/** half-up rounds ties away from zero; half-even rounds ties to the even neighbour. */
export type RoundingMode = "half-even" | "half-up" | "floor" | "ceil";

export const DEFAULT_ROUNDING: RoundingMode = "half-even";

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

export class MoneyPrecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyPrecisionError";
  }
}

export class MoneyRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyRangeError";
  }
}

export class UnknownCurrencyError extends Error {
  constructor(currency: string) {
    super(`Unknown currency: ${currency}`);
    this.name = "UnknownCurrencyError";
  }
}

function checkRange(amountMinor: bigint): bigint {
  if (amountMinor < INT64_MIN || amountMinor > INT64_MAX) {
    throw new MoneyRangeError("Amount does not fit in int64 minor units");
  }
  return amountMinor;
}

function toCurrency(currency: string): CurrencyCode {
  if (!isCurrencyCode(currency)) {
    throw new UnknownCurrencyError(currency);
  }
  return currency;
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

/** Divides n by a positive d, rounding the remainder with the given mode. */
function divideRounded(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) {
    return q;
  }
  const away = n < 0n ? q - 1n : q + 1n;
  switch (mode) {
    case "floor":
      return n < 0n ? q - 1n : q;
    case "ceil":
      return n > 0n ? q + 1n : q;
    case "half-up":
    case "half-even": {
      const twice = 2n * (r < 0n ? -r : r);
      if (twice > d) return away;
      if (twice < d) return q;
      if (mode === "half-up") return away;
      return q % 2n === 0n ? q : away;
    }
  }
}

export function money(amountMinor: bigint, currency: string): Money {
  if (typeof amountMinor !== "bigint") {
    throw new TypeError("amountMinor must be a bigint; floating-point amounts are not allowed");
  }
  return { amountMinor: checkRange(amountMinor), currency: toCurrency(currency) };
}

export function zero(currency: string): Money {
  return money(0n, currency);
}

/** Parses an API decimal string. More decimals than the currency scale is an error, never a silent round. */
export function parseMoney(decimal: string, currency: string): Money {
  if (typeof decimal !== "string") {
    throw new TypeError("Amount must be a decimal string; floating-point amounts are not allowed");
  }
  const code = toCurrency(currency);
  const match = DECIMAL_PATTERN.exec(decimal.trim());
  if (!match) {
    throw new MoneyPrecisionError(`Invalid decimal amount: ${decimal}`);
  }
  const [, sign, whole, fraction = ""] = match;
  const scale = currencyScale(code);
  if (fraction.length > scale) {
    throw new MoneyPrecisionError(`${code} allows at most ${scale} decimal places: ${decimal}`);
  }
  const minor = BigInt(whole + fraction.padEnd(scale, "0"));
  return money(sign ? -minor : minor, code);
}

/** Formats as an API decimal string with exactly the currency scale, e.g. "1234.50". */
export function formatMoney(value: Money): string {
  const scale = currencyScale(value.currency);
  const negative = value.amountMinor < 0n;
  const digits = (negative ? -value.amountMinor : value.amountMinor)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}${scale > 0 ? `.${fraction}` : ""}`;
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function sum(values: readonly Money[], currency: string): Money {
  return values.reduce((total, value) => add(total, value), zero(currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  if (a.amountMinor === b.amountMinor) return 0;
  return a.amountMinor < b.amountMinor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

/** Multiplies by an exact decimal factor (a rate or percentage as a string), then rounds once. */
export function multiply(
  a: Money,
  factor: string,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  if (typeof factor !== "string") {
    throw new TypeError("Factor must be a decimal string; floating-point factors are not allowed");
  }
  const match = DECIMAL_PATTERN.exec(factor.trim());
  if (!match) {
    throw new MoneyPrecisionError(`Invalid decimal factor: ${factor}`);
  }
  const [, sign, whole, fraction = ""] = match;
  const numerator = BigInt(whole + fraction) * (sign ? -1n : 1n);
  const denominator = 10n ** BigInt(fraction.length);
  return money(divideRounded(a.amountMinor * numerator, denominator, mode), a.currency);
}

/**
 * Splits an amount by integer weights using largest remainder, so the parts always sum to the original
 * exactly (INV-05). Leftover minor units go to the largest remainders, ties to the earliest part.
 */
export function allocate(a: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0 || weights.some((w) => typeof w !== "bigint" || w < 0n)) {
    throw new RangeError("Weights must be non-negative bigints");
  }
  const total = weights.reduce((acc, w) => acc + w, 0n);
  if (total === 0n) {
    throw new RangeError("Weights must not all be zero");
  }
  const negative = a.amountMinor < 0n;
  const amount = negative ? -a.amountMinor : a.amountMinor;
  const shares = weights.map((w) => (amount * w) / total);
  const remainders = weights.map((w, i) => ({ i, r: (amount * w) % total }));
  let leftover = amount - shares.reduce((acc, s) => acc + s, 0n);
  remainders.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    shares[i] += 1n;
    leftover -= 1n;
  }
  return shares.map((s) => money(negative ? -s : s, a.currency));
}

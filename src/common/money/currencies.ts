/** ISO 4217 minor-unit scale. A scale must never change once data exists (ADR-0001). */
export const CURRENCY_SCALE = {
  NGN: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_SCALE;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCY_SCALE, value);
}

export function currencyScale(currency: CurrencyCode): number {
  return CURRENCY_SCALE[currency];
}

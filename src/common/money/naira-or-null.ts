import { formatMoney, money } from "@/common/money/money";

/** Plan lists: BSON Long / {low,high} / bigint / integer / numeric string → "5000.00". Missing → null, never "0.00". */
export function nairaOrNull(minor: unknown): string | null {
  const kobo = toMinor(minor);
  if (kobo == null) return null;
  return formatMoney(money(kobo, "NGN"));
}

function toMinor(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === "object") {
    const rec = value as { toString?: () => string; low?: number; high?: number };
    if (typeof rec.low === "number" && typeof rec.high === "number") {
      return BigInt(rec.low >>> 0) + (BigInt(rec.high) << 32n);
    }
    if (typeof rec.toString === "function") {
      const text = rec.toString();
      if (/^-?\d+$/.test(text)) return BigInt(text);
    }
  }
  return null;
}

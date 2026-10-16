import {
  add,
  allocate,
  compare,
  CurrencyMismatchError,
  equals,
  formatMoney,
  money,
  MoneyPrecisionError,
  MoneyRangeError,
  multiply,
  negate,
  parseMoney,
  subtract,
  sum,
  UnknownCurrencyError,
} from "./index";

const ngn = (s: string) => parseMoney(s, "NGN");

describe("money precision", () => {
  it("parses decimal strings into exact minor units", () => {
    expect(ngn("1234.5")).toEqual({ amountMinor: 123450n, currency: "NGN" });
    expect(ngn("0.01").amountMinor).toBe(1n);
    expect(ngn("-7").amountMinor).toBe(-700n);
    expect(parseMoney("1000", "JPY").amountMinor).toBe(1000n);
    expect(parseMoney("1.234", "KWD").amountMinor).toBe(1234n);
  });

  it("is exact where floating point is not", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(equals(add(ngn("0.10"), ngn("0.20")), ngn("0.30"))).toBe(true);
    const tenCents = Array.from({ length: 10 }, () => ngn("0.10"));
    expect(formatMoney(sum(tenCents, "NGN"))).toBe("1.00");
  });

  it("rejects more decimals than the currency scale instead of rounding", () => {
    expect(() => ngn("1.005")).toThrow(MoneyPrecisionError);
    expect(() => parseMoney("1.5", "JPY")).toThrow(MoneyPrecisionError);
    expect(() => ngn("1e3")).toThrow(MoneyPrecisionError);
    expect(() => ngn("abc")).toThrow(MoneyPrecisionError);
  });

  it("formats with exactly the currency scale", () => {
    expect(formatMoney(ngn("1234.5"))).toBe("1234.50");
    expect(formatMoney(ngn("0.05"))).toBe("0.05");
    expect(formatMoney(ngn("-0.05"))).toBe("-0.05");
    expect(formatMoney(parseMoney("42", "JPY"))).toBe("42");
    expect(formatMoney(parseMoney("0.001", "KWD"))).toBe("0.001");
  });

  it("round-trips the full int64 range and rejects overflow", () => {
    const max = money(2n ** 63n - 1n, "NGN");
    expect(parseMoney(formatMoney(max), "NGN")).toEqual(max);
    expect(() => add(max, ngn("0.01"))).toThrow(MoneyRangeError);
    expect(() => money(-(2n ** 63n) - 1n, "NGN")).toThrow(MoneyRangeError);
  });
});

describe("no floating point", () => {
  it("refuses number amounts and factors at runtime", () => {
    expect(() => money(1.5 as unknown as bigint, "NGN")).toThrow(TypeError);
    expect(() => parseMoney(10.25 as unknown as string, "NGN")).toThrow(TypeError);
    expect(() => multiply(ngn("1"), 0.075 as unknown as string)).toThrow(TypeError);
    expect(() => allocate(ngn("1"), [1 as unknown as bigint])).toThrow(RangeError);
  });

  it("keeps amounts as bigint", () => {
    expect(typeof add(ngn("1"), ngn("2")).amountMinor).toBe("bigint");
  });
});

describe("rounding", () => {
  it("defaults to half-even (banker's rounding)", () => {
    // 0.25 * 0.5 = 0.125 → 0.12; 0.35 * 0.5 = 0.175 → 0.18
    expect(formatMoney(multiply(ngn("0.25"), "0.5"))).toBe("0.12");
    expect(formatMoney(multiply(ngn("0.35"), "0.5"))).toBe("0.18");
    expect(formatMoney(multiply(ngn("-0.25"), "0.5"))).toBe("-0.12");
  });

  it("supports half-up (ties away from zero), floor and ceil", () => {
    expect(formatMoney(multiply(ngn("0.25"), "0.5", "half-up"))).toBe("0.13");
    expect(formatMoney(multiply(ngn("-0.25"), "0.5", "half-up"))).toBe("-0.13");
    expect(formatMoney(multiply(ngn("0.19"), "0.5", "floor"))).toBe("0.09");
    expect(formatMoney(multiply(ngn("-0.19"), "0.5", "floor"))).toBe("-0.10");
    expect(formatMoney(multiply(ngn("0.11"), "0.5", "ceil"))).toBe("0.06");
    expect(formatMoney(multiply(ngn("-0.11"), "0.5", "ceil"))).toBe("-0.05");
  });

  it("applies a 7.5% VAT exactly and rounds once", () => {
    expect(formatMoney(multiply(ngn("1999.99"), "0.075"))).toBe("150.00");
    expect(formatMoney(multiply(ngn("10.10"), "0.075"))).toBe("0.76");
  });

  it("leaves exact products unrounded", () => {
    expect(formatMoney(multiply(ngn("100.00"), "1.5"))).toBe("150.00");
    expect(formatMoney(multiply(ngn("100.00"), "-1"))).toBe("-100.00");
  });

  it("allocates without losing or inventing a minor unit", () => {
    const parts = allocate(ngn("100.00"), [1n, 1n, 1n]);
    expect(parts.map(formatMoney)).toEqual(["33.34", "33.33", "33.33"]);
    expect(equals(sum(parts, "NGN"), ngn("100.00"))).toBe(true);

    const weighted = allocate(ngn("-0.05"), [3n, 7n]);
    expect(weighted.map(formatMoney)).toEqual(["-0.02", "-0.03"]);
    expect(equals(sum(weighted, "NGN"), ngn("-0.05"))).toBe(true);
  });

  it("rejects invalid weights", () => {
    expect(() => allocate(ngn("1"), [])).toThrow(RangeError);
    expect(() => allocate(ngn("1"), [0n, 0n])).toThrow(RangeError);
    expect(() => allocate(ngn("1"), [-1n, 2n])).toThrow(RangeError);
  });
});

describe("currency mismatch", () => {
  const usd = parseMoney("1.00", "USD");

  it("refuses to add, subtract or compare different currencies", () => {
    expect(() => add(ngn("1.00"), usd)).toThrow(CurrencyMismatchError);
    expect(() => subtract(ngn("1.00"), usd)).toThrow(CurrencyMismatchError);
    expect(() => compare(ngn("1.00"), usd)).toThrow(CurrencyMismatchError);
    expect(() => sum([ngn("1.00"), usd], "NGN")).toThrow(CurrencyMismatchError);
  });

  it("never treats equal digits in different currencies as equal", () => {
    expect(equals(ngn("1.00"), usd)).toBe(false);
  });

  it("rejects unknown currencies", () => {
    expect(() => parseMoney("1.00", "XYZ")).toThrow(UnknownCurrencyError);
    expect(() => money(1n, "ngn")).toThrow(UnknownCurrencyError);
  });
});

describe("arithmetic", () => {
  it("adds, subtracts, negates and compares", () => {
    expect(formatMoney(subtract(ngn("5.00"), ngn("7.25")))).toBe("-2.25");
    expect(formatMoney(negate(ngn("3.10")))).toBe("-3.10");
    expect(compare(ngn("1.00"), ngn("2.00"))).toBe(-1);
    expect(compare(ngn("2.00"), ngn("2.00"))).toBe(0);
    expect(compare(ngn("3.00"), ngn("2.00"))).toBe(1);
  });
});

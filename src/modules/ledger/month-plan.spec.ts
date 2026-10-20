import { billSetAside, debtSetAside, expectedIncome, goalSetAside, monthsUntil, parseMonth, previousMonth, yearlyDue } from "@/modules/ledger/month-plan";

const N = (naira: number) => BigInt(Math.round(naira * 100));

describe("month plan set-asides", () => {
  const jan = "2027-01";

  it("parses and steps months", () => {
    expect(parseMonth("2027-01")).toEqual({ year: 2027, month: 0 });
    expect(parseMonth("2027-13")).toBeNull();
    expect(previousMonth("2027-01")).toBe("2026-12");
    expect(monthsUntil({ year: 2027, month: 0 }, new Date(Date.UTC(2027, 3, 1)))).toBe(3);
    expect(monthsUntil({ year: 2027, month: 0 }, new Date(Date.UTC(2027, 4, 31)))).toBe(5);
    expect(monthsUntil({ year: 2027, month: 0 }, new Date(Date.UTC(2027, 0, 20)))).toBe(1);
    expect(monthsUntil({ year: 2027, month: 0 }, new Date(Date.UTC(2026, 10, 1)))).toBe(1);
  });

  it("spreads yearly rent over the months to its due date, counting what earlier months set aside", () => {
    const rent = { id: "rent", name: "Rent", amountMinor: N(1_500_000), cadence: "yearly", anchorDay: 1, anchorMonth: 4, weekday: 1, lastPaidAt: null };
    // Due 1 April: it has to be ready by the end of March, so January, February and March share it.
    const january = billSetAside(rent, jan, new Map());
    expect(january.due).toBe("2027-04-01");
    expect(january.monthsLeft).toBe(3);
    expect(january.amountMinor).toBe(N(500_000));
    // February knows January already put ₦500k toward it, so the amount stays steady.
    const february = billSetAside(rent, "2027-02", new Map([["rent", N(500_000)]]));
    expect(february.amountMinor).toBe(N(500_000));
    // If February's budget was skipped, March has to make up the gap.
    const march = billSetAside(rent, "2027-03", new Map([["rent", N(500_000)]]));
    expect(march.amountMinor).toBe(N(1_000_000));
  });

  it("moves a yearly bill to next year once this cycle is paid", () => {
    const rent = { id: "rent", name: "Rent", amountMinor: N(1_500_000), cadence: "yearly", anchorDay: 1, anchorMonth: 4, weekday: 1, lastPaidAt: new Date(Date.UTC(2027, 2, 28)) };
    expect(yearlyDue(rent, { year: 2027, month: 4 }).toISOString().slice(0, 10)).toBe("2028-04-01");
    const may = billSetAside(rent, "2027-05", new Map());
    // Next due 1 April 2028: May 2027 to March 2028 is 11 months.
    expect(may.monthsLeft).toBe(11);
    expect(may.amountMinor).toBe(13_636_364n);
  });

  it("charges monthly bills in full and weekly bills per occurrence", () => {
    const dstv = { id: "d", name: "DSTV", amountMinor: N(12_500), cadence: "monthly", anchorDay: 23, weekday: 1, lastPaidAt: null };
    expect(billSetAside(dstv, jan, new Map())).toMatchObject({ amountMinor: N(12_500), due: "2027-01-23", monthsLeft: 1 });
    // January 2027 has five Fridays.
    const cleaner = { id: "c", name: "Cleaner", amountMinor: N(5_000), cadence: "weekly", anchorDay: 1, weekday: 5, lastPaidAt: null };
    expect(billSetAside(cleaner, jan, new Map()).amountMinor).toBe(N(25_000));
  });

  it("spreads what's left of a goal to its date, rounding up to the kobo", () => {
    const car = { id: "car", name: "Car", targetMinor: N(6_000_000), savedMinor: 0n, dueAt: new Date(Date.UTC(2027, 11, 31)) };
    expect(goalSetAside(car, jan)).toMatchObject({ amountMinor: N(500_000), monthsLeft: 12, due: "2027-12-31" });
    const odd = { ...car, targetMinor: N(100) };
    expect(goalSetAside(odd, jan).amountMinor).toBe(834n);
    const noDate = goalSetAside({ ...car, dueAt: null }, jan);
    expect(noDate).toMatchObject({ amountMinor: 0n, due: null, totalMinor: N(6_000_000) });
    expect(goalSetAside({ ...car, savedMinor: N(7_000_000) }, jan).amountMinor).toBe(0n);
  });

  it("spreads a debt to its payoff date", () => {
    const loan = { id: "l", name: "Loan", remainingMinor: N(500_000), payoffBy: new Date(Date.UTC(2027, 4, 31)) };
    expect(debtSetAside(loan, jan)).toMatchObject({ amountMinor: N(100_000), monthsLeft: 5 });
    expect(debtSetAside({ ...loan, payoffBy: null }, jan).amountMinor).toBe(0n);
  });

  it("adds up a month's income", () => {
    const streams = [
      { expectedMinor: N(1_000_000), cadence: "monthly" },
      { expectedMinor: N(500_000), cadence: "monthly" },
      { expectedMinor: N(10_000), cadence: "weekly", weekday: 5 },
      { expectedMinor: N(2_000_000), cadence: "yearly" },
    ];
    expect(expectedIncome(streams, jan)).toBe(N(1_550_000));
  });
});

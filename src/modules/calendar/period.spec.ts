import { clampDay, monthEnd, nextMonthly } from "@/modules/calendar/period";

describe("I1 bill calendar", () => {
  it("clamps month-end 31 onto September 30", () => {
    expect(monthEnd(2026, 8)).toBe(30);
    expect(clampDay(2026, 8, 31).toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("clamps leap-day 29 onto 28 Feb in a non-leap year", () => {
    expect(clampDay(2026, 1, 29).toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("keeps 29 Feb in a leap year", () => {
    expect(clampDay(2028, 1, 29).toISOString().slice(0, 10)).toBe("2028-02-29");
  });

  it("rolls a passed monthly anchor into the next month", () => {
    const next = nextMonthly(new Date("2026-10-18T00:00:00.000Z"), 17);
    expect(next.toISOString().slice(0, 10)).toBe("2026-11-17");
  });
});

import { clampDay, monthEnd, nextMonthly, zonedInstant } from "@/modules/calendar/period";

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

  it("places a UTC evening into the next Lagos day and the same New York day", () => {
    const at = new Date("2026-10-31T23:30:00.000Z");
    expect(zonedInstant(at, "Africa/Lagos").getUTCDate()).toBe(1);
    expect(zonedInstant(at, "America/New_York").getUTCDate()).toBe(31);
  });
});

import { nairaOrNull } from "@/common/money/naira-or-null";

describe("nairaOrNull", () => {
  it("maps 500000 kobo to 5000.00 from bigint, Long, and string", () => {
    expect(nairaOrNull(500000n)).toBe("5000.00");
    expect(nairaOrNull({ low: 500000, high: 0 })).toBe("5000.00");
    expect(nairaOrNull("500000")).toBe("5000.00");
  });

  it("returns null when the amount is missing", () => {
    expect(nairaOrNull(null)).toBeNull();
    expect(nairaOrNull(undefined)).toBeNull();
  });
});

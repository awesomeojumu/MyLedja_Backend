import { csvCell } from "@/modules/imports-exports/csv-cell";

describe("csvCell TC-15", () => {
  it("prefixes equals plus minus at tab and carriage return", () => {
    expect(csvCell("=HYPERLINK")).toBe(`"'=HYPERLINK"`);
    expect(csvCell("\t=cmd")).toBe(`"'\t=cmd"`);
    expect(csvCell("\r=cmd")).toBe(`"'\r=cmd"`);
    expect(csvCell("Market")).toBe(`"Market"`);
  });
});

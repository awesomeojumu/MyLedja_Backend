import { periodTotals } from "@/modules/transactions/application/totals";
import { TransactionDoc } from "@/modules/transactions/schemas/transaction";

function row(partial: Partial<TransactionDoc>): TransactionDoc {
  return {
    _id: "x",
    workspaceId: "w",
    type: "expense",
    status: "posted",
    description: "",
    amountMinor: 0n,
    currency: "NGN",
    accountId: "a",
    tagIds: [],
    effects: [],
    version: 1,
    createdAt: new Date(),
    ...partial,
  };
}

describe("periodTotals", () => {
  it("ignores transfers and non-posted rows", () => {
    const totals = periodTotals([
      row({ type: "expense", amountMinor: 100n }),
      row({ type: "transfer", amountMinor: 50n }),
      row({ type: "expense", amountMinor: 10n, status: "voided" }),
      row({ type: "income", amountMinor: 20n }),
    ]);
    expect(totals.expense).toBe("1.00");
    expect(totals.income).toBe("0.20");
  });
});

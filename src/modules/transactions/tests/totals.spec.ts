import { netSpend, periodTotals, spendLines } from "@/modules/transactions/application/totals";
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

  it("takes a refund off the expense total (TC-07)", () => {
    const totals = periodTotals([
      row({ _id: "e1", type: "expense", amountMinor: 1200n }),
      row({ _id: "r1", type: "refund", amountMinor: 400n, originalTransactionId: "e1" }),
    ]);
    expect(totals.expense).toBe("8.00");
    expect(totals.grossExpense).toBe("12.00");
    expect(totals.refund).toBe("4.00");
  });

  it("counts a refund against the original expense's account", () => {
    const original = row({ _id: "e1", type: "expense", amountMinor: 1000n, accountId: "cash" });
    const refund = row({ _id: "r1", type: "refund", amountMinor: 300n, accountId: "bank", originalTransactionId: "e1" });
    const lines = spendLines([refund], [original, refund]);
    expect(lines).toEqual([expect.objectContaining({ accountId: "cash", amountMinor: -300n })]);
  });

  it("never reports negative spend when only the refund is in range", () => {
    expect(netSpend([{ amountMinor: -300n }])).toBe(0n);
  });
});

import { formatMoney, money } from "@/common/money/money";
import { TransactionDoc } from "@/modules/transactions/schemas/transaction";

export function periodTotals(rows: readonly TransactionDoc[], currency = "NGN") {
  let income = 0n;
  let expense = 0n;
  for (const row of rows) {
    if (row.status !== "posted") continue;
    if (row.type === "income") income += row.amountMinor;
    if (row.type === "expense") expense += row.amountMinor;
  }
  const refund = rows
    .filter((row) => row.status === "posted" && row.type === "refund")
    .reduce((sum, row) => sum + row.amountMinor, 0n);
  return {
    income: formatMoney(money(income, currency)),
    expense: formatMoney(money(expense, currency)),
    refund: formatMoney(money(refund, currency)),
  };
}

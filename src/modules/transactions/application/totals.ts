import { formatMoney, money } from "@/common/money/money";
import { TransactionDoc } from "@/modules/transactions/schemas/transaction";

export function periodTotals(rows: readonly TransactionDoc[], currency = "NGN") {
  let income = 0n;
  let expense = 0n;
  for (const row of rows) {
    if (row.status !== "posted") continue;
    if (row.type === "income" || row.type === "refund") income += row.amountMinor;
    if (row.type === "expense") expense += row.amountMinor;
  }
  return {
    income: formatMoney(money(income, currency)),
    expense: formatMoney(money(expense, currency)),
  };
}

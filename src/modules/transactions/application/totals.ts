import { formatMoney, money } from "@/common/money/money";
import { TransactionDoc } from "@/modules/transactions/schemas/transaction";

/**
 * Spending lines under the refund policy (spec §5.2, TC-07, INV-12): a posted expense adds to spend, and a posted
 * refund takes it back off, against the account of the expense it refunds. Transfers and other types never count.
 */
export function spendLines(
  rows: readonly TransactionDoc[],
  lookup: readonly TransactionDoc[] = rows,
): { accountId: string; at: Date; amountMinor: bigint }[] {
  const byId = new Map(lookup.map((row) => [row._id, row]));
  const lines: { accountId: string; at: Date; amountMinor: bigint }[] = [];
  for (const row of rows) {
    if (row.status !== "posted") continue;
    const at = row.occurredAt ?? row.createdAt;
    if (row.type === "expense") lines.push({ accountId: row.accountId, at, amountMinor: row.amountMinor });
    if (row.type === "refund") {
      const original = row.originalTransactionId ? byId.get(row.originalTransactionId) : undefined;
      lines.push({ accountId: original?.accountId ?? row.accountId, at, amountMinor: -row.amountMinor });
    }
  }
  return lines;
}

/** Net spend never goes below zero: a refund landing in a later period than its expense can't make spending negative. */
export function netSpend(lines: readonly { amountMinor: bigint }[]): bigint {
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  return total < 0n ? 0n : total;
}

export function periodTotals(rows: readonly TransactionDoc[], currency = "NGN", lookup: readonly TransactionDoc[] = rows) {
  let income = 0n;
  let gross = 0n;
  let refund = 0n;
  for (const row of rows) {
    if (row.status !== "posted") continue;
    if (row.type === "income") income += row.amountMinor;
    if (row.type === "expense") gross += row.amountMinor;
    if (row.type === "refund") refund += row.amountMinor;
  }
  return {
    income: formatMoney(money(income, currency)),
    expense: formatMoney(money(netSpend(spendLines(rows, lookup)), currency)),
    grossExpense: formatMoney(money(gross, currency)),
    refund: formatMoney(money(refund, currency)),
  };
}

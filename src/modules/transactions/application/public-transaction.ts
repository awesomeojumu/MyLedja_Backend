import { formatMoney, money } from "@/common/money/money";
import { TransactionDoc } from "@/modules/transactions/schemas/transaction";

export function publicTransaction(doc: TransactionDoc) {
  return {
    id: doc._id,
    type: doc.type,
    status: doc.status,
    description: doc.description,
    amount: formatMoney(money(doc.amountMinor, doc.currency)),
    currency: doc.currency,
    accountId: doc.accountId,
    toAccountId: doc.toAccountId ?? null,
    categoryId: doc.categoryId ?? null,
    merchantId: doc.merchantId ?? null,
    tagIds: doc.tagIds,
    occurredAt: doc.occurredAt ? new Date(doc.occurredAt).toISOString() : new Date(doc.createdAt).toISOString(),
  };
}

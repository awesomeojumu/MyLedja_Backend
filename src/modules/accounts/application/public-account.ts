import { formatMoney, money } from "@/common/money/money";
import { institutionById } from "@/modules/accounts/domain/institutions";
import { AccountDoc } from "@/modules/accounts/schemas/account";

export function publicAccount(doc: AccountDoc) {
  return {
    id: doc._id,
    name: doc.name,
    kind: doc.kind,
    institutionId: doc.institutionId,
    institution: doc.institutionId ? (institutionById(doc.institutionId)?.name ?? null) : null,
    connectionType: doc.connectionType,
    currency: doc.currency,
    opening: formatMoney(money(doc.openingBalanceMinor, doc.currency)),
    balance: formatMoney(money(doc.balanceMinor, doc.currency)),
    mask: doc.mask ?? null,
    archived: doc.archivedAt != null,
  };
}

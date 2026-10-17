export const ACCOUNTS_COLLECTION = "accounts";

export type ConnectionType = "manual" | "linked" | "imported";
export type AccountKind = "bank" | "wallet" | "cash" | "savings" | "liability" | "receivable";

export interface AccountDoc {
  _id: string;
  workspaceId: string;
  name: string;
  kind: AccountKind;
  institutionId: string | null;
  connectionType: ConnectionType;
  currency: string;
  openingBalanceMinor: bigint;
  balanceMinor: bigint;
  accountNumberCipher?: string;
  accountNumberIv?: string;
  accountNumberTag?: string;
  mask?: string;
  archivedAt: Date | null;
  createdAt: Date;
  externalBalanceMinor?: bigint;
  reconciledAsOf?: Date;
}

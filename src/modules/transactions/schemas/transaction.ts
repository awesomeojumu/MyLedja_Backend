export const TRANSACTIONS_COLLECTION = "transactions";
export const OPERATIONS_COLLECTION = "operations";

export type LedgerType = "income" | "expense" | "transfer" | "refund";
export type LedgerStatus = "pending" | "posted" | "reversed" | "voided";

export interface Effect {
  accountId: string;
  amountMinor: bigint;
  currency: string;
}

export interface TransactionDoc {
  _id: string;
  workspaceId: string;
  type: LedgerType;
  status: LedgerStatus;
  description: string;
  amountMinor: bigint;
  currency: string;
  accountId: string;
  toAccountId?: string;
  categoryId?: string;
  merchantId?: string;
  tagIds: string[];
  effects: Effect[];
  version: number;
  createdAt: Date;
}

export interface OperationDoc {
  _id: string;
  operationId: string;
  workspaceId: string;
  entityId: string;
  payloadHash: string;
  createdAt: Date;
}

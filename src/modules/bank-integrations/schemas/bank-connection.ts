export const BANK_CONNECTIONS_COLLECTION = "bank_connections";

export interface BankConnectionDoc {
  _id: string;
  workspaceId: string;
  userId: string;
  provider: "mono";
  monoAppId: string;
  monoAccountId: string;
  institution: string;
  name: string;
  mask: string;
  linkedAt: Date;
}

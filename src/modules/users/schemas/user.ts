export const USERS_COLLECTION = "users";

export interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  verifiedAt: Date | null;
  createdAt: Date;
  hideLockScreenAmounts?: boolean;
  totpEnabled?: boolean;
  totpSecretEnc?: string | null;
  totpPendingEnc?: string | null;
  backupCodeHashes?: string[];
}

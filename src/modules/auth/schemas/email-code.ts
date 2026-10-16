export const EMAIL_CODES_COLLECTION = "email_codes";

export type EmailCodePurpose = "verify" | "recovery";

export interface EmailCodeDoc {
  _id: string;
  email: string;
  purpose: EmailCodePurpose;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  usedAt: Date | null;
  createdAt: Date;
}

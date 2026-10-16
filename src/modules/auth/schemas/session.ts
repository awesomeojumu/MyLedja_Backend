export const SESSIONS_COLLECTION = "sessions";

export interface SessionDoc {
  _id: string;
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

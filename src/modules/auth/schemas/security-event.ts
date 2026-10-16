export const SECURITY_EVENTS_COLLECTION = "security_events";

export interface SecurityEventDoc {
  _id: string;
  type: "refresh_reuse" | "password_reset";
  userId: string;
  familyId?: string;
  createdAt: Date;
}

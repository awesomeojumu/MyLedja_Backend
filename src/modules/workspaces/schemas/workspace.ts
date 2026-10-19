export const WORKSPACES_COLLECTION = "workspaces";

export interface SetupProgress {
  currency: boolean;
  firstAccount: boolean;
  opening: boolean;
  categories: boolean;
  firstTransaction: boolean;
}

export const EMPTY_SETUP: SetupProgress = {
  currency: false,
  firstAccount: false,
  opening: false,
  categories: false,
  firstTransaction: false,
};

export interface ReminderPrefs {
  bills: boolean;
  budget: boolean;
  summary: boolean;
}

export const DEFAULT_REMINDERS: ReminderPrefs = {
  bills: true,
  budget: true,
  summary: false,
};

export interface WorkspaceDoc {
  _id: string;
  name: string;
  kind: "personal";
  ownerId: string;
  createdAt: Date;
  defaultCurrency?: string;
  locale?: string;
  setupProgress?: SetupProgress;
  timezone?: string;
  weekStartsOn?: "monday" | "sunday";
  reminders?: ReminderPrefs;
}

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

export interface WorkspaceDoc {
  _id: string;
  name: string;
  kind: "personal";
  ownerId: string;
  createdAt: Date;
  defaultCurrency?: string;
  setupProgress?: SetupProgress;
}

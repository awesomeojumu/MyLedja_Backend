export const WORKSPACES_COLLECTION = "workspaces";

export interface WorkspaceDoc {
  _id: string;
  name: string;
  kind: "personal";
  ownerId: string;
  createdAt: Date;
}

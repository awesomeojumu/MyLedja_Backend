export const CATEGORIES_COLLECTION = "categories";
export const TAGS_COLLECTION = "tags";
export const MERCHANTS_COLLECTION = "merchants";
export const RULES_COLLECTION = "categorization_rules";

export interface CategoryDoc {
  _id: string;
  workspaceId: string;
  name: string;
  kind: "income" | "expense";
  parentId: string | null;
}

export interface TagDoc {
  _id: string;
  workspaceId: string;
  name: string;
}

export interface MerchantDoc {
  _id: string;
  workspaceId: string;
  name: string;
  categoryId: string;
  aliases: string[];
}

export interface RuleDoc {
  _id: string;
  workspaceId: string;
  match: { descriptionContains?: string; merchantId?: string; alias?: string };
  categoryId: string;
}

export const DEFAULT_CATEGORIES: { name: string; kind: "income" | "expense" }[] = [
  { name: "Food & groceries", kind: "expense" },
  { name: "Transport", kind: "expense" },
  { name: "Data & airtime", kind: "expense" },
  { name: "Subscriptions (DSTV, Netflix)", kind: "expense" },
  { name: "Rent", kind: "expense" },
  { name: "Salary", kind: "income" },
  { name: "Loan repayments", kind: "expense" },
  { name: "Repayment received", kind: "income" },
];

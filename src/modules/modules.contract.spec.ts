import { existsSync } from "node:fs";
import { join } from "node:path";

export const MODULE_FOLDERS = [
  "auth",
  "users",
  "security",
  "workspaces",
  "accounts",
  "transactions",
  "categories-merchants",
  "income",
  "budgets",
  "bills",
  "plans-goals",
  "debts",
  "savings-investments",
  "taxes",
  "analytics",
  "notifications",
  "imports-exports",
  "bank-integrations",
  "settings-privacy",
  "support-operations",
] as const;

const MODULE_DIRS = [
  "controllers",
  "dto",
  "application",
  "domain",
  "repositories",
  "schemas",
  "policies",
  "tests",
] as const;

function className(folder: string): string {
  return `${folder
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Module`;
}

describe("backend module contract", () => {
  it("lists 20 modules including workspaces", () => {
    expect(MODULE_FOLDERS).toHaveLength(20);
    expect(MODULE_FOLDERS).toContain("workspaces");
    expect(MODULE_FOLDERS).toContain("support-operations");
  });

  it("gives each module a Nest class and the §14.1 directories", () => {
    const root = __dirname;
    for (const folder of MODULE_FOLDERS) {
      const moduleRoot = join(root, folder);
      const moduleFile = join(moduleRoot, `${folder}.module.ts`);
      expect(existsSync(moduleFile)).toBe(true);
      for (const dir of MODULE_DIRS) {
        expect(existsSync(join(moduleRoot, dir))).toBe(true);
      }
    }
  });

  it("names the module class from the folder", () => {
    expect(className("support-operations")).toBe("SupportOperationsModule");
    expect(className("workspaces")).toBe("WorkspacesModule");
    expect(className("categories-merchants")).toBe("CategoriesMerchantsModule");
  });
});

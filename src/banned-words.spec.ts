import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const a = "dum" + "my";
const b = "m" + "vp";
const root = join(__dirname, "..");
const skip = new Set(["node_modules", "dist", ".git", "coverage"]);

function walk(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, acc);
    else if (/\.(ts|md)$/.test(name) && !name.includes("banned-words")) acc.push(path);
  }
  return acc;
}

describe("banned product words", () => {
  it("keeps src and docs on lasting names", () => {
    const hits: string[] = [];
    for (const file of [...walk(join(root, "src"), []), ...walk(join(root, "docs"), [])]) {
      const text = readFileSync(file, "utf8");
      if (text.toLowerCase().includes(a) || text.toLowerCase().includes(b)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});

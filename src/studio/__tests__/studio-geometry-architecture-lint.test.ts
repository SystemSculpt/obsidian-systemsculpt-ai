import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const SOURCE_ROOTS = [
  resolve(REPO_ROOT, "src/studio"),
  resolve(REPO_ROOT, "src/views/studio"),
];

/**
 * Node layout geometry is first-class data (node.size), owned by the geometry
 * module. Only the module's clearly-marked legacy read fallback and the load
 * migration may touch the retired config.width / config.height keys; any new
 * geometry read or write in production Studio source must go through
 * src/studio/StudioNodeGeometry.ts.
 */
const ALLOWED_LEGACY_GEOMETRY_FILES = new Set<string>([
  "src/studio/StudioNodeGeometry.ts",
  "src/studio/StudioGraphMigrations.ts",
]);

const LEGACY_GEOMETRY_TOKEN =
  /(\.config\.(width|height)\b)|(config\?\.(width|height)\b)|(config\[["'](width|height)["']\])|(\bnodeConfig\.(width|height)\b)/;

function listSourceFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        if (entry === "__tests__") {
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      files.push(fullPath);
    }
  };
  for (const root of SOURCE_ROOTS) {
    visit(root);
  }
  return files.sort();
}

describe("Studio geometry architecture lint", () => {
  it("confines legacy config.width/config.height geometry access to the geometry module and migrations", () => {
    const offendingFiles: string[] = [];
    for (const filePath of listSourceFiles()) {
      const relativePath = relative(REPO_ROOT, filePath).replace(/\\/g, "/");
      if (ALLOWED_LEGACY_GEOMETRY_FILES.has(relativePath)) {
        continue;
      }
      const content = readFileSync(filePath, "utf8");
      if (LEGACY_GEOMETRY_TOKEN.test(content)) {
        offendingFiles.push(relativePath);
      }
    }
    expect(offendingFiles).toEqual([]);
  });

  it("keeps a single geometry module: the old views-layer module path stays retired", () => {
    const retiredPath = resolve(
      REPO_ROOT,
      "src/views/studio/graph-v3/StudioGraphNodeGeometry.ts"
    );
    let exists = true;
    try {
      statSync(retiredPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

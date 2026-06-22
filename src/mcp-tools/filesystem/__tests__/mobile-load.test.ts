/**
 * @jest-environment node
 *
 * Mobile-load guard for the agent filesystem tools (#142, #207).
 *
 * The filesystem tool graph (MCPFilesystemServer → FileOperations /
 * DirectoryOperations / utils) must run on Android/iOS, where there is no Node
 * runtime. esbuild lowers a top-level `import … from "node:…"` to an EAGER
 * `require` that runs at module-eval, which hard-crashes a phone the moment the
 * module is reached ("Failed to load SystemSculpt AI", the #181 class). Node
 * builtins are therefore allowed ONLY behind a lazy, capability-gated boundary
 * (`loadDesktopOnly(() => require("node:…"))`), never as a static import.
 *
 * This test pins that invariant on the mobile-critical files so a future edit
 * cannot silently re-introduce an eager Node import and regress mobile load. It
 * is the cheapest layer that catches the regression: pure source inspection, no
 * build, no device. The built-bundle proof lives in
 * `testing/integration/bundle-load.no-node.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const FILESYSTEM_DIR = path.resolve(__dirname, "..");

// Files reached when the agent runs a filesystem tool on a phone. Each must be
// free of eager Node imports so the graph module-evaluates without a runtime.
const MOBILE_CRITICAL_FILES = [
  "utils.ts",
  "tools/FileOperations.ts",
  "tools/DirectoryOperations.ts",
];

describe("agent filesystem tools: no eager Node import (mobile load, #142/#207)", () => {
  for (const relPath of MOBILE_CRITICAL_FILES) {
    describe(relPath, () => {
      const source = readFileSync(path.join(FILESYSTEM_DIR, relPath), "utf8");

      it("has no top-level `import … from \"node:…\"` (esbuild would eager-require it)", () => {
        const eagerNodeImports = source
          .split("\n")
          .filter((line) => /^import\s+.*\bfrom\s+["']node:/.test(line));
        expect(eagerNodeImports).toEqual([]);
      });

      it("touches Node builtins only through the lazy desktop-only boundary", () => {
        // Any `require("node:…")` that survives must sit inside a thunk passed
        // to loadDesktopOnly (so it never evaluates on a phone). A bare,
        // column-0 require would run at module-eval — forbid it.
        const topLevelNodeRequires = source
          .split("\n")
          .filter((line) => /^(?:const|let|var)?\s*require\(["']node:/.test(line));
        expect(topLevelNodeRequires).toEqual([]);

        if (source.includes('require("node:')) {
          // Every node require present must be wrapped by the canonical boundary.
          expect(source).toMatch(/loadDesktopOnly\(\s*\(\)\s*=>\s*require\(["']node:/);
        }
      });
    });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { lintCssDirectory } from "./lint-css.mjs";

function createTempCssDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-lint-css-"));
}

function writeCss(dir, name, contents) {
  fs.writeFileSync(path.join(dir, name), contents, "utf8");
}

// Permanent guard for plan 010: the CSS linter is wired into the check:plugin
// gate (scripts/check-plugin.mjs imports lintCssDirectory). These tests prove
// the gate actually FAILS on a deliberate violation and PASSES on scoped CSS,
// so the guard can never silently degrade into a no-op again.

test("lintCssDirectory flags a bare Obsidian-override selector (the gate fails on a violation)", () => {
  const dir = createTempCssDir();
  // This is the exact class of bug the linter exists to catch: an unscoped
  // .workspace-leaf-content override that would leak into every workspace leaf
  // (see src/css/README.md "Historical Context").
  writeCss(
    dir,
    "bad-override.css",
    [
      ".workspace-leaf-content [role=\"button\"] {",
      "  position: relative;",
      "}",
      "",
    ].join("\n")
  );

  const report = lintCssDirectory({ cssDir: dir });

  assert.ok(
    report.errorCount > 0,
    `expected the linter to report at least one error, got ${report.errorCount}`
  );
  assert.ok(
    report.issues.some(issue => issue.severity === "error"),
    "expected at least one error-severity issue"
  );
});

test("lintCssDirectory flags a bare [data-type] selector", () => {
  const dir = createTempCssDir();
  writeCss(
    dir,
    "bad-attr.css",
    '[data-type="markdown"] { color: red; }\n'
  );

  const report = lintCssDirectory({ cssDir: dir });

  assert.ok(report.errorCount > 0, "bare [data-type=] selector must be an error");
});

test("lintCssDirectory passes properly scoped plugin selectors (the gate stays green)", () => {
  const dir = createTempCssDir();
  writeCss(
    dir,
    "good-scoped.css",
    [
      ".systemsculpt-chat-view [role=\"button\"] {",
      "  position: relative;",
      "}",
      ".workspace-leaf-content[data-type=\"systemsculpt-chat\"] {",
      "  padding: 0;",
      "}",
      "",
    ].join("\n")
  );

  const report = lintCssDirectory({ cssDir: dir });

  assert.equal(report.errorCount, 0, "scoped plugin selectors must not error");
});

test("the shipped src/css tree passes the linter (gate is green today)", () => {
  const cssDir = path.join(process.cwd(), "src", "css");
  const report = lintCssDirectory({ cssDir });

  assert.equal(
    report.errorCount,
    0,
    `src/css must stay clean so the gate is green; errors:\n` +
      report.issues
        .filter(issue => issue.severity === "error")
        .map(issue => `  ${issue.file}:${issue.line} ${issue.message}`)
        .join("\n")
  );
  assert.ok(report.fileCount > 0, "expected to lint at least one CSS file");
});

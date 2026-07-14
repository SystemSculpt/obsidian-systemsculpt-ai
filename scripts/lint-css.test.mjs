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

// The CSS linter is wired into the plugin check
// (scripts/check-plugin.mjs imports lintCssDirectory). These tests prove
// the gate actually FAILS on a deliberate violation and PASSES on scoped CSS,
// so the guard can never silently degrade into a no-op again.

test("lintCssDirectory flags a bare Obsidian-override selector (the gate fails on a violation)", () => {
  const dir = createTempCssDir();
  // This is the exact class of bug the linter exists to catch: an unscoped
  // .workspace-leaf-content override that would leak into every workspace leaf
  // (see the scoping contract in src/css/README.md).
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

test("lintCssDirectory rejects global element selectors", () => {
  const dir = createTempCssDir();
  writeCss(dir, "global.css", "button { padding: 0; }\n");
  const report = lintCssDirectory({ cssDir: dir });
  assert.ok(
    report.issues.some((issue) => issue.message.includes("Global selector")),
    "bare element selectors must fail",
  );
});

test("lintCssDirectory checks selectors nested inside media and container rules", () => {
  const dir = createTempCssDir();
  writeCss(
    dir,
    "nested.css",
    [
      "@media (max-width: 600px) {",
      "  .workspace-leaf-content .native-control { padding: 0; }",
      "}",
      "@container panel (max-width: 400px) {",
      "  .unscoped-card { padding: 0; }",
      "}",
    ].join("\n")
  );

  const report = lintCssDirectory({ cssDir: dir });
  assert.ok(report.errorCount >= 2, "nested leaking selectors must fail the gate");
});

test("lintCssDirectory rejects legacy state classes and undefined SystemSculpt tokens", () => {
  const dir = createTempCssDir();
  writeCss(
    dir,
    "state.css",
    [
      ".ss-card.active { z-index: var(--ss-z-missing); }",
      ".ss-card.is-active { z-index: var(--ss-z-raised); }",
      ":root { --ss-z-raised: 10; }",
    ].join("\n")
  );

  const report = lintCssDirectory({ cssDir: dir });
  assert.ok(
    report.issues.some((issue) => issue.message.includes("Legacy state class")),
    "legacy state grammar must fail",
  );
  assert.ok(
    report.issues.some((issue) => issue.selector === "--ss-z-missing"),
    "undefined token must fail",
  );
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

test("lintCssDirectory errors on a bare non-prefixed top-level class", () => {
  const dir = createTempCssDir();
  // A class with no ss-/systemsculpt- prefix leaks into every matching
  // element in the vault (e.g. `.mermaid` restyled EVERY mermaid diagram).
  // The migration finished — the whole tree is prefixed — so this is now a
  // hard ERROR (permanent CI guard), no longer a gradual-migration warning.
  writeCss(
    dir,
    "bare-class.css",
    [
      ".mermaid {",
      "  position: relative;",
      "}",
      "",
    ].join("\n")
  );

  const report = lintCssDirectory({ cssDir: dir });

  assert.ok(
    report.errorCount > 0,
    `a bare class must be an error, got ${report.errorCount} error(s)`
  );
  assert.ok(
    report.issues.some(
      issue => issue.severity === "error" && issue.selector === ".mermaid"
    ),
    "expected an error-severity issue for the .mermaid selector"
  );
});

test("lintCssDirectory stays silent on prefixed and prefix-scoped classes", () => {
  const dir = createTempCssDir();
  writeCss(
    dir,
    "prefixed.css",
    [
      ".ss-card {",
      "  padding: 0;",
      "}",
      ".systemsculpt-message-content .mermaid {",
      "  position: relative;",
      "}",
      ".is-open .ss-card {",
        "  padding: 0;",
      "}",
      '.workspace-leaf-content[data-type="systemsculpt-chat-view"] .mermaid {',
      "  position: relative;",
      "}",
      "",
    ].join("\n")
  );

  const report = lintCssDirectory({ cssDir: dir });

  assert.equal(report.errorCount, 0, "prefixed/scoped selectors must not error");
  assert.equal(
    report.warningCount,
    0,
    `prefixed/scoped selectors must not warn; issues:\n` +
      report.issues
        .map(issue => `  ${issue.file}:${issue.line} ${issue.selector} — ${issue.message}`)
        .join("\n")
  );
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
  assert.equal(
    report.warningCount,
    0,
    `src/css must stay warning-free too; warnings:\n` +
      report.issues
        .filter(issue => issue.severity === "warning")
        .map(issue => `  ${issue.file}:${issue.line} ${issue.message}`)
        .join("\n")
  );
  assert.ok(report.fileCount > 0, "expected to lint at least one CSS file");
});

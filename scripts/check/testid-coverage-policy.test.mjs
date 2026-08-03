import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toRepositoryPath } from "../platform-portability.mjs";

/**
 * Testid coverage ratchet.
 *
 * The canonical UI factories require a testid, so this policy watches the
 * escape hatch: raw interactive elements created with createEl. Every raw
 * `button`, `input`, `select`, or `textarea` creation must declare
 * `data-testid` in its attributes, except for the counts frozen in
 * testid-coverage.baseline.json. The baseline may only shrink: tag an element
 * and reduce the number, never raise one.
 */

const ROOT = process.cwd();
const BASELINE_PATH = path.join(ROOT, "scripts/check/testid-coverage.baseline.json");
const INTERACTIVE_CREATE_PATTERN =
  /\.createEl\(\s*["'](button|input|select|textarea)["']/g;
const FACTORY_FILES = new Set([
  // The factory stamps data-testid via button.dataset after creation.
  "src/core/ui/surface/SurfacePrimitives.ts",
]);

function listSourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "tests") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, files);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files.sort();
}

export function scanUntaggedInteractiveCreations() {
  const counts = {};
  for (const file of listSourceFiles(path.join(ROOT, "src"))) {
    const relative = toRepositoryPath(path.relative(ROOT, file));
    if (FACTORY_FILES.has(relative)) continue;
    const text = fs.readFileSync(file, "utf8");
    let untagged = 0;
    for (const match of text.matchAll(INTERACTIVE_CREATE_PATTERN)) {
      const window = text.slice(match.index, match.index + 400);
      if (!window.includes("data-testid")) untagged += 1;
    }
    if (untagged > 0) counts[relative] = untagged;
  }
  return counts;
}

test("raw interactive elements without data-testid never exceed the frozen baseline", () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const current = scanUntaggedInteractiveCreations();

  const regressions = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      regressions.push(`${file}: ${count} untagged (baseline allows ${allowed})`);
    }
  }
  assert.deepEqual(
    regressions,
    [],
    "New interactive elements must declare data-testid (dot-namespaced, " +
      "e.g. chat.composer.send). Do not raise the baseline.\n" +
      regressions.join("\n"),
  );

  const stale = [];
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = current[file] ?? 0;
    if (count < allowed) {
      stale.push(`${file}: baseline ${allowed} but only ${count} remain`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    "Coverage improved — ratchet the baseline down in " +
      "scripts/check/testid-coverage.baseline.json:\n" + stale.join("\n"),
  );
});

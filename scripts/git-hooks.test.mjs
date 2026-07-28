import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const installer = fs.readFileSync(new URL("./install-git-hooks.mjs", import.meta.url), "utf8");
const preCommit = fs.readFileSync(new URL("./git-hooks/pre-commit", import.meta.url), "utf8");
const prePush = fs.readFileSync(new URL("./git-hooks/pre-push", import.meta.url), "utf8");
const attributes = fs.readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");

test("the hook installer resolves the shared Git hook directory in linked worktrees", () => {
  assert.match(installer, /git", \["rev-parse", "--git-path", "hooks"\]/);
  assert.doesNotMatch(installer, /path\.join\(repoRoot, "\.git", "hooks"\)/);
  assert.match(installer, /normalizeLineEndings\(fs\.readFileSync\(src, "utf8"\)\)/);
});

test("pre-push runs the exact exhaustive hosted gate", () => {
  assert.match(prePush, /^#!\/usr\/bin\/env bash/);
  assert.match(prePush, /set -euo pipefail/);
  assert.match(prePush, /npm run check:ci/);
  assert.equal(packageJson.scripts["check:full"], "npm run check:ci");
});

test("pre-commit scans staged paths without shell word splitting", () => {
  assert.match(preCommit, /git diff --cached --name-only -z --diff-filter=ACM/);
  assert.match(preCommit, /while IFS= read -r -d '' file/);
  assert.match(preCommit, /printf '%s\\n' "\$file"/);
  assert.match(preCommit, /printf '%s\\n' "\$content"/);
  assert.doesNotMatch(preCommit, /for file in \$STAGED/);
});

test("repository text and executable hooks are pinned to portable line endings", () => {
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.equal(preCommit.includes("\r"), false);
  assert.equal(prePush.includes("\r"), false);
});

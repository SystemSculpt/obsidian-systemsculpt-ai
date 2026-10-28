import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRepositoryScopedGitEnvironment } from "./repository-git.mjs";

const installer = fs.readFileSync(new URL("./install-git-hooks.mjs", import.meta.url), "utf8");
const preCommit = fs.readFileSync(new URL("./git-hooks/pre-commit", import.meta.url), "utf8");
const attributes = fs.readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const globalConfig = path.join(root, "gitconfig");
  fs.writeFileSync(globalConfig, "");
  const env = { ...createRepositoryScopedGitEnvironment(), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "--quiet", root], { env });
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(path.join(scripts, "git-hooks"), { recursive: true });
  for (const file of ["install-git-hooks.mjs", "platform-portability.mjs", "repository-git.mjs"]) {
    fs.copyFileSync(new URL(`./${file}`, import.meta.url), path.join(scripts, file));
  }
  fs.writeFileSync(path.join(scripts, "git-hooks", "pre-commit"), preCommit);
  return {
    root,
    hooks: path.join(root, ".git", "hooks"),
    install: () => execFileSync(process.execPath, [path.join(scripts, "install-git-hooks.mjs")], { env }),
    git: (...args) => execFileSync("git", args, { cwd: root, env }),
    env,
  };
}

test("the hook installer resolves the shared Git hook directory in linked worktrees", () => {
  assert.match(installer, /git", \["rev-parse", "--git-path", "hooks"\]/);
  assert.doesNotMatch(installer, /path\.join\(repoRoot, "\.git", "hooks"\)/);
  assert.match(installer, /normalizeLineEndings\(fs\.readFileSync\(src, "utf8"\)\)/);
});

test("installation removes obsolete sentinel hooks but preserves custom hooks", (t) => {
  const repo = fixture(t);
  fs.writeFileSync(path.join(repo.hooks, "pre-push"), "#!/bin/sh\n# installed-by: install-git-hooks.mjs\nexit 1\n");
  const custom = "#!/bin/sh\n# adapted from pre-commit.sample\nexit 0\n";
  fs.writeFileSync(path.join(repo.hooks, "post-commit"), custom);
  repo.install();
  assert.equal(fs.existsSync(path.join(repo.hooks, "pre-push")), false);
  assert.equal(fs.readFileSync(path.join(repo.hooks, "post-commit"), "utf8"), custom);
  assert.match(fs.readFileSync(path.join(repo.hooks, "pre-commit"), "utf8"), /installed-by/);
  fs.writeFileSync(path.join(repo.hooks, "pre-push"), custom);
  repo.install();
  assert.equal(fs.readFileSync(path.join(repo.hooks, "pre-push"), "utf8"), custom);
});

test("installed pre-commit still blocks a staged GitHub token", { skip: process.platform === "win32" }, (t) => {
  const repo = fixture(t);
  repo.install();
  fs.writeFileSync(path.join(repo.root, "credential.txt"), `ghp_${"x".repeat(36)}\n`);
  repo.git("add", "credential.txt");
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "must fail"], {
    cwd: repo.root, env: repo.env, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /BLOCKED: Potential secret/);
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
  assert.equal(fs.existsSync(new URL("./git-hooks/pre-push", import.meta.url)), false);
});

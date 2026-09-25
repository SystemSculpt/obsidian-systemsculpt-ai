import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createRepositoryScopedGitEnvironment,
  execRepositoryGitSync as git,
  REPOSITORY_ROUTING_GIT_ENVIRONMENT_VARIABLES,
} from "./repository-git.mjs";

// The fixtures below use bash hooks and POSIX Git worktrees.
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const COMMIT_IDENTITY = ["-c", "user.name=Sentinel", "-c", "user.email=sentinel@example.invalid",
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ss-repository-git-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Keep user and system Git configuration (hooksPath, templates) out of the fixtures.
  const globalConfig = path.join(root, "gitconfig");
  fs.writeFileSync(globalConfig, "");
  const isolation = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  return { root, isolation };
}

function createSentinelRepository({ root, isolation }) {
  const sentinel = path.join(root, "sentinel");
  const env = { ...process.env, ...isolation };
  git(["init", "--quiet", sentinel], { env });
  fs.writeFileSync(path.join(sentinel, "keep.txt"), "sentinel\n");
  git(["-C", sentinel, "add", "keep.txt"], { env });
  git(["-C", sentinel, ...COMMIT_IDENTITY, "commit", "--quiet", "-m", "sentinel"], { env });
  const gitDir = path.join(sentinel, ".git");
  fs.mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
  // What a hook launched from a linked worktree hands its children: absolute
  // routing to the pushing repository, here a throwaway sentinel.
  const routedEnvironment = {
    ...createRepositoryScopedGitEnvironment(),
    ...isolation,
    GIT_DIR: gitDir,
    GIT_COMMON_DIR: gitDir,
    GIT_WORK_TREE: sentinel,
    GIT_INDEX_FILE: path.join(gitDir, "index"),
    GIT_PREFIX: "",
  };
  return { sentinel, gitDir, env, routedEnvironment };
}

function snapshotRepository(repository, env) {
  const read = (...args) => git(["-C", repository, ...args], { env });
  const gitDir = path.join(repository, ".git");
  return {
    config: fs.readFileSync(path.join(gitDir, "config"), "utf8"),
    head: fs.readFileSync(path.join(gitDir, "HEAD"), "utf8"),
    refs: read("for-each-ref", "--format=%(refname) %(objectname)"),
    worktrees: read("worktree", "list", "--porcelain"),
    index: createHash("sha256").update(fs.readFileSync(path.join(gitDir, "index"))).digest("hex"),
    objects: read("count-objects", "-v"),
    hooks: fs.readdirSync(path.join(gitDir, "hooks")).sort(),
    tree: fs.readdirSync(repository).sort(),
  };
}

function childEnvironment(environment) {
  const result = { ...environment };
  // A nested `node --test` would otherwise report to this runner's protocol.
  delete result.NODE_TEST_CONTEXT;
  return result;
}

test("repository scoping removes every routing variable and keeps the rest", () => {
  const inherited = { PATH: "/bin", GIT_SSH_COMMAND: "ssh", GIT_CEILING_DIRECTORIES: "/tmp",
    GIT_CONFIG_KEY_3: "core.bare", GIT_CONFIG_VALUE_3: "true", git_dir: "/lowercase" };
  for (const name of REPOSITORY_ROUTING_GIT_ENVIRONMENT_VARIABLES) inherited[name] = "/real/repository";
  assert.deepEqual(createRepositoryScopedGitEnvironment(inherited), {
    PATH: "/bin", GIT_SSH_COMMAND: "ssh", GIT_CEILING_DIRECTORIES: "/tmp",
  });
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_NAMESPACE"]) {
    assert.ok(REPOSITORY_ROUTING_GIT_ENVIRONMENT_VARIABLES.includes(name), name);
  }
});

test("fixture-creating script suites never touch the repository named by an inherited GIT_DIR", (t) => {
  const fixture = tempRoot(t);
  const { sentinel, env, routedEnvironment } = createSentinelRepository(fixture);
  const before = snapshotRepository(sentinel, env);

  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    "scripts/watcher-ownership.test.mjs",
    "scripts/dev-watcher-service.test.mjs",
    "scripts/plugin-sync.test.mjs",
  ], { cwd: repositoryRoot, encoding: "utf8", env: childEnvironment(routedEnvironment), timeout: 120_000 });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1]) > 0, result.stdout);
  assert.deepEqual(snapshotRepository(sentinel, env), before);
});

test("development build identity ignores an inherited GIT_DIR outside a repository", (t) => {
  const fixture = tempRoot(t);
  const { sentinel, env, routedEnvironment } = createSentinelRepository(fixture);
  const before = snapshotRepository(sentinel, env);
  const outside = path.join(fixture.root, "not-a-repository");
  fs.mkdirSync(outside);
  for (const name of ["manifest.json", "main.js", "styles.css"]) {
    fs.writeFileSync(path.join(outside, name), "{}\n");
  }
  const script = `
    import { createDevelopmentBuildIdentity } from ${JSON.stringify(new URL("./plugin-sync.mjs", import.meta.url).href)};
    const identity = createDevelopmentBuildIdentity({ root: process.argv[1] });
    process.stdout.write(JSON.stringify({ revision: identity.revision, branch: identity.branch, dirty: identity.dirty }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, outside], {
    encoding: "utf8", env: childEnvironment(routedEnvironment),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { revision: "0000000", branch: "detached", dirty: false });
  assert.deepEqual(snapshotRepository(sentinel, env), before);
});

test("the hook installer and installed pre-push hook ignore inherited repository routing", (t) => {
  const fixture = tempRoot(t);
  const { sentinel, env, routedEnvironment } = createSentinelRepository(fixture);
  const before = snapshotRepository(sentinel, env);
  const checkout = path.join(fixture.root, "checkout");
  git(["init", "--quiet", checkout], { env });
  fs.mkdirSync(path.join(checkout, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "scripts", "git-hooks"), { recursive: true });
  for (const file of ["install-git-hooks.mjs", "platform-portability.mjs", "repository-git.mjs",
    "git-hooks/pre-commit", "git-hooks/pre-push"]) {
    fs.copyFileSync(new URL(`./${file}`, import.meta.url), path.join(checkout, "scripts", file));
  }

  const install = spawnSync(process.execPath, [path.join(checkout, "scripts", "install-git-hooks.mjs")], {
    encoding: "utf8", env: childEnvironment(routedEnvironment),
  });
  assert.equal(install.status, 0, install.stderr);
  const installed = path.join(checkout, ".git", "hooks", "pre-push");
  assert.match(fs.readFileSync(installed, "utf8"), /# installed-by: install-git-hooks\.mjs/);
  assert.deepEqual(snapshotRepository(sentinel, env), before);

  // A stand-in npm records what `npm run check:ci` would inherit.
  const bin = path.join(fixture.root, "bin");
  const capture = path.join(fixture.root, "npm-environment.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nenv > \"$SS_NPM_CAPTURE\"\npwd >> \"$SS_NPM_CAPTURE\"\n",
    { mode: 0o755 });
  const checkoutGitDir = path.join(checkout, ".git");
  const hook = spawnSync("bash", [installed], {
    cwd: checkout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnvironment({
      ...createRepositoryScopedGitEnvironment(),
      ...fixture.isolation,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SS_NPM_CAPTURE: capture,
      GIT_DIR: checkoutGitDir,
      GIT_COMMON_DIR: checkoutGitDir,
      GIT_INDEX_FILE: path.join(checkoutGitDir, "index"),
      GIT_OBJECT_DIRECTORY: path.join(checkoutGitDir, "objects"),
      GIT_NAMESPACE: "leaked",
      GIT_PREFIX: "",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "systemsculpt.leaked",
      GIT_CONFIG_VALUE_0: "true",
      GIT_EDITOR: "true",
    }),
  });
  assert.equal(hook.status, 0, `${hook.stdout}\n${hook.stderr}`);
  const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.equal(fs.realpathSync(lines.at(-1)), checkout);
  const leaked = lines.slice(0, -1).map((line) => line.split("=")[0])
    .filter((name) => createRepositoryScopedGitEnvironment({ [name]: "" })[name] === undefined);
  assert.deepEqual(leaked, []);
  assert.ok(lines.includes("GIT_EDITOR=true"), "non-routing Git settings are preserved");
  assert.deepEqual(snapshotRepository(sentinel, env), before);
});

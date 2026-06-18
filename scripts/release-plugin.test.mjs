import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildNativeReleaseCheckArgs,
  describeNativeValidationPlan,
  parseArgs,
  parseGitHubAuthStatus,
  normalizeReleaseNotesMarkdown,
  resolveGitHubReleaseAuthStrategy,
  resolveReleaseVersionPlan,
  runWithGitHubAuthFallback,
  shouldRetryWithoutGitHubEnv,
  validateAuthoredReleaseNotesFile,
  withoutGitHubEnvTokens,
  writeNotesFile,
} from "./release-plugin.mjs";

function withGitHubToken(t, token = "test-release-scope-token") {
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = token;
  t.after(() => {
    if (previousGitHubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
      return;
    }
    process.env.GITHUB_TOKEN = previousGitHubToken;
  });
}

test("parseGitHubAuthStatus detects env-token auth and token scopes", () => {
  const parsed = parseGitHubAuthStatus(`
github.com
  ✓ Logged in to github.com account mike (GITHUB_TOKEN)
  - Token scopes: 'repo', 'read:org'
`);

  assert.equal(parsed.usesEnvToken, true);
  assert.deepEqual(parsed.scopes, ["repo", "read:org"]);
});

test("parseArgs accepts iOS canary release gate options", () => {
  assert.deepEqual(
    parseArgs([
      "--dry-run",
      "--allow-dirty",
      "--require-ios",
      "--require-ios-canary",
      "--allow-missing-ios-canary",
      " runner not provisioned yet ",
      "--bump",
      "patch",
      "--notes-file",
      "docs/release-notes/9.9.9.md",
    ]),
    {
      bump: "patch",
      version: null,
      draft: false,
      dryRun: true,
      skipChecks: false,
      allowDirty: true,
      requireIos: true,
      requireIosCanary: true,
      allowMissingIosCanaryReason: "runner not provisioned yet",
      notesFile: "docs/release-notes/9.9.9.md",
      help: false,
    },
  );
});

test("parseArgs exposes release help without running release preflights", () => {
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs rejects a missing or flag-like --allow-missing-ios-canary reason", (t) => {
  // release-plugin's fail() calls process.exit(1) instead of throwing, so stub
  // both (auto-restored by node:test) and assert the guard triggers an exit.
  t.mock.method(console, "error", () => {});
  const exit = t.mock.method(process, "exit", () => {
    throw new Error("process.exit");
  });

  assert.throws(() => parseArgs(["--allow-missing-ios-canary"]), /process\.exit/);
  assert.throws(() => parseArgs(["--allow-missing-ios-canary", "--dry-run"]), /process\.exit/);
  assert.equal(exit.mock.calls.length, 2);
});

test("normalizeReleaseNotesMarkdown unwraps wrapped prose and list items while preserving markdown structure", () => {
  const input = `# SystemSculpt 5.3.3

## What's New

This paragraph was written like commit prose and
should become a single release paragraph.

- First highlight wraps onto
  a continuation line.
- Second highlight also wraps
  and should stay a bullet.

1. Numbered step wraps onto
   the next line too.

\`\`\`sh
npm run build
npm test
\`\`\`
`;

  const normalized = normalizeReleaseNotesMarkdown(input);
  assert.equal(
    normalized,
    `# SystemSculpt 5.3.3

## What's New

This paragraph was written like commit prose and should become a single release paragraph.

- First highlight wraps onto a continuation line.
- Second highlight also wraps and should stay a bullet.

1. Numbered step wraps onto the next line too.

\`\`\`sh
npm run build
npm test
\`\`\``
  );
});

test("writeNotesFile normalizes custom notes files without mutating the source file", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-test-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sourcePath = path.join(tempDir, "wrapped-notes.md");
  const original = `## Highlights

- Wrapped bullet that should
  be flattened.

Plain paragraph line one
line two.
`;
  fs.writeFileSync(sourcePath, original, "utf8");

  const generatedPath = writeNotesFile("9.9.9", [], sourcePath);
  const generated = fs.readFileSync(generatedPath, "utf8");

  assert.notEqual(generatedPath, sourcePath);
  assert.equal(
    generated,
    `## Highlights

- Wrapped bullet that should be flattened.

Plain paragraph line one line two.
`
  );
  assert.equal(fs.readFileSync(sourcePath, "utf8"), original);
});

test("resolveReleaseVersionPlan reuses pre-bumped metadata only without explicit overrides", () => {
  const base = {
    manifestVersion: "5.5.0",
    lastTag: "5.4.0",
    versions: { "5.5.0": "1.4.0" },
    minAppVersion: "1.4.0",
    commits: [{ subject: "feat: add canvas foundation" }],
  };

  assert.deepEqual(resolveReleaseVersionPlan(base), {
    metadataAlreadyUpdated: true,
    usePreBumpedMetadata: true,
    inferredBump: "minor",
    bump: "pre-bumped",
    newVersion: "5.5.0",
  });

  assert.deepEqual(
    resolveReleaseVersionPlan({
      ...base,
      options: { bump: "patch" },
    }),
    {
      metadataAlreadyUpdated: true,
      usePreBumpedMetadata: false,
      inferredBump: "minor",
      bump: "patch",
      newVersion: "5.5.1",
    }
  );

  assert.deepEqual(
    resolveReleaseVersionPlan({
      ...base,
      options: { version: "5.6.0" },
    }),
    {
      metadataAlreadyUpdated: true,
      usePreBumpedMetadata: false,
      inferredBump: "minor",
      bump: "minor",
      newVersion: "5.6.0",
    }
  );
});

test("validateAuthoredReleaseNotesFile requires canonical notes for real releases", () => {
  assert.deepEqual(
    validateAuthoredReleaseNotesFile({
      version: "5.6.0",
      dryRun: false,
      notesFile: "docs/release-notes/5.6.0.md",
      root: process.cwd(),
    }),
    {
      ok: true,
      expectedPath: "docs/release-notes/5.6.0.md",
      relativePath: "docs/release-notes/5.6.0.md",
      problem: "",
    }
  );

  assert.match(
    validateAuthoredReleaseNotesFile({
      version: "5.6.0",
      dryRun: false,
      notesFile: "",
      root: process.cwd(),
    }).problem,
    /Real releases require authored public notes/
  );

  assert.match(
    validateAuthoredReleaseNotesFile({
      version: "5.6.0",
      dryRun: false,
      notesFile: "notes.md",
      root: process.cwd(),
    }).problem,
    /must be docs\/release-notes\/5\.6\.0\.md/
  );

  assert.deepEqual(
    validateAuthoredReleaseNotesFile({
      version: "5.6.0",
      dryRun: true,
      notesFile: "draft-notes.md",
      root: process.cwd(),
    }),
    {
      ok: true,
      expectedPath: "docs/release-notes/5.6.0.md",
      relativePath: "draft-notes.md",
      problem: "",
    }
  );
});

test("resolveGitHubReleaseAuthStrategy prefers stored gh auth when env-token auth lacks workflow scope", (t) => {
  withGitHubToken(t);

  const logs = [];
  let callIndex = 0;
  const strategy = resolveGitHubReleaseAuthStrategy({
    runCaptureImpl(_command, _args, _allowFailure, options = {}) {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          status: 0,
          stdout: "",
          stderr: `
github.com
  ✓ Logged in to github.com account mike (GITHUB_TOKEN)
  - Token scopes: 'repo'
`,
        };
      }

      assert.deepEqual(options.envOverrides, withoutGitHubEnvTokens());
      return {
        status: 0,
        stdout: "",
        stderr: `
github.com
  ✓ Logged in to github.com account mike (/tmp/gh-hosts.yml)
  - Token scopes: 'repo', 'workflow'
`,
      };
    },
    logFn(message) {
      logs.push(message);
    },
  });

  assert.equal(strategy.name, "stored-gh-auth");
  assert.deepEqual(strategy.envOverrides, withoutGitHubEnvTokens());
  assert.equal(logs.length, 1);
  assert.match(logs[0], /workflow scope/i);
});

test("shouldRetryWithoutGitHubEnv matches workflow-scope repository rejections", () => {
  assert.equal(
    shouldRetryWithoutGitHubEnv({
      status: 1,
      stdout: "",
      stderr: `
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: - Changes must have workflow scope.
`,
    }),
    true
  );

  assert.equal(
    shouldRetryWithoutGitHubEnv({
      status: 1,
      stdout: "",
      stderr: "fatal: unable to access 'https://github.com/SystemSculpt/obsidian-systemsculpt-ai.git/': Could not resolve host",
    }),
    false
  );
});

test("buildNativeReleaseCheckArgs forwards iOS release gate options", () => {
  assert.deepEqual(
    buildNativeReleaseCheckArgs({}),
    ["run", "check:release:native", "--", "--require-ios-canary"],
  );

  assert.deepEqual(
    buildNativeReleaseCheckArgs({
      requireIos: true,
      requireIosCanary: true,
      githubRef: "abc123",
      githubWaitTimeoutMs: 60000,
      githubPollIntervalMs: 5000,
    }),
    [
      "run",
      "check:release:native",
      "--",
      "--require-ios",
      "--require-ios-canary",
      "--github-ref",
      "abc123",
      "--github-wait-timeout-ms",
      "60000",
      "--github-poll-interval-ms",
      "5000",
    ],
  );

  assert.deepEqual(
    buildNativeReleaseCheckArgs({
      allowMissingIosCanaryReason: "runner not provisioned yet",
    }),
    [
      "run",
      "check:release:native",
      "--",
      "--require-ios-canary",
      "--allow-missing-ios-canary",
      "runner not provisioned yet",
    ],
  );

  assert.deepEqual(
    buildNativeReleaseCheckArgs({
      gatePhase: "local",
      requireIos: true,
      githubRef: "abc123",
    }),
    [
      "run",
      "check:release:native",
      "--",
      "--only-local",
      "--require-ios",
    ],
  );

  assert.deepEqual(
    buildNativeReleaseCheckArgs({
      gatePhase: "hosted",
      requireIos: true,
      githubRef: "abc123",
      githubWaitTimeoutMs: 60000,
    }),
    [
      "run",
      "check:release:native",
      "--",
      "--only-hosted",
      "--require-ios-canary",
      "--github-ref",
      "abc123",
      "--github-wait-timeout-ms",
      "60000",
    ],
  );
});

test("describeNativeValidationPlan exposes local iOS and canary mode", () => {
  assert.equal(
    describeNativeValidationPlan({}),
    "local macOS + Android before push; hosted Windows + iOS canary after push; local iOS when available; iOS canary required",
  );

  assert.equal(
    describeNativeValidationPlan({
      requireIos: true,
      requireIosCanary: true,
    }),
    "local macOS + Android before push; hosted Windows + iOS canary after push; local iOS required; iOS canary required",
  );

  assert.equal(
    describeNativeValidationPlan({
      allowMissingIosCanaryReason: "runner not provisioned yet",
    }),
    "local macOS + Android before push; hosted Windows + iOS canary after push; local iOS when available; iOS canary explicit override (runner not provisioned yet)",
  );
});

test("release flow validates local gates before push and hosted gates on the release SHA before tagging", () => {
  const text = fs.readFileSync(path.join(process.cwd(), "scripts", "release-plugin.mjs"), "utf8");
  const commitIndex = text.indexOf('run("git", ["commit", "-m", `release: ${newVersion}`])');
  const shaIndex = text.indexOf("const releaseSha = getHeadSha()");
  const localGateIndex = text.indexOf('gatePhase: "local"');
  const pushMainIndex = text.indexOf('runWithGitHubAuthFallback("git", ["push", "origin", "main"], githubAuthStrategy)');
  const hostedGateIndex = text.indexOf('gatePhase: "hosted"');
  const refIndex = text.indexOf("githubRef: releaseSha", hostedGateIndex);
  const hostedAuthEnvIndex = text.indexOf("envOverrides: githubAuthStrategy.envOverrides", hostedGateIndex);
  const tagIndex = text.indexOf('run("git", ["tag", "-a", newVersion, "-m", newVersion, releaseSha])');
  const pushTagIndex = text.indexOf('runWithGitHubAuthFallback("git", ["push", "origin", newVersion], githubAuthStrategy)');

  for (const [name, index] of Object.entries({
    commitIndex,
    shaIndex,
    localGateIndex,
    pushMainIndex,
    hostedGateIndex,
    refIndex,
    hostedAuthEnvIndex,
    tagIndex,
    pushTagIndex,
  })) {
    assert.notEqual(index, -1, `Expected release script to contain ${name}`);
  }

  assert.ok(commitIndex < shaIndex, "release SHA must be read after the release commit");
  assert.ok(shaIndex < localGateIndex, "local native gates must run after the final local release commit is known");
  assert.ok(localGateIndex < pushMainIndex, "local native gates must pass before pushing main");
  assert.ok(pushMainIndex < hostedGateIndex, "hosted gates must run after the release commit is pushed");
  assert.ok(refIndex > hostedGateIndex, "hosted gates must receive the release SHA");
  assert.ok(hostedAuthEnvIndex > hostedGateIndex, "hosted native gates must run with the resolved GitHub auth env");
  assert.ok(hostedGateIndex < tagIndex, "hosted gates must pass before creating the tag");
  assert.ok(tagIndex < pushTagIndex, "tag must exist locally before pushing it");
});

test("runWithGitHubAuthFallback retries once without GitHub env tokens when GitHub rejects the inherited auth", (t) => {
  withGitHubToken(t);

  const logs = [];
  const emitted = [];
  const calls = [];

  const result = runWithGitHubAuthFallback("git", ["push", "origin", "main"], {
    runImpl(_command, _args, options) {
      calls.push(options);
      if (calls.length === 1) {
        return {
          status: 1,
          stdout: "",
          stderr: `
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: - Changes must have workflow scope.
`,
        };
      }

      assert.deepEqual(options.envOverrides, withoutGitHubEnvTokens());
      return {
        status: 0,
        stdout: "main -> main",
        stderr: "",
      };
    },
    logFn(message) {
      logs.push(message);
    },
    emitFn(resultRecord) {
      emitted.push(resultRecord);
    },
  });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 2);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Retrying git push origin main without GITHUB_TOKEN\/GH_TOKEN/);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].stdout, "main -> main");
});

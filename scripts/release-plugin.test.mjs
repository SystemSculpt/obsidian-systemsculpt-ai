import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGitHubAuthStatus,
  resolveGitHubReleaseAuthStrategy,
  runWithGitHubAuthFallback,
  shouldRetryWithoutGitHubEnv,
  withoutGitHubEnvTokens,
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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseReleaseArguments,
  validateReleasePackage,
} from "./release-plugin.mjs";
import { CANONICAL_API_BASE_URL } from "./plugin-build-options.mjs";
import { assertProductionPluginArtifacts } from "./plugin-artifacts.mjs";

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "5.11.0";
  const files = {
    "manifest.json": {
      id: "systemsculpt-ai",
      version,
      minAppVersion: "1.8.0",
      isDesktopOnly: false,
    },
    "package.json": { name: "systemsculpt-ai", version },
    "package-lock.json": { version, packages: { "": { version } } },
    "versions.json": { [version]: "1.8.0" },
    ...overrides,
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`);
  }
  fs.writeFileSync(
    path.join(root, "main.js"),
    `const SYSTEMSCULPT_API = ${JSON.stringify(CANONICAL_API_BASE_URL)};\n`,
  );
  fs.writeFileSync(path.join(root, "styles.css"), "production\n");
  return root;
}

function validateFixtureRelease(options = {}) {
  return validateReleasePackage({
    requireClean: false,
    requireTag: false,
    buildImpl: ({ root }) => assertProductionPluginArtifacts({ root }),
    ...options,
  });
}

test("validates one semantic version and exactly the three plugin artifacts", (t) => {
  const root = fixture(t);
  const result = validateFixtureRelease({ root });
  assert.equal(result.version, "5.11.0");
  assert.deepEqual(result.files, ["manifest.json", "main.js", "styles.css"]);
  assert.equal(result.provenance.record.version, "5.11.0");
  assert.equal(result.provenance.record.artifacts["main.js"].sha256.length, 64);
  assert.equal(fs.existsSync(result.provenance.path), true);
});

test("rejects inconsistent package versions", (t) => {
  const root = fixture(t, { "package.json": { name: "systemsculpt-ai", version: "5.10.0" } });
  assert.throws(() => validateFixtureRelease({ root }), /package\.json version/);
});

test("runs the production builder before validating artifacts", (t) => {
  const root = fixture(t);
  let called = false;
  validateFixtureRelease({
    root,
    buildImpl(options) {
      called = options.root === root;
      return { ok: true };
    },
  });
  assert.equal(called, true);
});

test("records provenance only after artifact validation succeeds", (t) => {
  const root = fixture(t);
  const calls = [];
  validateFixtureRelease({
    root,
    provenanceImpl(options) {
      calls.push(options);
      return {
        path: "evidence.json",
        record: {
          version: options.version,
          artifacts: Object.fromEntries(
            ["manifest.json", "main.js", "styles.css"].map((fileName) => [
              fileName,
              { exists: true, sizeBytes: 1, sha256: "b".repeat(64) },
            ]),
          ),
        },
      };
    },
  });

  assert.deepEqual(calls, [{ root, version: "5.11.0", kind: "release" }]);
});

test("release identity can require one clean full revision and matching tag", (t) => {
  const root = fixture(t);
  const revision = "a".repeat(40);
  let resolvedTag;
  const result = validateFixtureRelease({
    root,
    expectedRevision: revision,
    expectedTag: "5.11.0",
    requireClean: true,
    requireTag: true,
    resolveTagRevisionImpl(options) {
      resolvedTag = options;
      return revision;
    },
    provenanceImpl() {
      return {
        path: "evidence.json",
        record: {
          git: { revision, dirty: false },
          artifacts: Object.fromEntries(
            ["manifest.json", "main.js", "styles.css"].map((fileName) => [
              fileName,
              { exists: true, sizeBytes: 1, sha256: "b".repeat(64) },
            ]),
          ),
        },
      };
    },
  });

  assert.equal(result.provenance.record.git.revision, revision);
  assert.deepEqual(resolvedTag, { root, tag: "5.11.0" });
});

test("release validation is strict by default and requires a real version tag", (t) => {
  const root = fixture(t);
  assert.throws(
    () => validateReleasePackage({
      root,
      buildImpl: ({ root: fixtureRoot }) => assertProductionPluginArtifacts({
        root: fixtureRoot,
      }),
    }),
    /release tag 5\.11\.0 must resolve to one full Git revision/,
  );
});

test("release identity rejects dirty, unresolved, or unexpected revisions", (t) => {
  const root = fixture(t);
  const artifacts = Object.fromEntries(
    ["manifest.json", "main.js", "styles.css"].map((fileName) => [
      fileName,
      { exists: true, sizeBytes: 1, sha256: "b".repeat(64) },
    ]),
  );
  const provenance = (git) => () => ({
    path: "evidence.json",
    record: { git, artifacts },
  });

  assert.throws(
    () => validateFixtureRelease({
      root,
      requireClean: true,
      provenanceImpl: provenance({ revision: "a".repeat(40), dirty: true }),
    }),
    /clean Git worktree/,
  );
  assert.throws(
    () => validateFixtureRelease({
      root,
      requireClean: true,
      provenanceImpl: provenance({ revision: "unknown", dirty: false }),
    }),
    /full Git revision/,
  );
  assert.throws(
    () => validateFixtureRelease({
      root,
      expectedRevision: "a".repeat(40),
      provenanceImpl: provenance({ revision: "b".repeat(40), dirty: false }),
    }),
    /does not match expected/,
  );
  assert.throws(
    () => validateFixtureRelease({
      root,
      requireTag: true,
      resolveTagRevisionImpl: () => "a".repeat(40),
      provenanceImpl: provenance({ revision: "b".repeat(40), dirty: false }),
    }),
    /does not match tag 5\.11\.0/,
  );
});

test("release identity rejects mismatched tags and incomplete artifact hashes", (t) => {
  const root = fixture(t);
  assert.throws(
    () => validateFixtureRelease({
      root,
      expectedTag: "5.11.1",
    }),
    /does not match manifest\.json version/,
  );
  assert.throws(
    () => validateFixtureRelease({
      root,
      provenanceImpl() {
        return {
          path: "evidence.json",
          record: {
            git: { revision: "a".repeat(40), dirty: false },
            artifacts: {
              "manifest.json": { exists: true, sizeBytes: 1, sha256: "b".repeat(64) },
              "main.js": { exists: true, sizeBytes: 1, sha256: null },
              "styles.css": { exists: true, sizeBytes: 1, sha256: "b".repeat(64) },
            },
          },
        };
      },
    }),
    /incomplete for main\.js/,
  );
});

test("release CLI flags preserve exact identity requirements", () => {
  assert.deepEqual(
    parseReleaseArguments([
      "--require-clean",
      "--require-tag",
      `--expected-revision=${"a".repeat(40)}`,
      "--expected-tag=5.11.0",
    ]),
    {
      requireClean: true,
      requireTag: true,
      expectedRevision: "a".repeat(40),
      expectedTag: "5.11.0",
    },
  );
  assert.throws(() => parseReleaseArguments(["--no-build"]), /Unknown argument/);
  assert.throws(() => parseReleaseArguments(["--unknown"]), /Unknown argument/);
});

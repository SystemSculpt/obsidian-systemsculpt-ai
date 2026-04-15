import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectReleaseSurfaces,
  REQUIRED_RELEASE_SOURCE_FILES,
  REQUIRED_VERSION_FILES,
} from "./check-release-surfaces.mjs";

function createReleaseRoot(version = "9.9.9") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-release-surfaces-"));
  fs.mkdirSync(path.join(root, "docs", "release-notes"), { recursive: true });

  fs.writeFileSync(path.join(root, "LICENSE"), "MIT\n", "utf8");
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({
      id: "systemsculpt-ai",
      name: "SystemSculpt AI",
      version,
      minAppVersion: "1.4.0",
    }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "obsidian-systemsculpt-ai", version }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: "obsidian-systemsculpt-ai",
      version,
      packages: {
        "": {
          name: "obsidian-systemsculpt-ai",
          version,
        },
      },
    }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "versions.json"),
    JSON.stringify({ [version]: "1.4.0" }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    [
      `- Plugin version: \`${version}\``,
      "- Minimum Obsidian version: `1.4.0`",
      `![Version](https://img.shields.io/badge/version-${version}-blue.svg)`,
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "docs", "release-notes", `${version}.md`),
    `# SystemSculpt ${version}\n\n## What's New\n\nA small release.\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    [
      "main.js",
      "styles.css",
      "artifacts/",
      ".env",
      ".env.*",
      "config.json",
      "",
    ].join("\n"),
    "utf8"
  );

  return root;
}

test("release surface constants name the exact required source and version files", () => {
  assert.deepEqual(REQUIRED_RELEASE_SOURCE_FILES, [
    "README.md",
    "LICENSE",
    "manifest.json",
    "package.json",
    "package-lock.json",
    "versions.json",
  ]);
  assert.deepEqual(REQUIRED_VERSION_FILES, [
    "manifest.json",
    "package.json",
    "package-lock.json",
    "versions.json",
    "README.md",
  ]);
});

test("inspectReleaseSurfaces accepts synchronized metadata and release notes", () => {
  const root = createReleaseRoot("9.9.9");
  const result = inspectReleaseSurfaces({
    root,
    version: "9.9.9",
    requireNotes: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetVersion, "9.9.9");
  assert.equal(result.notesPath, path.join("docs", "release-notes", "9.9.9.md"));
  assert.deepEqual(result.problems, []);
});

test("inspectReleaseSurfaces rejects drift across version-bearing files", () => {
  const root = createReleaseRoot("9.9.9");
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: "obsidian-systemsculpt-ai",
      version: "9.9.8",
      packages: {
        "": {
          name: "obsidian-systemsculpt-ai",
          version: "9.9.8",
        },
      },
    }, null, 2),
    "utf8"
  );

  const result = inspectReleaseSurfaces({
    root,
    version: "9.9.9",
    requireNotes: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /package-lock\.json root version is 9\.9\.8/);
  assert.match(result.problems.join("\n"), /packages\[""\]\.version is 9\.9\.8/);
});

test("inspectReleaseSurfaces requires the public release notes file when requested", () => {
  const root = createReleaseRoot("9.9.9");
  fs.rmSync(path.join(root, "docs", "release-notes", "9.9.9.md"));

  const result = inspectReleaseSurfaces({
    root,
    version: "9.9.9",
    requireNotes: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /Release notes file is missing/);
});

test("inspectReleaseSurfaces reports missing JSON files once", () => {
  const root = createReleaseRoot("9.9.9");
  fs.rmSync(path.join(root, "manifest.json"));

  const result = inspectReleaseSurfaces({
    root,
    version: "9.9.9",
    requireNotes: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /Required release source file is missing: manifest\.json/);
  assert.doesNotMatch(result.problems.join("\n"), /manifest\.json is not valid JSON/);
});

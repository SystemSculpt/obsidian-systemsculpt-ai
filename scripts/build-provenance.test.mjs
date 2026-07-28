import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createBuildProvenance,
  writeArtifactInspectionEvidence,
  writeBuildProvenance,
} from "./build-provenance.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "manifest.json"), '{"version":"6.2.6"}\n');
  fs.writeFileSync(path.join(root, "main.js"), "main bytes\n");
  fs.writeFileSync(path.join(root, "styles.css"), "style bytes\n");
  return root;
}

function gitFixture(command, args) {
  assert.equal(command, "git");
  const operation = args.slice(2).join(" ");
  if (operation === "rev-parse HEAD") return { status: 0, stdout: "a".repeat(40) };
  if (operation === "branch --show-current") return { status: 0, stdout: "main\n" };
  if (operation === "status --porcelain --untracked-files=normal") {
    return { status: 0, stdout: " M src/main.ts\n" };
  }
  return { status: 1, stdout: "" };
}

test("records exact artifact bytes and source identity without secrets", (t) => {
  const root = fixture(t);
  const record = createBuildProvenance({
    root,
    version: "6.2.6",
    kind: "release",
    recordedAt: "2026-07-28T12:00:00.000Z",
    nodeVersion: "v22.18.0",
    platform: "linux",
    arch: "x64",
    spawnSyncImpl: gitFixture,
  });

  assert.deepEqual(record.git, {
    revision: "a".repeat(40),
    branch: "main",
    dirty: true,
  });
  assert.equal(record.recordedAt, "2026-07-28T12:00:00.000Z");
  assert.equal(record.artifacts["main.js"].isRegularFile, true);
  assert.equal(record.artifacts["main.js"].isSymbolicLink, false);
  assert.equal(record.artifacts["main.js"].sizeBytes, Buffer.byteLength("main bytes\n"));
  assert.equal(
    record.artifacts["main.js"].sha256,
    createHash("sha256").update("main bytes\n").digest("hex"),
  );
  assert.deepEqual(Object.keys(record.artifacts), ["manifest.json", "main.js", "styles.css"]);
  assert.equal(record.artifacts["styles.css"].sha256?.length, 64);
});

test("writes provenance and sanitized artifact inspection as atomic JSON sidecars", (t) => {
  const root = fixture(t);
  const provenancePath = path.join(root, "evidence", "provenance.json");
  const provenance = writeBuildProvenance({
    root,
    version: "6.2.6",
    outputPath: provenancePath,
    spawnSyncImpl: gitFixture,
  });
  assert.equal(provenance.path, provenancePath);
  assert.equal(JSON.parse(fs.readFileSync(provenancePath, "utf8")).version, "6.2.6");

  const inspectionPath = path.join(root, "evidence", "inspection.json");
  const evidence = writeArtifactInspectionEvidence({
    root,
    outputPath: inspectionPath,
    inspection: {
      ok: true,
      missingFiles: [],
      problems: [],
      manifestMobileCompatible: true,
      files: {
        "main.js": {
          path: path.join(root, "main.js"),
          exists: true,
          isRegularFile: true,
          isSymbolicLink: false,
          sizeBytes: 11,
        },
      },
      mainBundle: {
        path: path.join(root, "main.js"),
        hasInlineSourceMap: false,
        hasCanonicalApiBase: true,
      },
    },
  });
  const parsed = JSON.parse(fs.readFileSync(evidence.path, "utf8"));
  assert.equal(parsed.mainBundle.path, undefined);
  assert.equal(parsed.mainBundle.hasCanonicalApiBase, true);
  assert.deepEqual(parsed.files["main.js"], {
    exists: true,
    isRegularFile: true,
    isSymbolicLink: false,
    sizeBytes: 11,
  });
});

test("missing artifacts stay explicit in provenance instead of disappearing", (t) => {
  const root = fixture(t);
  fs.rmSync(path.join(root, "styles.css"));
  const record = createBuildProvenance({
    root,
    version: "6.2.6",
    spawnSyncImpl: gitFixture,
  });
  assert.deepEqual(record.artifacts["styles.css"], {
    exists: false,
    isRegularFile: false,
    isSymbolicLink: false,
    sizeBytes: null,
    sha256: null,
  });
});

test("provenance refuses to read or hash a symlinked artifact", (t) => {
  const root = fixture(t);
  const mainPath = path.join(root, "main.js");
  const outsidePath = path.join(root, "outside-secret.txt");
  fs.writeFileSync(outsidePath, "must not enter provenance\n");
  fs.rmSync(mainPath);
  fs.symlinkSync(outsidePath, mainPath);

  const record = createBuildProvenance({
    root,
    version: "6.2.6",
    spawnSyncImpl: gitFixture,
  });

  assert.deepEqual(record.artifacts["main.js"], {
    exists: true,
    isRegularFile: false,
    isSymbolicLink: true,
    sizeBytes: null,
    sha256: null,
  });
  assert.equal(fs.readFileSync(outsidePath, "utf8"), "must not enter provenance\n");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertProductionPluginArtifacts,
  buildProductionPlugin,
  inspectPluginArtifacts,
} from "./plugin-artifacts.mjs";

function createTempPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-plugin-artifacts-"));
}

function writeRequiredArtifacts(root, mainJsContents) {
  fs.writeFileSync(path.join(root, "manifest.json"), '{"id":"systemsculpt-ai"}\n', "utf8");
  fs.writeFileSync(path.join(root, "styles.css"), "body {}\n", "utf8");
  fs.writeFileSync(path.join(root, "main.js"), mainJsContents, "utf8");
}

test("inspectPluginArtifacts reports missing required files", () => {
  const root = createTempPluginDir();
  const inspection = inspectPluginArtifacts({ root });

  assert.equal(inspection.ok, false);
  assert.deepEqual(inspection.missingFiles.sort(), ["main.js", "manifest.json", "styles.css"]);
});

test("assertProductionPluginArtifacts rejects inline sourcemap bundles", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(
    root,
    "console.log('dev build');\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,AAAA\n"
  );

  assert.throws(
    () => assertProductionPluginArtifacts({ root }),
    /inline source map/i
  );
});

test("assertProductionPluginArtifacts accepts production-style bundles", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(root, "console.log('production build');\n");

  const inspection = assertProductionPluginArtifacts({ root });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.mainBundle.hasInlineSourceMap, false);
});

test("buildProductionPlugin revalidates the post-build artifact set", () => {
  const root = createTempPluginDir();

  const inspection = buildProductionPlugin({
    root,
    stdio: "pipe",
    spawnSyncImpl(command, args, options) {
      assert.equal(command, "npm");
      assert.deepEqual(args, ["run", "build"]);
      assert.equal(options.cwd, root);
      writeRequiredArtifacts(root, "console.log('rebuilt bundle');\n");
      return {
        status: 0,
        stdout: "",
        stderr: "",
      };
    },
  });

  assert.equal(inspection.ok, true);
  assert.equal(inspection.mainBundle.hasInlineSourceMap, false);
});

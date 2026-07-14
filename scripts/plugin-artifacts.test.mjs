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
import { CANONICAL_API_BASE_URL } from "./plugin-build-options.mjs";

function createTempPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-plugin-artifacts-"));
}

function productionBundle(contents = "") {
  return `const SYSTEMSCULPT_API = ${JSON.stringify(CANONICAL_API_BASE_URL)};\n${contents}`;
}

function writeRequiredArtifacts(root, mainJsContents = productionBundle()) {
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    '{"id":"systemsculpt-ai","isDesktopOnly":false}\n',
    "utf8",
  );
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
    productionBundle(
      "console.log('dev build');\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,AAAA\n",
    ),
  );

  assert.throws(
    () => assertProductionPluginArtifacts({ root }),
    /inline source map/i
  );
});

test("assertProductionPluginArtifacts accepts production-style bundles", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(root, productionBundle("console.log('production build');\n"));

  const inspection = assertProductionPluginArtifacts({ root });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.mainBundle.hasInlineSourceMap, false);
  assert.equal(inspection.mainBundle.hasCanonicalApiBase, true);
  assert.equal(inspection.mainBundle.hasRetiredApiHost, false);
  assert.deepEqual(inspection.mainBundle.loopbackApiBases, []);
  assert.deepEqual(inspection.mainBundle.forbiddenClientFragments, []);
  assert.deepEqual(inspection.mainBundle.mobileUnsafeNodeRequires, []);
  assert.equal(inspection.manifestMobileCompatible, true);
});

test("assertProductionPluginArtifacts rejects a desktop-only manifest", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(root);
  fs.writeFileSync(path.join(root, "manifest.json"), '{"id":"systemsculpt-ai","isDesktopOnly":true}\n');

  assert.throws(
    () => assertProductionPluginArtifacts({ root }),
    /advertise Obsidian Mobile support/i,
  );
});

test("assertProductionPluginArtifacts rejects Node builtins outside the desktop host seam", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(root, productionBundle('const http = require("node:http");\n'));

  assert.throws(
    () => assertProductionPluginArtifacts({ root }),
    /loads Node builtins outside the desktop host seam: node:http/i,
  );
});

test("assertProductionPluginArtifacts requires the canonical managed API base", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(root, "console.log('missing managed API base');\n");

  assert.throws(
    () => assertProductionPluginArtifacts({ root }),
    /does not contain the canonical SystemSculpt API base/i,
  );
});

test("assertProductionPluginArtifacts rejects loopback QA API bases", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(
    root,
    productionBundle('const QA_API = "http://127.0.0.1:3001/api/plugin";\n'),
  );

  assert.throws(
    () => assertProductionPluginArtifacts({ root }),
    /loopback QA API base/i,
  );
});

test("assertProductionPluginArtifacts rejects the retired API subdomain", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(
    root,
    productionBundle('const RETIRED_API = "https://api.systemsculpt.com/api/v1";\n'),
  );

  assert.throws(
    () => assertProductionPluginArtifacts({ root }),
    /retired SystemSculpt API host/i,
  );
});

test("assertProductionPluginArtifacts rejects retired client runtimes and provider SDKs", () => {
  const root = createTempPluginDir();
  writeRequiredArtifacts(
    root,
    productionBundle("// node_modules/@anthropic-ai/sdk/index.js\n"),
  );

  assert.throws(
    () => assertProductionPluginArtifacts({ root }),
    /still bundles a provider SDK/i,
  );
});

test("buildProductionPlugin revalidates the post-build artifact set", () => {
  const root = createTempPluginDir();

  const inspection = buildProductionPlugin({
    root,
    stdio: "pipe",
    env: {
      SYSTEMSCULPT_API_BASE_URL: "http://127.0.0.1:3001/api/plugin",
    },
    spawnSyncImpl(command, args, options) {
      assert.equal(command, "npm");
      assert.deepEqual(args, ["run", "build"]);
      assert.equal(options.cwd, root);
      assert.equal(options.env.SYSTEMSCULPT_API_BASE_URL, CANONICAL_API_BASE_URL);
      writeRequiredArtifacts(root, productionBundle("console.log('rebuilt bundle');\n"));
      return {
        status: 0,
        stdout: "",
        stderr: "",
      };
    },
  });

  assert.equal(inspection.ok, true);
  assert.equal(inspection.mainBundle.hasInlineSourceMap, false);
  assert.equal(inspection.mainBundle.hasCanonicalApiBase, true);
});

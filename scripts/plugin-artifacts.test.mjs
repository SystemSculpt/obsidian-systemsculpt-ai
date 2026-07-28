import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertSafePluginArtifactPathsForBuild,
  assertProductionPluginArtifacts,
  buildProductionPlugin,
  inspectPluginArtifacts,
} from "./plugin-artifacts.mjs";
import { buildCssArtifact } from "./build-css.mjs";
import { CANONICAL_API_BASE_URL } from "./plugin-build-options.mjs";

function createTempPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-plugin-artifacts-"));
}

function productionBundle(contents = "") {
  return `const SYSTEMSCULPT_API = ${JSON.stringify(CANONICAL_API_BASE_URL)};\n${contents}`;
}

function writeManifest(root) {
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    '{"id":"systemsculpt-ai","isDesktopOnly":false}\n',
    "utf8",
  );
}

function writeRequiredArtifacts(root, mainJsContents = productionBundle()) {
  writeManifest(root);
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
  assert.equal(inspection.stylesBundle.hasBuildFailureSentinel, false);
  assert.equal(inspection.stylesBundle.isEffectivelyEmpty, false);
  assert.equal(inspection.manifestMobileCompatible, true);
});

test("artifact inspection rejects symlinked required files without trusting their targets", (t) => {
  for (const fileName of ["manifest.json", "main.js", "styles.css"]) {
    const root = createTempPluginDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeRequiredArtifacts(root);
    const artifactPath = path.join(root, fileName);
    const outsidePath = path.join(root, `${fileName}.outside`);
    fs.writeFileSync(outsidePath, fs.readFileSync(artifactPath));
    fs.rmSync(artifactPath);
    fs.symlinkSync(outsidePath, artifactPath);

    const inspection = inspectPluginArtifacts({ root });
    assert.equal(inspection.ok, false);
    assert.equal(inspection.files[fileName].isSymbolicLink, true);
    assert.equal(inspection.files[fileName].isRegularFile, false);
    assert.match(
      inspection.problems.join("\n"),
      new RegExp(`${fileName.replace(".", "\\.")} must be a regular file`),
    );
    assert.throws(
      () => assertProductionPluginArtifacts({ root }),
      /must be a regular file and must not be a symbolic link/,
    );
  }
});

test("production build rejects unsafe artifact paths before spawning the builder", (t) => {
  const root = createTempPluginDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRequiredArtifacts(root);
  const mainPath = path.join(root, "main.js");
  const outsidePath = path.join(root, "outside.js");
  fs.writeFileSync(outsidePath, "outside remains unchanged\n");
  fs.rmSync(mainPath);
  fs.symlinkSync(outsidePath, mainPath);
  let spawned = false;

  assert.throws(
    () => buildProductionPlugin({
      root,
      spawnSyncImpl() {
        spawned = true;
        return { status: 0 };
      },
    }),
    /main\.js must be a regular file and must not be a symbolic link/,
  );
  assert.equal(spawned, false);
  assert.equal(fs.readFileSync(outsidePath, "utf8"), "outside remains unchanged\n");
  assert.throws(
    () => assertSafePluginArtifactPathsForBuild({ root }),
    /main\.js must be a regular file and must not be a symbolic link/,
  );
});

for (const [label, styles, expected] of [
  ["failure sentinel", "/* CSS build failed */\n", /CSS build failure sentinel/i],
  ["empty output", "", /no effective CSS/i],
  ["comment-only output", "/* generated but empty */\n", /no effective CSS/i],
]) {
  test(`assertProductionPluginArtifacts rejects ${label} styles`, () => {
    const root = createTempPluginDir();
    writeRequiredArtifacts(root);
    fs.writeFileSync(path.join(root, "styles.css"), styles, "utf8");

    assert.throws(() => assertProductionPluginArtifacts({ root }), expected);
  });
}

test("production CSS builds fail closed on missing imports and normalize source line endings", () => {
  const root = createTempPluginDir();
  const cssRoot = path.join(root, "css");
  const indexPath = path.join(cssRoot, "index.css");
  const outputPath = path.join(root, "styles.css");
  fs.mkdirSync(cssRoot, { recursive: true });
  fs.writeFileSync(indexPath, "@import 'present.css';\r\n", "utf8");
  fs.writeFileSync(path.join(cssRoot, "present.css"), ".present {\r\n  color: red;\r\n}\r\n", "utf8");

  const first = buildCssArtifact({
    indexPath,
    outputPath,
    production: true,
    logger: {},
  });
  const second = buildCssArtifact({
    indexPath,
    outputPath,
    production: true,
    logger: {},
  });
  assert.equal(first.includes("\r"), false);
  assert.equal(second, first);
  assert.equal(fs.readFileSync(outputPath, "utf8"), first);

  fs.writeFileSync(indexPath, "@import 'missing.css';\n", "utf8");
  assert.throws(
    () => buildCssArtifact({
      indexPath,
      outputPath,
      production: true,
      logger: {},
    }),
    /Missing CSS imports: missing\.css/,
  );
  assert.equal(fs.readFileSync(outputPath, "utf8"), first);
});

test("production CSS builds never replace output with a failure sentinel", () => {
  const root = createTempPluginDir();
  const outputPath = path.join(root, "styles.css");
  fs.writeFileSync(outputPath, ".known-good {}\n", "utf8");

  assert.throws(
    () => buildCssArtifact({
      indexPath: path.join(root, "missing-index.css"),
      outputPath,
      production: true,
      logger: {},
    }),
    /CSS entry file missing/,
  );
  assert.equal(fs.readFileSync(outputPath, "utf8"), ".known-good {}\n");
});

test("development CSS failures preserve a prior good output", () => {
  const root = createTempPluginDir();
  const outputPath = path.join(root, "styles.css");
  fs.writeFileSync(outputPath, ".known-good {}\n", "utf8");

  assert.equal(
    buildCssArtifact({
      indexPath: path.join(root, "missing-index.css"),
      outputPath,
      production: false,
      logger: {},
    }),
    null,
  );
  assert.equal(fs.readFileSync(outputPath, "utf8"), ".known-good {}\n");
});

test("CSS imports reject absolute and traversal paths without reading outside the source root", (t) => {
  const root = createTempPluginDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cssRoot = path.join(root, "css");
  const indexPath = path.join(cssRoot, "index.css");
  const outputPath = path.join(root, "styles.css");
  const outsidePath = path.join(root, "outside.css");
  fs.mkdirSync(cssRoot, { recursive: true });
  fs.writeFileSync(outsidePath, ".outside-secret {}\n", "utf8");

  for (const importPath of ["../outside.css", outsidePath]) {
    fs.writeFileSync(indexPath, `@import ${JSON.stringify(importPath)};\n`, "utf8");
    fs.writeFileSync(outputPath, ".known-good {}\n", "utf8");

    assert.throws(
      () => buildCssArtifact({
        indexPath,
        outputPath,
        production: true,
        logger: {},
      }),
      /CSS import must be a relative path without traversal/,
    );
    assert.equal(fs.readFileSync(outputPath, "utf8"), ".known-good {}\n");
    assert.equal(fs.readFileSync(outsidePath, "utf8"), ".outside-secret {}\n");
  }
});

test("CSS imports reject a symlink escape without embedding or changing the outside file", (t) => {
  const root = createTempPluginDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cssRoot = path.join(root, "css");
  const indexPath = path.join(cssRoot, "index.css");
  const outputPath = path.join(root, "styles.css");
  const outsideRoot = path.join(root, "outside");
  const outsidePath = path.join(outsideRoot, "outside.css");
  fs.mkdirSync(cssRoot, { recursive: true });
  fs.mkdirSync(outsideRoot);
  fs.writeFileSync(indexPath, '@import "linked/outside.css";\n', "utf8");
  fs.writeFileSync(outputPath, ".known-good {}\n", "utf8");
  fs.writeFileSync(outsidePath, ".outside-secret {}\n", "utf8");
  fs.symlinkSync(outsideRoot, path.join(cssRoot, "linked"), "dir");

  assert.throws(
    () => buildCssArtifact({
      indexPath,
      outputPath,
      production: true,
      logger: {},
    }),
    /CSS import must resolve to a regular file inside the CSS source root/,
  );
  assert.equal(fs.readFileSync(outputPath, "utf8"), ".known-good {}\n");
  assert.equal(fs.readFileSync(outsidePath, "utf8"), ".outside-secret {}\n");
});

test("CSS output rejects an existing symlink without changing its outside target", (t) => {
  const root = createTempPluginDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cssRoot = path.join(root, "css");
  const indexPath = path.join(cssRoot, "index.css");
  const outputPath = path.join(root, "styles.css");
  const outsidePath = path.join(root, "outside.css");
  fs.mkdirSync(cssRoot, { recursive: true });
  fs.writeFileSync(indexPath, '@import "present.css";\n', "utf8");
  fs.writeFileSync(path.join(cssRoot, "present.css"), ".present {}\n", "utf8");
  fs.writeFileSync(outsidePath, ".outside-target {}\n", "utf8");
  fs.symlinkSync(outsidePath, outputPath);

  assert.throws(
    () => buildCssArtifact({
      indexPath,
      outputPath,
      production: true,
      logger: {},
    }),
    /CSS output must be absent or an existing regular file/,
  );
  assert.equal(fs.lstatSync(outputPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outsidePath, "utf8"), ".outside-target {}\n");
});

test("CSS output rejects an existing non-regular path", (t) => {
  const root = createTempPluginDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cssRoot = path.join(root, "css");
  const indexPath = path.join(cssRoot, "index.css");
  const outputPath = path.join(root, "styles.css");
  fs.mkdirSync(cssRoot, { recursive: true });
  fs.writeFileSync(indexPath, '@import "present.css";\n', "utf8");
  fs.writeFileSync(path.join(cssRoot, "present.css"), ".present {}\n", "utf8");
  fs.mkdirSync(outputPath);

  assert.throws(
    () => buildCssArtifact({
      indexPath,
      outputPath,
      production: true,
      logger: {},
    }),
    /CSS output must be absent or an existing regular file/,
  );
  assert.equal(fs.statSync(outputPath).isDirectory(), true);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt plugin artifacts-"));
  writeManifest(root);

  const inspection = buildProductionPlugin({
    root,
    stdio: "pipe",
    env: {
      SYSTEMSCULPT_API_BASE_URL: "http://127.0.0.1:3001/api/plugin",
    },
    spawnSyncImpl(command, args, options) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [path.join(root, "esbuild.config.mjs"), "production"]);
      assert.equal(options.cwd, root);
      assert.equal(options.env.SYSTEMSCULPT_API_BASE_URL, CANONICAL_API_BASE_URL);
      assert.equal(options.shell, undefined);
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

test("buildProductionPlugin preserves child-process infrastructure failures", () => {
  const root = createTempPluginDir();
  writeManifest(root);
  const infrastructureFailure = new Error("could not start the build runtime");

  assert.throws(
    () => buildProductionPlugin({
      root,
      stdio: "pipe",
      spawnSyncImpl() {
        return { error: infrastructureFailure };
      },
    }),
    (error) => error === infrastructureFailure,
  );
});

test("buildProductionPlugin preserves failed build diagnostics", () => {
  const root = createTempPluginDir();
  writeManifest(root);

  assert.throws(
    () => buildProductionPlugin({
      root,
      stdio: "pipe",
      spawnSyncImpl() {
        return {
          status: 1,
          stdout: "build stdout",
          stderr: "build stderr",
        };
      },
    }),
    /Production plugin build failed\.\nbuild stderr\nbuild stdout/,
  );
});

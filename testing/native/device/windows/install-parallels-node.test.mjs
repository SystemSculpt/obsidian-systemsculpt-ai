import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFinalizeNodeInstallScript,
  buildResolveNodeReleaseScript,
  parseArgs,
} from "./install-parallels-node.mjs";

test("parseArgs accepts Parallels node install overrides", () => {
  const parsed = parseArgs([
    "--vm-name",
    "Windows 11",
    "--node-exe",
    "C:/Users/Public/SystemSculpt/nodejs/node.exe",
    "--major",
    "22",
  ]);

  assert.equal(parsed.vmName, "Windows 11");
  assert.equal(parsed.nodeExe, "C:/Users/Public/SystemSculpt/nodejs/node.exe");
  assert.equal(parsed.major, 22);
});

test("buildResolveNodeReleaseScript queries the requested Node major", () => {
  const script = buildResolveNodeReleaseScript({ major: 20 });

  assert.match(script, /nodejs\.org\/dist\/index\.json/);
  assert.match(script, /\$major = 20/);
  assert.match(script, /win-' \+ \$nodeArch \+ '-zip/);
});

test("buildFinalizeNodeInstallScript verifies node.exe and updates PATH", () => {
  const script = buildFinalizeNodeInstallScript({
    installDir: "C:/Users/Public/SystemSculpt/nodejs",
    nodeExe: "C:/Users/Public/SystemSculpt/nodejs/node.exe",
    downloadDir: "C:/Windows/Temp/systemsculpt-node-test",
  });

  assert.match(script, /Installed node\.exe missing/);
  assert.match(script, /Path', 'User'/);
  assert.match(script, /\$version = \(& \$nodeExe --version\)\.Trim\(\)/);
});

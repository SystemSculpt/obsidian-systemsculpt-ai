import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.join(new URL("../..", import.meta.url).pathname);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const liveScripts = Object.entries(packageJson.scripts).filter(([name]) =>
  name.startsWith("qa:chatview:live"),
);

test("every guarded live QA phase resolves to a real scenario module", async () => {
  assert.ok(liveScripts.length > 0, "expected qa:chatview:live scripts");
  for (const [name, command] of liveScripts) {
    const match = /e2e\.mjs script (\S+\.mjs)/.exec(command);
    assert.ok(match, `${name} must run a scenario through scripts/e2e/e2e.mjs`);
    const scenarioPath = path.join(root, match[1]);
    assert.equal(fs.existsSync(scenarioPath), true, `${name}: ${match[1]} must exist`);
    const module = await import(pathToFileURL(scenarioPath).href);
    assert.equal(
      Object.values(module).some((value) => value !== undefined && value !== null),
      true,
      `${name}: ${match[1]} must export a scenario`,
    );
  }
});

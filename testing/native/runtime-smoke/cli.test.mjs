import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "./cli.mjs";

test("parseArgs exposes the required hosted-auth smoke option", () => {
  const options = parseArgs(["--mode", "ios", "--require-hosted-auth"]);

  assert.equal(options.mode, "ios");
  assert.equal(options.requireHostedAuth, true);
});

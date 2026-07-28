import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLineEndings,
  npmExecutable,
  toRepositoryPath,
} from "./platform-portability.mjs";

test("repository paths use one separator on every host", () => {
  assert.equal(
    toRepositoryPath("src\\views/chatview\\AgentChatView.ts"),
    "src/views/chatview/AgentChatView.ts",
  );
  assert.equal(
    toRepositoryPath("src/css\\foundation/tokens.css"),
    "src/css/foundation/tokens.css",
  );
});

test("policy text normalizes Windows and legacy Mac line endings", () => {
  assert.equal(normalizeLineEndings("permissions:\r\n  contents: read\r"), "permissions:\n  contents: read\n");
});

test("npm uses the executable form required by the host", () => {
  assert.equal(npmExecutable("win32"), "npm.cmd");
  assert.equal(npmExecutable("darwin"), "npm");
  assert.equal(npmExecutable("linux"), "npm");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  nodeRequireInvocation,
  normalizeLineEndings,
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

test("Node preload paths remain one argv value when repository paths contain spaces", () => {
  assert.deepEqual(
    nodeRequireInvocation(
      "C:\\Users\\QA Engineer\\System Sculpt\\scripts\\jest-preload.cjs",
      ["C:\\Users\\QA Engineer\\System Sculpt\\node_modules\\jest\\bin\\jest.js", "--runInBand"],
    ),
    [
      "--require",
      "C:\\Users\\QA Engineer\\System Sculpt\\scripts\\jest-preload.cjs",
      "C:\\Users\\QA Engineer\\System Sculpt\\node_modules\\jest\\bin\\jest.js",
      "--runInBand",
    ],
  );
});

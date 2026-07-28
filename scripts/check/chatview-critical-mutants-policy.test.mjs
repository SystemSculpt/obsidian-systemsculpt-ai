import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  assertMutationParses,
  locateMutationSpan,
} from "../chatview-critical-mutants.mjs";
import { CHATVIEW_CRITICAL_MUTANTS } from "./chatview-critical-mutants.manifest.mjs";

const root = process.cwd();
const expectedIds = [
  "reader_flat_shape_fallback_removed",
  "reader_object_arguments_forced_empty",
  "reader_server_name_fallback_removed",
  "projector_empty_server_checkpoint_kept",
  "projector_malformed_legacy_call_fails_open",
  "projector_duplicate_client_ids_allowed",
  "serializer_reconstructed_tool_calls_dropped",
  "runtime_resume_uses_full_continuation",
  "runtime_session_checkpoint_exposed_before_done",
  "controller_server_tools_reenter_local_continuation",
  "replay_unknowable_tool_fails_open",
  "renderer_historical_name_fallback_lost",
  "renderer_server_location_forced_vault",
];
const allowedSourceFiles = new Set([
  "src/services/chat/AcceptedChatRequestSnapshot.ts",
  "src/services/chat/ManagedToolExecution.ts",
  "src/views/chatview/AgentChatView.ts",
  "src/views/chatview/AgentConversationRenderer.ts",
  "src/views/chatview/ManagedAgentController.ts",
  "src/views/chatview/storage/ChatMarkdownSerializer.ts",
  "src/views/chatview/turn/ManagedChatRuntimeAdapter.ts",
]);
const allowedTestPaths = new Set([
  "src/services/chat/__tests__/accepted-chat-request-snapshot.test.ts",
  "src/services/chat/__tests__/managed-chat-projector-generative.test.ts",
  "src/services/chat/__tests__/managed-chat-replay-contract.test.ts",
  "src/services/chat/__tests__/managed-tool-execution.test.ts",
  "src/views/chatview/storage/__tests__/ChatMarkdownSerializer.test.ts",
  "src/views/chatview/__tests__/agent-chat-view-coordinator.test.ts",
  "src/views/chatview/__tests__/agent-workspace-ui.test.ts",
  "src/views/chatview/__tests__/managed-agent-controller-runtime-seam.test.ts",
  "src/views/chatview/__tests__/managed-chat-runtime-adapter.test.ts",
]);

test("the curated ChatView mutation manifest cannot silently shrink or widen", () => {
  assert.deepEqual(CHATVIEW_CRITICAL_MUTANTS.map((mutant) => mutant.id), expectedIds);
  assert.equal(new Set(expectedIds).size, expectedIds.length);
  for (const mutant of CHATVIEW_CRITICAL_MUTANTS) {
    assert.ok(allowedSourceFiles.has(mutant.file), mutant.file);
    assert.ok(typeof mutant.category === "string" && mutant.category.length > 0);
    assert.ok(mutant.testPaths.length >= 1 && mutant.testPaths.length <= 4);
    for (const testPath of mutant.testPaths) {
      assert.ok(allowedTestPaths.has(testPath), testPath);
      assert.ok(fs.existsSync(path.join(root, testPath)), testPath);
    }
  }
});

test("every curated mutant has one nearby AST anchor in current source", () => {
  for (const mutant of CHATVIEW_CRITICAL_MUTANTS) {
    const source = fs.readFileSync(path.join(root, mutant.file), "utf8");
    const span = locateMutationSpan(source, mutant.file, mutant);
    assert.ok(
      Math.abs(span.line - mutant.anchorLine) <= 8,
      `${mutant.id} moved from ${mutant.anchorLine} to ${span.line}`,
    );
  }
});

test("multiline AST anchors survive CRLF checkouts", () => {
  for (const mutant of CHATVIEW_CRITICAL_MUTANTS.filter((candidate) =>
    candidate.anchorText.includes("\n"))) {
    const source = fs.readFileSync(path.join(root, mutant.file), "utf8")
      .replace(/\r?\n/g, "\r\n");
    assert.equal(locateMutationSpan(source, mutant.file, mutant).line > 0, true);
  }
});

test("the mutation runner rejects syntactically invalid replacements as infrastructure failures", () => {
  assert.throws(
    () => assertMutationParses("const value = ;", "invalid.ts", "invalid-mutant"),
    /produced invalid TypeScript/,
  );
});

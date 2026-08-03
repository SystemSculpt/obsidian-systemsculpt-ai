import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  assertCuratedMutationTarget,
  assertMutationParses,
  locateMutationSpan,
} from "../chatview-critical-mutants.mjs";
import { CHATVIEW_CRITICAL_MUTANTS } from "./chatview-critical-mutants.manifest.mjs";

const root = process.cwd();
const expectedIds = [
  "authoritative_user_collision_not_failed_closed",
  "run_state_conflict_not_failed_closed",
  "command_ack_callback_removed",
  "mutation_receipts_truncated",
  "conversation_scope_removed_from_receipts",
];
const allowedSourceFiles = new Set([
  "src/views/chatview/agent/AuthoritativeSession.ts",
  "src/views/chatview/agent/MutationJournal.ts",
]);
const allowedTestPaths = new Set([
  "src/views/chatview/agent/__tests__/authoritative-session.test.ts",
  "src/views/chatview/agent/__tests__/mutation-journal.test.ts",
]);

test("the curated ChatView mutation manifest targets the thin harness", () => {
  assert.deepEqual(CHATVIEW_CRITICAL_MUTANTS.map((mutant) => mutant.id), expectedIds);
  for (const mutant of CHATVIEW_CRITICAL_MUTANTS) {
    assert.ok(allowedSourceFiles.has(mutant.file), mutant.file);
    assert.ok(mutant.testPaths.length >= 1 && mutant.testPaths.length <= 2);
    assert.equal(
      assertCuratedMutationTarget(root, mutant.file, { label: mutant.file }).relativePath,
      mutant.file,
    );
    for (const testPath of mutant.testPaths) {
      assert.ok(allowedTestPaths.has(testPath), testPath);
      assert.ok(fs.existsSync(path.join(root, testPath)), testPath);
    }
  }
});

test("every thin-harness mutant has one nearby AST anchor", () => {
  for (const mutant of CHATVIEW_CRITICAL_MUTANTS) {
    const source = fs.readFileSync(path.join(root, mutant.file), "utf8");
    const span = locateMutationSpan(source, mutant.file, mutant);
    assert.ok(Math.abs(span.line - mutant.anchorLine) <= 120);
  }
});

test("the mutation runner rejects syntactically invalid replacements", () => {
  assert.throws(
    () => assertMutationParses("const value = ;", "invalid.ts", "invalid-mutant"),
    /produced invalid TypeScript/,
  );
});

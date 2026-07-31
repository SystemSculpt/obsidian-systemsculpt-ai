import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  checkTestIdCatalog,
  generateTestIdCatalog,
  TESTID_CATALOG_PATH,
  TESTID_GRAMMAR,
} from "./generate-testid-catalog.mjs";

test("the testid grammar accepts dot-namespaced lowercase ids and wildcards only", () => {
  for (const valid of [
    "chat.composer.send",
    "settings.tab.*",
    "studio.config.option.*",
    "bulk-transcribe.skip-all",
  ]) {
    assert.equal(TESTID_GRAMMAR.test(valid), true, valid);
  }
  for (const invalid of [
    "Chat.composer",
    "chat",
    "chat.Composer.send",
    "chat composer",
    ".chat.send",
    "chat..send",
  ]) {
    assert.equal(TESTID_GRAMMAR.test(invalid), false, invalid);
  }
});

test("the generated catalog contains the core product surfaces", () => {
  const catalog = generateTestIdCatalog();
  for (const id of [
    "chat.header.new",
    "chat.composer.send",
    "chat.composer.input",
    "chat.composer.file-picker",
    "chat.turn.edit-resubmit",
    "chat.approval.allow-once",
    "settings.tab.*",
    "settings.search",
    "studio.node.run",
    "modal.close",
  ]) {
    assert.ok(catalog.ids.includes(id), `catalog is missing ${id}`);
  }
  assert.deepEqual(catalog.ids, [...catalog.ids].sort(), "catalog ids must be sorted");
});

test("the committed catalog is fresh", () => {
  assert.equal(checkTestIdCatalog(), true);
  const committed = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), TESTID_CATALOG_PATH), "utf8"),
  );
  assert.equal(committed.version, 1);
  assert.ok(committed.ids.length > 100);
});

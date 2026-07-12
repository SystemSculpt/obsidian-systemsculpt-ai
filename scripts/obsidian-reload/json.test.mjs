import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonText, stripUtf8Bom } from "./json.mjs";

test("stripUtf8Bom removes a leading BOM and leaves normal text untouched", () => {
  assert.equal(stripUtf8Bom("\ufeff{\"ok\":true}"), "{\"ok\":true}");
  assert.equal(stripUtf8Bom("{\"ok\":true}"), "{\"ok\":true}");
});

test("parseJsonText accepts BOM-prefixed JSON payloads", () => {
  assert.deepEqual(parseJsonText("\ufeff{\"ok\":true,\"value\":1}"), {
    ok: true,
    value: 1,
  });
});

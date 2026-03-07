import assert from "node:assert/strict";
import test from "node:test";
import { resolveTextReveal, resolveTextRevealLines } from "../lib/textReveal";

test("type reveals progress across the configured duration", () => {
  const spec = {
    mode: "type" as const,
    durationInFrames: 60,
  };

  const start = resolveTextReveal("Hello world", 0, 60, spec);
  const midpoint = resolveTextReveal("Hello world", 30, 60, spec);
  const end = resolveTextReveal("Hello world", 60, 60, spec);

  assert.equal(start.text, "");
  assert.ok(midpoint.text.length > 0);
  assert.ok(midpoint.text.length < "Hello world".length);
  assert.equal(end.text, "Hello world");
  assert.equal(end.showCursor, false);
});

test("stream reveals honor line delays and cursor state", () => {
  const spec = {
    mode: "stream" as const,
    startFrame: 10,
    durationInFrames: 40,
    lineDelayInFrames: 18,
    showCursor: true,
  };

  const early = resolveTextRevealLines(["First sentence.", "Second sentence."], 16, 60, spec);
  const late = resolveTextRevealLines(["First sentence.", "Second sentence."], 80, 60, spec);

  assert.equal(early[0]?.showCursor, true);
  assert.equal(early[1]?.text, "");
  assert.equal(late[0]?.text, "First sentence.");
  assert.equal(late[1]?.text, "Second sentence.");
  assert.equal(late[1]?.showCursor, false);
});

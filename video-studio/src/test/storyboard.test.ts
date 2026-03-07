import test from "node:test";
import assert from "node:assert/strict";
import { pdfAiAssistantStoryboard } from "../data/pdfAiAssistantStoryboard";
import { getSceneOffsets } from "../lib/storyboard";

test("storyboard runs for exactly 1800 frames", () => {
  assert.equal(pdfAiAssistantStoryboard.durationInFrames, 1800);
  assert.equal(pdfAiAssistantStoryboard.fps, 60);
});

test("scene durations sum to the composition duration", () => {
  const total = pdfAiAssistantStoryboard.scenes.reduce(
    (sum, scene) => sum + scene.durationInFrames,
    0
  );
  assert.equal(total, pdfAiAssistantStoryboard.durationInFrames);
});

test("scene offsets are contiguous with no gaps", () => {
  const offsets = getSceneOffsets(pdfAiAssistantStoryboard.scenes);
  assert.equal(offsets[0]?.from, 0);
  assert.equal(
    offsets[offsets.length - 1]?.to,
    pdfAiAssistantStoryboard.durationInFrames
  );

  for (let index = 1; index < offsets.length; index += 1) {
    assert.equal(offsets[index - 1]?.to, offsets[index]?.from);
  }
});

test("every scene uses a supported live surface contract", () => {
  for (const scene of pdfAiAssistantStoryboard.scenes) {
    switch (scene.surface.kind) {
      case "context-modal":
        assert.ok(scene.surface.rows.length > 0, `${scene.id} should include context rows`);
        assert.ok(scene.surface.filters.length > 0, `${scene.id} should include filters`);
        break;
      case "chat-status":
        assert.ok(scene.surface.chips.length > 0, `${scene.id} should include status chips`);
        assert.ok(scene.surface.actions.length > 0, `${scene.id} should include actions`);
        break;
      case "chat-thread":
        assert.ok(
          scene.surface.messages.length > 0 || !!scene.surface.draft,
          `${scene.id} should include message or composer content`
        );
        break;
      default:
        assert.fail(`Unsupported surface kind on ${scene.id}`);
    }
  }
});

test("audio cue markers stay inside the composition bounds", () => {
  for (const cue of pdfAiAssistantStoryboard.audioCueMap) {
    assert.ok(cue.frame >= 0, `Cue ${cue.id} starts before frame 0`);
    assert.ok(
      cue.frame < pdfAiAssistantStoryboard.durationInFrames,
      `Cue ${cue.id} falls outside the composition`
    );
  }
});

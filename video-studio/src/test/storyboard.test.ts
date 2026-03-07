import test from "node:test";
import assert from "node:assert/strict";
import { systemSculptOverviewStoryboard } from "../data/systemSculptOverviewStoryboard";
import { getSceneOffsets } from "../lib/storyboard";

test("storyboard runs for exactly 1800 frames", () => {
  assert.equal(systemSculptOverviewStoryboard.durationInFrames, 1800);
  assert.equal(systemSculptOverviewStoryboard.fps, 60);
});

test("scene durations sum to the composition duration", () => {
  const total = systemSculptOverviewStoryboard.scenes.reduce(
    (sum, scene) => sum + scene.durationInFrames,
    0
  );
  assert.equal(total, systemSculptOverviewStoryboard.durationInFrames);
});

test("scene offsets are contiguous with no gaps", () => {
  const offsets = getSceneOffsets(systemSculptOverviewStoryboard.scenes);
  assert.equal(offsets[0]?.from, 0);
  assert.equal(
    offsets[offsets.length - 1]?.to,
    systemSculptOverviewStoryboard.durationInFrames
  );

  for (let index = 1; index < offsets.length; index += 1) {
    assert.equal(offsets[index - 1]?.to, offsets[index]?.from);
  }
});

test("every scene uses a supported live surface contract", () => {
  for (const scene of systemSculptOverviewStoryboard.scenes) {
    switch (scene.surface.kind) {
      case "search-modal":
        assert.ok(scene.surface.results.length > 0, `${scene.id} should include search results`);
        assert.ok(scene.surface.recents.length > 0, `${scene.id} should include recents`);
        break;
      case "context-modal":
        assert.ok(scene.surface.rows.length > 0, `${scene.id} should include context rows`);
        assert.ok(scene.surface.filters.length > 0, `${scene.id} should include filters`);
        break;
      case "history-modal":
        assert.ok(scene.surface.entries.length > 0, `${scene.id} should include history entries`);
        break;
      case "credits-modal":
        assert.ok(scene.surface.balance.totalRemaining >= 0, `${scene.id} should include balance data`);
        if (scene.surface.activeTab === "usage") {
          assert.ok(
            (scene.surface.usage?.items.length ?? 0) > 0,
            `${scene.id} should include usage rows when the usage tab is active`
          );
        }
        break;
      case "embeddings-status-modal":
        assert.ok(scene.surface.stats.total >= scene.surface.stats.processed, `${scene.id} should include valid embedding stats`);
        break;
      case "bench-results-view":
        assert.ok(
          scene.surface.status === "error" || scene.surface.entries.length > 0,
          `${scene.id} should include leaderboard entries or an explicit error state`
        );
        break;
      case "settings-panel":
        assert.ok(scene.surface.tabs.length > 0, `${scene.id} should include settings tabs`);
        assert.ok(
          scene.surface.sections.length > 0,
          `${scene.id} should include settings sections`
        );
        break;
      case "studio-graph-view":
        assert.ok(scene.surface.nodes.length > 0, `${scene.id} should include Studio nodes`);
        assert.ok(
          scene.surface.entryNodeIds.length > 0,
          `${scene.id} should include Studio entry nodes`
        );
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

test("breadth reel includes settings and Studio coverage", () => {
  const kinds = new Set(systemSculptOverviewStoryboard.scenes.map((scene) => scene.surface.kind));
  assert.ok(kinds.has("settings-panel"));
  assert.ok(kinds.has("studio-graph-view"));
});

test("audio cue markers stay inside the composition bounds", () => {
  for (const cue of systemSculptOverviewStoryboard.audioCueMap) {
    assert.ok(cue.frame >= 0, `Cue ${cue.id} starts before frame 0`);
    assert.ok(
      cue.frame < systemSculptOverviewStoryboard.durationInFrames,
      `Cue ${cue.id} falls outside the composition`
    );
  }
});

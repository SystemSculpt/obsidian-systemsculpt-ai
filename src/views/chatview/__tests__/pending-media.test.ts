/** @jest-environment jsdom */
import { TFile, type App } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { beginGeneration, generationKey, updateGeneration } from "../../../tools/systemsculpt/GenerationProgress";
import { encodeSystemSculptToolResult } from "../../../tools/systemsculpt/SystemSculptTools";
import { parseAspectRatio, pendingStatus, presentPendingMedia } from "../PendingMedia";
import { renderTurnMedia } from "../TurnMedia";

function tool(overrides: Partial<AgentToolPart> & Pick<AgentToolPart, "name" | "state">): AgentToolPart {
  return { id: "p", callId: "call-1", order: 0, kind: "tool", messageId: "m", location: "server", input: {}, ...overrides } as AgentToolPart;
}

function app(paths: string[]): App {
  return {
    vault: {
      getAbstractFileByPath: (path: string) => paths.includes(path) ? new TFile({ path }) : null,
      getResourcePath: (file: TFile) => `app://vault/${file.path}`,
    },
  } as unknown as App;
}

const actions = { openFile: jest.fn(), openLink: jest.fn() };
const PATH = "SystemSculpt/Images/2026-11-08 101500 A lighthouse at dusk.png";

describe("live generation placeholders", () => {
  it("reads the requested shape, defaulting to square images and wide videos", () => {
    expect(parseAspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseAspectRatio("1024x1536")).toBeCloseTo(2 / 3);
    expect(parseAspectRatio("portrait")).toBeCloseTo(2 / 3);
    expect(parseAspectRatio("wide")).toBeNull();
    const [video] = presentPendingMedia([tool({ name: "mcp__systemsculpt__generate_video", state: "running", input: { prompt: "Waves" } })], true);
    expect(video).toMatchObject({ kind: "video", label: "Generating video", caption: "Waves" });
    expect(video.ratio).toBeCloseTo(16 / 9);
  });

  it("draws one tile per requested image, only while the turn is live", () => {
    // Codex keeps a dynamic call's arguments inside the item.
    const part = tool({ name: "generate_image", state: "running", input: { type: "dynamicToolCall", arguments: { prompt: "Owls", count: 3, aspect_ratio: "4:3" } } });
    const tiles = presentPendingMedia([part], true);
    expect(tiles.map(tile => tile.label)).toEqual(["Image 1 of 3", "Image 2 of 3", "Image 3 of 3"]);
    expect(tiles[0].ratio).toBeCloseTo(4 / 3);
    // A restored chat whose call never finished shows no spinner.
    expect(presentPendingMedia([part], false)).toEqual([]);
  });

  it("holds a Codex image's place until Chat has saved it", () => {
    const codex = { native: { agent: "codex" as const, workingDirectory: "/vault" }, name: "imageGeneration", input: { type: "imageGeneration", id: "ig-1" } };
    expect(presentPendingMedia([tool({ ...codex, state: "running" })], true)[0]).toMatchObject({ state: "working", ratio: 1, caption: "Codex image" });
    expect(presentPendingMedia([tool({ ...codex, state: "succeeded" })], true)[0]).toMatchObject({ state: "saving", label: "Saving image" });
    expect(presentPendingMedia([tool({ ...codex, state: "succeeded" })], false)).toEqual([]);
    const limited = tool({ ...codex, state: "failed", output: { data: { type: "usageLimitExceeded", limitId: "x" } } });
    expect(presentPendingMedia([limited], false)[0]).toMatchObject({ state: "failed", error: "Codex image limit reached." });
  });

  it("keeps a failure in the card, but not a stop, a gate or one a later call made up for", () => {
    const failed = (message: string, extra: Record<string, unknown> = {}) => tool({ name: "generate_image", state: "failed", input: { prompt: "Owls" },
      output: { data: encodeSystemSculptToolResult({ ok: false, message, ...extra }) } });
    const [tile] = presentPendingMedia([failed("The image model is busy. The chat already shows generated files right after your reply.")], false);
    expect(tile).toMatchObject({ state: "failed", error: "The image model is busy." });
    expect(presentPendingMedia([failed("Stopped.")], false)).toEqual([]);
    expect(presentPendingMedia([failed("Not enough credits.", { link: { label: "Buy credits", url: "https://systemsculpt.com/credits" } })], false)).toEqual([]);
    const retried = tool({ name: "generate_image", callId: "call-2", state: "succeeded", input: { prompt: "Owls" }, output: { data: encodeSystemSculptToolResult({ ok: true, message: "Saved", media: [{ kind: "image", path: PATH }] }) } });
    expect(presentPendingMedia([failed("Busy."), retried], false)).toEqual([]);
  });

  it("estimates time left from the job's usual length and never claims done", () => {
    const args = { prompt: "Estimate me" };
    const key = generationKey("generate_image", args);
    const end = beginGeneration(key, 1_000);
    try {
      updateGeneration(key, { status: "queued" });
      const [tile] = presentPendingMedia([tool({ name: "generate_image", state: "running", input: args })], true);
      expect(pendingStatus(tile, 6_000)).toEqual({ meta: "Queued · 5s", fraction: null });
      updateGeneration(key, { status: "processing", typicalDurationMs: 60_000 });
      expect(pendingStatus(tile, 21_000)).toEqual({ meta: "20s · about 40s left", fraction: 0.3 });
      expect(pendingStatus(tile, 600_000).fraction).toBeLessThan(1);
    } finally { end(); }
  });

  it("swaps the placeholder for the image in the same frame", () => {
    const parent = document.createElement("div");
    const input = { prompt: "A lighthouse at dusk", aspect_ratio: "3:2" };
    const running = tool({ name: "generate_image", state: "running", input });
    const pending = renderTurnMedia(app([PATH]), parent, [running], actions, "", true)!;
    const placeholder = pending.querySelector<HTMLElement>("[data-testid='chat.turn.media.pending']")!;
    expect(placeholder.getAttribute("aria-busy")).toBe("true");
    expect(placeholder.style.getPropertyValue("--ss-media-ratio")).toBe(String(3 / 2));
    expect(placeholder.textContent).toContain("Generating image");

    const done = tool({ ...running, state: "succeeded", output: { data: encodeSystemSculptToolResult({ ok: true, message: "Saved", media: [{ kind: "image", path: PATH }] }) } });
    const block = renderTurnMedia(app([PATH]), parent, [done], actions, "", true)!;
    expect(block.querySelector("[data-testid='chat.turn.media.pending']")).toBeNull();
    const figure = block.querySelector<HTMLElement>("figure")!;
    expect(figure.classList.contains("has-ratio")).toBe(true);
    expect(figure.style.getPropertyValue("--ss-media-ratio")).toBe(String(3 / 2));
    block.querySelector<HTMLElement>("[data-testid='chat.turn.media.open']")!.click();
    expect(actions.openFile).toHaveBeenCalledWith(PATH);
  });

  it("shows a failed generation's reason with the retry hint", () => {
    const parent = document.createElement("div");
    const failed = tool({ name: "generate_video", state: "failed", input: { prompt: "Waves" }, output: { data: encodeSystemSculptToolResult({ ok: false, message: "The video model timed out." }) } });
    const block = renderTurnMedia(app([]), parent, [failed], actions, "", false)!;
    const tile = block.querySelector<HTMLElement>(".is-failed")!;
    expect(tile.textContent).toContain("The video model timed out.");
    expect(tile.textContent).toContain("Ask again to retry.");
    expect(tile.hasAttribute("aria-busy")).toBe(false);
  });
});

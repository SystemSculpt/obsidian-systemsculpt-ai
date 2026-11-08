/** @jest-environment jsdom */
import { TFile, type App } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { encodeSystemSculptToolResult } from "../../../tools/systemsculpt/SystemSculptTools";
import { renderHostedToolPreview } from "../HostedToolPreview";
import { renderNativeToolPreview } from "../NativeToolPresentation";
import { presentAgentTool, presentAgentToolFailure, agentToolNoticeTone } from "../AgentToolPresentation";
import { mediaDisplayName, renderMedia } from "../ToolCardBlocks";
import { renderTurnMedia } from "../TurnMedia";
import { presentTurnChanges } from "../TurnChangeSummary";

jest.mock("../../../platform/hostCapabilities", () => ({ hasHostCapability: jest.fn(() => true) }));
jest.mock("../../../platform/desktopOnly", () => ({ desktopHost: { fs: jest.fn(async () => ({ realpath: async (path: string) => path })) } }));
jest.mock("../../../utils/externalUrl", () => ({ openExternalUrl: jest.fn(async () => true) }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openExternalUrl } = require("../../../utils/externalUrl") as { openExternalUrl: jest.Mock };

const IMAGE = "SystemSculpt/Images/Lighthouse.png";
const VIDEO = "SystemSculpt/Videos/Waves.mp4";

function setup(paths: readonly string[] = [IMAGE, VIDEO, "Notes/Garden.md"]) {
  const files = new Map(paths.map(path => [path, new TFile({ path })]));
  const openLinkText = jest.fn(async () => undefined);
  const app = {
    vault: {
      adapter: { getBasePath: () => "/vault", getFullPath: (path: string) => `/vault/${path}` },
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getResourcePath: (file: TFile) => `app://local/vault/${file.path}`,
      read: jest.fn(async () => ""),
    },
    workspace: { openLinkText, getLeaf: () => ({ openFile: jest.fn() }) },
  } as unknown as App;
  return { app, openLinkText, host: document.createElement("div") };
}

function hosted(name: string, input: unknown, data?: unknown, overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return {
    id: name, order: 1, kind: "tool", messageId: "m", callId: name, name, input, location: "vault",
    state: "succeeded", ...(data !== undefined ? { output: { data } } : {}), ...overrides,
  } as AgentToolPart;
}
function claude(name: string, input: unknown, data?: unknown, overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return hosted(name, input, data, { location: "server", native: { agent: "claude", workingDirectory: "/vault" }, ...overrides });
}

describe("one card for every tool result", () => {
  it("shows generated media as thumbnails that open their vault files, and the prompt in words", () => {
    const { app, host, openLinkText } = setup();
    const data = encodeSystemSculptToolResult({ ok: true, message: "Generated 1 image and 1 video.", media: [
      { kind: "image", path: IMAGE }, { kind: "video", path: VIDEO },
    ] });
    expect(renderHostedToolPreview(app, host, hosted("generate_image", { prompt: "A lighthouse at dusk" }, data))).toBe(true);
    const tiles = host.querySelectorAll<HTMLButtonElement>('[data-testid="chat.tool.media.open"]');
    expect(tiles).toHaveLength(2);
    expect(tiles[0].querySelector("img")?.getAttribute("src")).toBe(`app://local/vault/${IMAGE}`);
    expect(tiles[1].querySelector("video")?.getAttribute("src")).toBe(`app://local/vault/${VIDEO}#t=0.1`);
    tiles[1].click();
    expect(openLinkText).toHaveBeenCalledWith(VIDEO, "", false);
    expect(host.querySelector(".ss-tool-fields:not(.ss-tool-media-files) dd")?.textContent).toBe("A lighthouse at dusk");
    expect(host.textContent).not.toContain("systemsculpt_tool");
  });

  it("says a subscription or credits gate in one calm line with its action, without the agent-only text", async () => {
    const { app, host } = setup();
    const link = { label: "Subscribe", url: "https://systemsculpt.com/pricing?utm_source=plugin" };
    const data = encodeSystemSculptToolResult({ ok: false, message: `Image generation comes with a SystemSculpt subscription. ${link.label}: ${link.url}`, link });
    const part = claude("mcp__systemsculpt__generate_image", { prompt: "A cat" }, data);
    await renderNativeToolPreview(app, host, part);
    const notice = host.querySelector(".ss-tool-notice.is-warning")!;
    expect(notice.textContent).toBe("Image generation comes with a SystemSculpt subscription. Subscribe");
    notice.querySelector<HTMLAnchorElement>("a")!.click();
    expect(openExternalUrl).toHaveBeenCalledWith(link.url, expect.anything());
    expect(presentAgentTool(part).icon).toBe("lock");
  });

  it("lists Claude Code web search sources as links and keeps the rest as text", async () => {
    const { app, host } = setup();
    const output = 'Web search results for query: "canvas"\n\nLinks: [{"title":"Canvas - Obsidian Help","url":"https://help.obsidian.md/canvas"}]\n\nCanvas is a plugin.';
    await renderNativeToolPreview(app, host, claude("WebSearch", { query: "canvas" }, output));
    const link = host.querySelector<HTMLAnchorElement>(".ss-tool-links a.external-link")!;
    expect(link.textContent).toBe("Canvas - Obsidian Help");
    expect(link.getAttribute("href")).toBe("https://help.obsidian.md/canvas");
    expect(host.querySelector(".ss-tool-link-host")?.textContent).toBe("help.obsidian.md");
    expect(host.querySelector(".ss-tool-text")?.textContent).toBe("Canvas is a plugin.");
    expect(host.textContent).not.toContain("Links: [");
  });

  it("shows a command with the tail of its output", async () => {
    const { app, host } = setup();
    await renderNativeToolPreview(app, host, claude("Bash", { command: "ls" }, "a\nb"));
    expect(host.querySelector(".ss-tool-terminal-command")?.textContent).toBe("$ ls");
    expect(host.querySelector(".ss-tool-terminal-output")?.textContent).toBe("a\nb");
  });

  it("links paths a search found inside the vault", async () => {
    const { app, host, openLinkText } = setup();
    await renderNativeToolPreview(app, host, claude("Glob", { pattern: "**/*.md" }, "/vault/Notes/Garden.md\n/elsewhere/x.md"));
    const rows = host.querySelectorAll(".ss-tool-paths > li");
    expect(rows).toHaveLength(2);
    rows[0].querySelector<HTMLAnchorElement>("a.internal-link")!.click();
    expect(openLinkText).toHaveBeenCalledWith("Notes/Garden.md", "", false);
    expect(rows[1].querySelector("a")).toBeNull();
  });

  it.each([
    ["an MCP tool", claude("mcp__weather__forecast", { city: "Portland", days: 3 }, [{ type: "text", text: "Rain Monday." }])],
    ["AskUserQuestion", claude("AskUserQuestion", { questions: [{ question: "Which bed?", options: [{ label: "South" }] }] })],
    ["ExitPlanMode", claude("ExitPlanMode", { plan: "1. Plant basil" })],
    ["an unknown native tool", claude("FutureTool", { target: "Notes" })],
  ])("reads %s as words, never an apology line", async (_label, part) => {
    const { app, host } = setup();
    expect(await renderNativeToolPreview(app, host, part)).toBe(true);
    expect(host.textContent).not.toMatch(/No preview/u);
    expect(host.textContent?.trim()).not.toBe("");
  });

  it("titles an MCP tool by its tool name with its server as meta", () => {
    const presentation = presentAgentTool(claude("mcp__weather__forecast", { city: "Portland" }));
    expect(presentation.label).toBe("Used forecast");
  });

  it("calls a declined or stopped action calmly", () => {
    const denied = hosted("write", { path: "A.md" }, undefined, { state: "denied", error: { code: "DENIED", message: "x" } });
    expect(presentAgentToolFailure(denied)).toBe("Declined, so it didn't run.");
    expect(agentToolNoticeTone(denied, "denied")).toBe("info");
    const failed = hosted("write", { path: "A.md" }, undefined, { state: "failed", error: { code: "X", message: "x" } });
    expect(agentToolNoticeTone(failed, "failed")).toBe("danger");
  });

  it("pins and opens files with each path a vault link", () => {
    const { app, host } = setup();
    renderHostedToolPreview(app, host, hosted("context", { action: "add", paths: ["Notes/Garden.md"] }, {
      results: [{ path: "Notes/Garden.md", success: true }], summary: "Pinned 1 file.",
    }));
    expect(host.querySelector(".ss-tool-paths li")?.textContent).toBe("Notes/Garden.md ·\u00a0Pinned");
    const opened = setup();
    renderHostedToolPreview(opened.app, opened.host, hosted("open", { files: [{ path: "Notes/Garden.md" }] }, { opened: ["Notes/Garden.md"], errors: ["Failed to open file: Missing.md"] }));
    expect(opened.host.querySelector("a.internal-link")?.textContent).toBe("Notes/Garden.md");
    expect(opened.host.querySelector(".ss-tool-notice")?.textContent).toBe("Failed to open file: Missing.md");
  });
});

describe("media shown once per turn", () => {
  it("names generated files without their time stamp or extension", () => {
    expect(mediaDisplayName("SystemSculpt/Images/2026-11-08 093755 Use case style-transfer.png")).toBe("Use case style-transfer");
    expect(mediaDisplayName("Photos/old.png")).toBe("old");
    expect(mediaDisplayName("SystemSculpt/Images/2026-11-08 093755.png")).toBe("2026-11-08 093755");
    expect(mediaDisplayName(IMAGE, "Poster art")).toBe("Poster art");
  });

  it("keeps only the file link in a card when the reply shows the same image", () => {
    const { app } = setup();
    const body = document.createElement("div");
    body.className = "systemsculpt-agent-turn-body";
    const card = body.appendChild(document.createElement("div"));
    renderMedia(app, card, [{ kind: "image", path: IMAGE }]);
    const media = card.querySelector(".ss-tool-media")!;
    expect(media.classList.contains("is-shown-in-reply")).toBe(false);
    const generated = hosted("generate_image", { prompt: "Lighthouse" }, encodeSystemSculptToolResult({ ok: true, message: "Saved.", media: [{ kind: "image", path: IMAGE }] }));
    renderTurnMedia(app, body, [generated], { openFile: jest.fn(), openLink: jest.fn() });
    expect(media.classList.contains("is-shown-in-reply")).toBe(true);
    expect(card.querySelector(".ss-tool-media-files dd a")?.textContent).toBe("Lighthouse");
    expect(body.querySelector("[data-testid='chat.turn.media.path']")?.textContent).toBe("Lighthouse");
  });

  it("does not repeat an image the answer itself embeds", () => {
    const { app } = setup();
    const body = document.createElement("div");
    body.className = "systemsculpt-agent-turn-body";
    const card = body.appendChild(document.createElement("div"));
    renderMedia(app, card, [{ kind: "image", path: IMAGE }]);
    const generated = hosted("generate_image", { prompt: "Lighthouse" }, encodeSystemSculptToolResult({ ok: true, message: "Saved.", media: [{ kind: "image", path: IMAGE }] }));
    renderTurnMedia(app, body, [generated], { openFile: jest.fn(), openLink: jest.fn() }, `View the edited image: ![[${IMAGE}]]`);
    expect(body.querySelector(".systemsculpt-agent-turn-media")).toBeNull();
    expect(card.querySelector(".ss-tool-media")?.classList.contains("is-shown-in-reply")).toBe(true);
  });
});

describe("turn change summary", () => {
  it("lists a note created and then moved once, where it ended up", () => {
    const changes = presentTurnChanges([
      hosted("write", { path: "Notes/Ideas.md", content: "x" }, { path: "Notes/Ideas.md", success: true, created: true }),
      hosted("move", { items: [{ source: "Notes/Ideas.md", destination: "Notes/Archive/Ideas.md" }] }, { results: [{ source: "Notes/Ideas.md", destination: "Notes/Archive/Ideas.md", success: true }] }),
    ]);
    expect(changes.map(change => change.path)).toEqual(["Notes/Archive/Ideas.md"]);
    expect(changes[0].meta).toBe("new");
  });
});

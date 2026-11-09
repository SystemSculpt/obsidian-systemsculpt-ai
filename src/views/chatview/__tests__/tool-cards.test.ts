/** @jest-environment jsdom */
import { TFile, type App } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { encodeSystemSculptToolResult, SYSTEMSCULPT_TOOL_SERVER } from "../../../tools/systemsculpt/SystemSculptTools";
import { renderHostedToolPreview } from "../HostedToolPreview";
import { renderNativeToolPreview } from "../NativeToolPresentation";
import { presentAgentTool, presentAgentToolFailure, agentToolNoticeTone } from "../AgentToolPresentation";
import { detailsOutput, mediaDisplayName, renderFields, renderMedia, renderRawDetails } from "../ToolCardBlocks";
import { renderTurnMedia } from "../TurnMedia";
import { presentTurnChanges } from "../TurnChangeSummary";
import { setActivityLabelText, summarizeAgentActivity } from "../AgentActivityPresentation";

jest.mock("../../../platform/hostCapabilities", () => ({ hasHostCapability: jest.fn(() => true) }));
jest.mock("../../../platform/desktopOnly", () => ({ desktopHost: { fs: jest.fn(async () => ({ realpath: async (path: string) => path })) } }));
jest.mock("../../../utils/externalUrl", () => ({ openExternalUrl: jest.fn(async () => true) }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openExternalUrl } = require("../../../utils/externalUrl") as { openExternalUrl: jest.Mock };

const IMAGE = "SystemSculpt/Images/Lighthouse.png";
// Claude Code's name for a tool on another server (built, so the retired-prefix gate stays exact).
const BRIDGED_FORECAST = ["mcp", "weather", "forecast"].join("__");
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
  it("shows a generation's prompt in words and leaves its files to the turn, which shows and names them", () => {
    const { app, host } = setup();
    const data = encodeSystemSculptToolResult({ ok: true, message: "Generated 1 image and 1 video.", media: [
      { kind: "image", path: IMAGE }, { kind: "video", path: VIDEO },
    ] });
    expect(renderHostedToolPreview(app, host, hosted("generate_image", { prompt: "A lighthouse at dusk" }, data))).toBe(true);
    // No thumbnail and no "Saved" row: the open card keeps its height when the files land below it.
    expect(host.querySelector('[data-testid="chat.tool.media"]')).toBeNull();
    expect(Array.from(host.querySelectorAll(".ss-tool-field dt"), label => label.textContent)).toEqual(["Prompt"]);
    expect(host.querySelector(".ss-tool-field dd")?.textContent).toBe("A lighthouse at dusk");
    expect(host.textContent).not.toContain("systemsculpt_tool");
  });

  it("lists a workflow's outputs bare at the text edge, as it lists workflows", () => {
    const { app, host } = setup();
    const poster = "SystemSculpt/Studio/Poster.systemsculpt";
    const data = encodeSystemSculptToolResult({ ok: true, message: "1 node has saved outputs.", data: { path: poster, nodes: [{ nodeId: "img", files: [{ path: IMAGE }] }] } });
    expect(renderHostedToolPreview(app, host, hosted("studio_list_outputs", { path: poster }, data))).toBe(true);
    expect(host.querySelector(".ss-tool-fields")).toBeNull();
    expect(Array.from(host.querySelectorAll(".ss-tool-paths > li"), item => item.textContent)).toEqual(["Lighthouse"]);
  });

  it("leaves the plugin's own result marker out of Details, live or saved", () => {
    expect(detailsOutput({ systemsculpt_tool: 1, ok: true, media: [{ kind: "image", path: IMAGE }] })).toEqual({ ok: true, media: [{ kind: "image", path: IMAGE }] });
    expect(detailsOutput({ data: { systemsculpt_tool: 1, ok: true }, status: "completed" })).toEqual({ data: { ok: true }, status: "completed" });
    const plain = { ok: true };
    expect(detailsOutput(plain)).toBe(plain);
    expect(detailsOutput("Saved.")).toBe("Saved.");
  });

  it("draws a card's thumbnails so each opens its vault file", () => {
    const { app, openLinkText } = setup();
    const card = document.createElement("div");
    renderMedia(app, card, [{ kind: "image", path: IMAGE }, { kind: "video", path: VIDEO }]);
    const tiles = card.querySelectorAll<HTMLButtonElement>('[data-testid="chat.tool.media.open"]');
    expect(tiles).toHaveLength(2);
    expect(tiles[0].querySelector("img")?.getAttribute("src")).toBe(`app://local/vault/${IMAGE}`);
    expect(tiles[1].querySelector("video")?.getAttribute("src")).toBe(`app://local/vault/${VIDEO}#t=0.1`);
    tiles[1].click();
    expect(openLinkText).toHaveBeenCalledWith(VIDEO, "", false);
  });

  it.each(["See plans", "Subscribe"])("says a plan gate (%s) in one calm line with its action, without the agent-only text", async (label) => {
    const { app, host } = setup();
    const link = { label, url: "https://systemsculpt.com/pricing?utm_source=plugin" };
    const data = encodeSystemSculptToolResult({ ok: false, message: `Image generation comes with a SystemSculpt subscription. ${link.label}: ${link.url}`, link });
    const part = claude(["mcp", SYSTEMSCULPT_TOOL_SERVER, "generate_image"].join("__"), { prompt: "A cat" }, data);
    await renderNativeToolPreview(app, host, part);
    // The calm lock of the turn's own gate, never the warning box a partial failure uses.
    const notice = host.querySelector(".ss-tool-notice.is-gate")!;
    expect(host.querySelector(".ss-tool-notice.is-warning")).toBeNull();
    expect(agentToolNoticeTone(part, "succeeded")).toBe("gate");
    expect(notice.textContent).toBe(`Image generation comes with a SystemSculpt subscription. ${label}`);
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
    ["an MCP tool", claude(BRIDGED_FORECAST, { city: "Portland", days: 3 }, [{ type: "text", text: "Rain Monday." }])],
    ["AskUserQuestion", claude("AskUserQuestion", { questions: [{ question: "Which bed?", options: [{ label: "South" }] }] })],
    ["ExitPlanMode", claude("ExitPlanMode", { plan: "1. Plant basil" })],
    ["an unknown native tool", claude("FutureTool", { target: "Notes" })],
  ])("reads %s as words, never an apology line", async (_label, part) => {
    const { app, host } = setup();
    expect(await renderNativeToolPreview(app, host, part)).toBe(true);
    expect(host.textContent).not.toMatch(/No preview/u);
    expect(host.textContent?.trim()).not.toBe("");
  });

  it("names an MCP tool with its server, so two servers' tools never read alike", () => {
    const presentation = presentAgentTool(claude(BRIDGED_FORECAST, { city: "Portland" }));
    expect(presentation.label).toBe("Used weather forecast");
    expect(presentation.target).toEqual({ text: "weather forecast" });
  });

  it("calls a declined or stopped action calmly", () => {
    const denied = hosted("write", { path: "A.md" }, undefined, { state: "denied", error: { code: "DENIED", message: "x" } });
    expect(presentAgentToolFailure(denied)).toBe("Denied, so it didn't run.");
    expect(agentToolNoticeTone(denied, "denied")).toBe("info");
    const failed = hosted("write", { path: "A.md" }, undefined, { state: "failed", error: { code: "X", message: "x" } });
    expect(agentToolNoticeTone(failed, "failed")).toBe("danger");
  });

  it("pins and opens files with each path a vault link", () => {
    const { app, host } = setup();
    renderHostedToolPreview(app, host, hosted("context", { action: "add", paths: ["Notes/Garden.md"] }, {
      results: [{ path: "Notes/Garden.md", success: true }], summary: "Pinned 1 file.",
    }));
    // Notes go by their name, as Obsidian shows them; the link keeps the file's path.
    expect(host.querySelector(".ss-tool-paths li")?.textContent).toBe("Notes/Garden ·\u00a0Pinned");
    const opened = setup();
    renderHostedToolPreview(opened.app, opened.host, hosted("open", { files: [{ path: "Notes/Garden.md" }] }, { opened: ["Notes/Garden.md"], errors: ["Failed to open file: Missing.md"] }));
    expect(opened.host.querySelector("a.internal-link")?.textContent).toBe("Notes/Garden");
    expect(opened.host.querySelector("a.internal-link")?.getAttribute("data-href")).toBe("Notes/Garden.md");
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

  it("hides a card's thumbnail when the reply shows the same image, which names it once", () => {
    const { app } = setup();
    const body = document.createElement("div");
    body.className = "systemsculpt-agent-turn-body";
    const card = body.appendChild(document.createElement("div"));
    renderMedia(app, card, [{ kind: "image", path: IMAGE }]);
    renderFields(app, card, [{ label: "Prompt", value: "Lighthouse" }]);
    const media = card.querySelector(".ss-tool-media")!;
    expect(media.classList.contains("is-shown-in-reply")).toBe(false);
    const generated = hosted("generate_image", { prompt: "Lighthouse" }, encodeSystemSculptToolResult({ ok: true, message: "Saved.", media: [{ kind: "image", path: IMAGE }] }));
    renderTurnMedia(app, body, [generated], { openFile: jest.fn(), openLink: jest.fn() });
    expect(media.classList.contains("is-shown-in-reply")).toBe(true);
    expect(card.textContent).not.toContain("Saved");
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

describe("generation titles", () => {
  it("counts a batch of saved images", () => {
    const part = hosted("generate_image", { prompt: "Lighthouse", count: 2 }, encodeSystemSculptToolResult({
      ok: true, message: "Saved.", media: [{ kind: "image", path: IMAGE }, { kind: "image", path: "SystemSculpt/Images/Two.png" }],
    }));
    expect(presentAgentTool(part).label).toBe("Generated 2 images");
    expect(presentAgentTool(hosted("generate_image", { prompt: "One" }, encodeSystemSculptToolResult({ ok: true, message: "Saved.", media: [{ kind: "image", path: IMAGE }] }))).label).toBe("Generated image");
  });
});

describe("empty results", () => {
  it("says a search found nothing and a folder is empty, in words", () => {
    const { app } = setup();
    const search = document.createElement("div");
    renderHostedToolPreview(app, search, hosted("search", { patterns: ["zucchini"] }, { results: [], snippets: [], totalFound: 0 }));
    expect(search.textContent).toContain("No matches.");
    const list = document.createElement("div");
    renderHostedToolPreview(app, list, hosted("list_items", { path: "Notes/Archive" }, { results: [{ path: "Notes/Archive", directories: [], files: [], totalItems: 0, offset: 0, nextOffset: null }] }));
    expect(list.textContent).toContain("This folder is empty.");
    expect(list.textContent).not.toContain("0 returned");
  });
});

describe("studio and gated summaries", () => {
  it("lists each Studio edit with its requested value", () => {
    const { app } = setup();
    const host = document.createElement("div");
    renderHostedToolPreview(app, host, hosted("studio_edit_workflow", {
      path: "SystemSculpt/Studio/Poster.systemsculpt", revision: "abc",
      edits: [{ kind: "set", entityId: "node:prompt", path: ["config", "value"], value: "A lighthouse" }, { kind: "create", entityId: "node:img", value: { kind: "image_generation", title: "Poster image" } }],
    }, encodeSystemSculptToolResult({ ok: true, message: "Applied 2 edits." })));
    // Results in words, one per line: no field paths, node ids or node kinds.
    const field = Array.from(host.querySelectorAll(".ss-tool-field")).find(row => row.querySelector("dt")?.textContent === "Changes")!;
    expect(Array.from(field.querySelectorAll("dd li"), item => item.textContent)).toEqual(["Prompt set to “A lighthouse”", "Added Poster image"]);
    // Its row names and links the workflow ("Edited Poster workflow"), so the card starts at what changed.
    expect(Array.from(host.querySelectorAll(".ss-tool-fields dt"), label => label.textContent)).toEqual(["Changes"]);
    expect(host.textContent).not.toMatch(/config\.value|node:|image_generation/u);
  });

  it("leaves a failed generation's reason to its tile in the reply instead of saying it twice", () => {
    const { app } = setup();
    const body = document.createElement("div");
    body.className = "systemsculpt-agent-turn-body";
    const card = body.appendChild(document.createElement("div"));
    const failed = { ...hosted("generate_video", { prompt: "Waves" }, encodeSystemSculptToolResult({ ok: false, message: "The video service is busy right now." })), callId: "video-1", id: "video-1" } as AgentToolPart;
    renderHostedToolPreview(app, card, failed);
    const notice = card.querySelector<HTMLElement>(".ss-tool-notice[data-media-failure='video-1']")!;
    expect(notice.textContent).toBe("The video service is busy right now.");
    expect(notice.classList.contains("is-shown-in-reply")).toBe(false);
    renderTurnMedia(app, body, [failed], { openFile: jest.fn(), openLink: jest.fn() });
    expect(body.querySelector("[data-pending-id='video-1:failed']")).not.toBeNull();
    expect(notice.classList.contains("is-shown-in-reply")).toBe(true);
  });

  it("marks a gate line's action as a link that leaves Obsidian", () => {
    const { app } = setup();
    const body = document.createElement("div");
    const gated = { ...hosted("generate_image", { prompt: "Cat astronaut" }, encodeSystemSculptToolResult({
      ok: false, message: "Image generation comes with a SystemSculpt plan.", link: { label: "See plans", url: "https://systemsculpt.com/pricing" },
    })), callId: "image-1", id: "image-1" } as AgentToolPart;
    const openLink = jest.fn();
    renderTurnMedia(app, body, [gated], { openFile: jest.fn(), openLink });
    const action = body.querySelector<HTMLAnchorElement>("[data-testid='chat.turn.media.subscribe']")!;
    expect(action.textContent).toBe("See plans");
    expect(action.classList.contains("external-link")).toBe(true);
    action.click();
    expect(openLink).toHaveBeenCalledWith("https://systemsculpt.com/pricing");
  });

  it("keeps raw Details JSON copyable line by line, each line wrapping under its own indent", () => {
    const card = document.createElement("div");
    const payload = { input: { city: "Portland" } };
    renderRawDetails(card, () => payload);
    const raw = card.querySelector<HTMLDetailsElement>(".systemsculpt-agent-tool-raw")!;
    raw.open = true;
    raw.dispatchEvent(new Event("toggle"));
    const code = raw.querySelector<HTMLElement>("pre > code")!;
    expect(code.textContent).toBe(JSON.stringify(payload, null, 2));
    expect(Array.from(code.querySelectorAll<HTMLElement>(".ss-json-line"), line => line.style.getPropertyValue("--ss-json-indent"))).toEqual(["", "2", "4", "2", ""]);
  });

  it("keeps a credits gate and a refusal apart from a finished generation", () => {
    const done = hosted("generate_image", { prompt: "A" }, encodeSystemSculptToolResult({ ok: true, message: "Saved.", media: [{ kind: "image", path: IMAGE }] }));
    const gate = { ...hosted("generate_image", { prompt: "B" }, encodeSystemSculptToolResult({ ok: false, message: "Out of credits.", link: { label: "Buy credits", url: "https://systemsculpt.com/pricing" } })), callId: "gate", id: "gate" } as AgentToolPart;
    const refused = { ...hosted("generate_image", { prompt: "C" }, encodeSystemSculptToolResult({ ok: false, message: "Nope." })), callId: "refused", id: "refused" } as AgentToolPart;
    const summary = summarizeAgentActivity([done, gate, refused]);
    // The gate says what it stopped and what that needs.
    expect(summary.label).toBe("Generated image, image needs credits, couldn't generate image");
    expect(summary.failedCount).toBe(1);
    expect(summary.gated).toBe(true);
  });
});

describe("activity label wrapping", () => {
  it("keeps each count with its word without changing the text", () => {
    const label = document.createElement("strong");
    setActivityLabelText(label, "Couldn't complete 2 actions and 5 more steps · 1 blocked");
    expect(label.textContent).toBe("Couldn't complete 2 actions and 5 more steps · 1 blocked");
    expect(Array.from(label.querySelectorAll(".ss-activity-count"), span => span.textContent)).toEqual(["2 actions", "5 more steps", "1 blocked"]);
    // "1 of 2 notes" is one count.
    setActivityLabelText(label, "Moved 1 of 2 notes to trash");
    expect(Array.from(label.querySelectorAll(".ss-activity-count"), span => span.textContent)).toEqual(["1 of 2 notes"]);
  });
});

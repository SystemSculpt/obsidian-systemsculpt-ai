/**
 * @jest-environment jsdom
 */
import { TFile, TFolder } from "obsidian";
import { SystemSculptToolService, type SystemSculptToolHost } from "../SystemSculptToolService";
import { decodeSystemSculptToolOutput, encodeSystemSculptToolResult } from "../SystemSculptTools";
import { answerClaudeToolBridgeMessage } from "../../../services/claude/ClaudeToolBridge";
import { presentTurnMedia } from "../../../views/chatview/TurnMedia";
import type { AgentToolPart } from "../../../chat/ChatConversation";

const SUBSCRIBE = "https://systemsculpt.com/checkout?resourceId=monthly&cta=plugin_chat_tools_monthly";
const CREDITS = "https://systemsculpt.com/buy-credits";

function fakeVault(seed: Record<string, ArrayBuffer> = {}) {
  const files = new Map<string, ArrayBuffer>(Object.entries(seed));
  const folders = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.has(path) ? new TFile({ path }) : folders.has(path) ? new TFolder({ path }) : null,
      createFolder: async (path: string) => { folders.add(path); },
      createBinary: async (path: string, bytes: ArrayBuffer) => { files.set(path, bytes); return new TFile({ path }); },
      readBinary: async (file: TFile) => files.get(file.path)!,
      adapter: { exists: async (path: string) => files.has(path) || folders.has(path), stat: async () => null },
    },
  };
  return { app, files };
}

function host(overrides: Partial<SystemSculptToolHost> = {}, seed?: Record<string, ArrayBuffer>) {
  const { app, files } = fakeVault(seed);
  const images = {
    generate: jest.fn(async () => ({
      operationId: "op", jobId: "job", model: "openai/gpt-image", usage: { raw_usd: 0.04, cost_source: "provider", estimated: false },
      outputs: [{ metadata: { index: 0, mime_type: "image/png", size_bytes: 3, sha256: "a".repeat(64), width: 1, height: 1 }, bytes: new Uint8Array([1, 2, 3]).buffer, delivery: { download_started_at: "", download_completed_offset_ms: 1 } }],
    })),
    beginLocalCommit: jest.fn(async () => {}),
    completeLocalCommit: jest.fn(async () => {}),
  };
  const value: SystemSculptToolHost = {
    app: app as never,
    hasLicenseKey: () => true,
    checkLicense: async () => ({ outcome: "allowed" }),
    images: images as never,
    videos: {} as never,
    videoModels: async () => [],
    studio: () => ({}) as never,
    openFile: jest.fn(async () => {}),
    links: { subscribe: SUBSCRIBE, credits: CREDITS },
    now: () => new Date(2026, 10, 7, 9, 5, 3),
    randomId: () => "abc-123",
    ...overrides,
  };
  return { host: value, images, files };
}

const signal = () => new AbortController().signal;

describe("SystemSculpt chat tools", () => {
  it("saves a generated image to the vault and returns its path for inline display", async () => {
    const { host: fake, images, files } = host({}, { "Refs/cat.png": new Uint8Array([9, 9]).buffer });
    const result = await new SystemSculptToolService(fake).call("mcp__systemsculpt__generate_image", { prompt: "A red fox in snow", aspect_ratio: "16:9", reference_images: ["Refs/cat.png"] }, signal());

    expect(result.ok).toBe(true);
    expect(result.media).toEqual([{ kind: "image", path: "SystemSculpt/Images/2026-11-07 090503 A red fox in snow.png", mimeType: "image/png" }]);
    expect(files.has("SystemSculpt/Images/2026-11-07 090503 A red fox in snow.png")).toBe(true);
    const operation = (images.generate.mock.calls[0] as unknown as [{ operationId: string; buildPayload: () => Record<string, unknown> }])[0];
    expect(operation.operationId).toBe("chat-image-abc-123");
    const payload = operation.buildPayload();
    expect(payload).toMatchObject({ prompt: "A red fox in snow", aspectRatio: "16:9" });
    expect((payload.inputImages as Array<Record<string, unknown>>)[0]).toMatchObject({ mimeType: "image/png", sizeBytes: 2 });
    expect(images.completeLocalCommit).toHaveBeenCalledWith("chat-image-abc-123");
  });

  it("answers a person without a license with one Subscribe line and generates nothing", async () => {
    const { host: fake, images } = host({ hasLicenseKey: () => false });
    const result = await new SystemSculptToolService(fake).call("generate_image", { prompt: "x" }, signal());
    expect(result).toEqual({ ok: false, message: `Image generation comes with a SystemSculpt subscription. Subscribe: ${SUBSCRIBE}`, link: { label: "Subscribe", url: SUBSCRIBE } });
    expect(images.generate).not.toHaveBeenCalled();
  });

  it("answers a rejected license the same way", async () => {
    const { host: fake } = host({ checkLicense: async () => ({ outcome: "license_required" }) });
    const result = await new SystemSculptToolService(fake).call("generate_video", { prompt: "x" }, signal());
    expect(result.link).toEqual({ label: "Subscribe", url: SUBSCRIBE });
    expect(result.message).toBe(`Video generation comes with a SystemSculpt subscription. Subscribe: ${SUBSCRIBE}`);
  });

  it("turns a credits shortfall into a Buy credits line, not an error dump", async () => {
    const error = Object.assign(new Error("Not enough credits are available for this generation."), { code: "payment_required" });
    const { host: fake } = host();
    (fake.images.generate as jest.Mock).mockRejectedValueOnce(error);
    const result = await new SystemSculptToolService(fake).call("generate_image", { prompt: "x" }, signal());
    expect(result.link).toEqual({ label: "Buy credits", url: CREDITS });
  });

  it("rejects bad input with a readable message", async () => {
    const { host: fake } = host();
    const result = await new SystemSculptToolService(fake).call("generate_image", { prompt: "x", count: 9 }, signal());
    expect(result).toEqual({ ok: false, message: "count must be a whole number from 1 to 4." });
  });

  it("runs a Studio workflow and surfaces its generated images", async () => {
    const studio = {
      runProject: jest.fn(async () => ({ runId: "run_1", status: "success", startedAt: "", finishedAt: "", error: null, executedNodeIds: ["img"] })),
      getProjectNodeCache: jest.fn(async () => ({ schema: "studio.node-cache.v1", projectId: "p", updatedAt: "", entries: {
        img: { nodeId: "img", nodeKind: "studio.image_generation", nodeVersion: "1", inputFingerprint: "", outputs: { images: [] }, updatedAt: "", runId: "run_1",
          artifacts: [{ hash: "h", mimeType: "image/png", sizeBytes: 4, path: "SystemSculpt/Studio/Poster/assets/h.png" }] },
      } })),
    };
    const { host: fake } = host({ studio: () => studio as never });
    const result = await new SystemSculptToolService(fake).call("studio_run_workflow", { path: "SystemSculpt/Studio/Poster.systemsculpt" }, signal());
    expect(result.ok).toBe(true);
    expect(result.media).toEqual([{ kind: "image", path: "SystemSculpt/Studio/Poster/assets/h.png", mimeType: "image/png" }]);
  });
});

describe("tool results in chat", () => {
  const encoded = encodeSystemSculptToolResult({ ok: true, message: "Saved", media: [{ kind: "image", path: "SystemSculpt/Images/a.png" }] });
  it.each([
    ["Claude Code content blocks", [{ type: "text", text: encoded }]],
    ["Codex content items", [{ type: "inputText", text: encoded }]],
    ["plain text", encoded],
  ])("finds generated media in %s", (_label, output) => {
    expect(decodeSystemSculptToolOutput(output)?.media).toEqual([{ kind: "image", path: "SystemSculpt/Images/a.png" }]);
  });

  it("ignores lookalike output from other tools and off-site links", () => {
    expect(decodeSystemSculptToolOutput("{\"media\":[]}")).toBeNull();
    const spoof = encodeSystemSculptToolResult({ ok: false, message: "x", link: { label: "Subscribe", url: "https://evil.example/" } });
    expect(decodeSystemSculptToolOutput(spoof)?.link).toBeUndefined();
  });

  it("presents media and one Subscribe line per turn from finished SystemSculpt tool parts only", () => {
    const subscribe = encodeSystemSculptToolResult({ ok: false, message: `Image generation comes with a SystemSculpt subscription. Subscribe: ${SUBSCRIBE}`, link: { label: "Subscribe", url: SUBSCRIBE } });
    const part = (callId: string, name: string, data: unknown, state: AgentToolPart["state"] = "succeeded") =>
      ({ id: callId, order: 0, kind: "tool", messageId: "m", callId, name, state, input: {}, location: "server", output: { data } }) as unknown as AgentToolPart;
    const presented = presentTurnMedia([
      part("a", "mcp__systemsculpt__generate_image", [{ type: "text", text: encoded }]),
      part("b", "generate_image", [{ type: "inputText", text: subscribe }]),
      part("c", "Bash", encoded),
      part("d", "generate_image", encoded, "running"),
    ]);
    expect(presented.media).toEqual([{ kind: "image", path: "SystemSculpt/Images/a.png" }]);
    expect(presented.notices).toEqual([{ text: "Image generation comes with a SystemSculpt subscription.", label: "Subscribe", url: SUBSCRIBE }]);
  });
});

describe("Claude Code tool bridge", () => {
  const tools = { definitions: [{ name: "generate_image" as const, title: "Generate image", description: "d", inputSchema: { type: "object" }, readOnly: false }],
    call: jest.fn(async () => ({ ok: true, message: "Saved" })) };

  it("lists the catalog and answers notifications", async () => {
    const list = await answerClaudeToolBridgeMessage(tools, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "6.19.0", signal());
    expect((list.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toEqual(["generate_image"]);
    expect(await answerClaudeToolBridgeMessage(tools, { jsonrpc: "2.0", method: "notifications/initialized" }, "6.19.0", signal())).toEqual({ jsonrpc: "2.0", result: {}, id: 0 });
  });

  it("returns a call's result as text the chat can decode", async () => {
    const response = await answerClaudeToolBridgeMessage(tools, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "p" } } }, "6.19.0", signal());
    expect(tools.call).toHaveBeenCalledWith("generate_image", { prompt: "p" }, expect.anything());
    expect(decodeSystemSculptToolOutput((response.result as { content: unknown }).content)?.message).toBe("Saved");
  });
});

describe("hosted chat capability", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const contract = require("../../../services/managed/ThinAgentV1Contract") as typeof import("../../../services/managed/ThinAgentV1Contract");
  const request = (target: unknown, tool_name = "generate_image") => ({ type: "data-systemsculpt-client-tool-request", data: { version: 1, tool_call_id: "call_1", tool_name, target, input: { prompt: "p" } } });

  it("advertises SystemSculpt tools beside the vault", () => {
    expect(contract.THIN_AGENT_CAPABILITIES).toEqual([{ id: "obsidian.vault", version: 1 }, { id: "systemsculpt.tools", version: 1 }]);
  });

  it("accepts a tool request for either advertised capability and nothing else", () => {
    expect(contract.parseThinAgentDataPart(request({ id: "systemsculpt.tools", version: 1 }))).toMatchObject({ kind: "known", data: { target: { id: "systemsculpt.tools", version: 1 } } });
    expect(contract.parseThinAgentDataPart(request({ id: "obsidian.vault", version: 1 }, "read"))).toMatchObject({ kind: "known" });
    expect(contract.parseThinAgentDataPart(request({ id: "systemsculpt.other", version: 1 }))).toMatchObject({ kind: "invalid" });
  });
});

describe("saved chats", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { durableToolResult } = require("../../../chat/managed/DurableToolResult") as typeof import("../../../chat/managed/DurableToolResult");

  it("keep every generated file and the Subscribe link once a result is stored structured", () => {
    const media = Array.from({ length: 4 }, (_, index) => ({ kind: "image" as const, path: `SystemSculpt/Images/2026-11-07 090503 ${"A very long prompt ".repeat(4)}${index}.png` }));
    const saved = durableToolResult({ success: true, data: { systemsculpt_tool: 1, ok: true, message: "Saved", media } });
    expect(decodeSystemSculptToolOutput(saved.data)?.media).toEqual(media);
    const refused = durableToolResult({ success: true, data: { systemsculpt_tool: 1, ok: false, message: `Image generation comes with a SystemSculpt subscription. Subscribe: ${SUBSCRIBE}`, link: { label: "Subscribe", url: SUBSCRIBE } } });
    expect(presentTurnMedia([{ id: "a", order: 0, kind: "tool", messageId: "m", callId: "a", name: "generate_image", state: "succeeded", input: {}, location: "server", output: { data: refused.data } } as unknown as AgentToolPart]).notices).toHaveLength(1);
  });
});

describe("one copy of each image", () => {
  const part = { id: "a", order: 0, kind: "tool", messageId: "m", callId: "a", name: "generate_image", state: "succeeded", input: {}, location: "server",
    output: { data: { systemsculpt_tool: 1, ok: true, message: "Saved", media: [{ kind: "image", path: "SystemSculpt/Images/a b.png" }] } } } as unknown as AgentToolPart;
  it.each([
    "![Stone](<SystemSculpt/Images/a b.png>)",
    "![Stone](SystemSculpt/Images/a%20b.png)",
    "![[a b.png]]",
  ])("shows a file the reply embeds only in the reply: %s", answer => {
    expect(presentTurnMedia([part], `Here it is:\n\n${answer}`).media).toEqual([]);
  });
  it("still shows it when the reply only names or links it", () => {
    expect(presentTurnMedia([part], "Saved [a b.png](<SystemSculpt/Images/a b.png>).").media).toHaveLength(1);
  });
});

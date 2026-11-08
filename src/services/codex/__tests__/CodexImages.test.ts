/** @jest-environment jsdom */
import { TFile, TFolder, type App } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { desktopHost } from "../../../platform/desktopOnly";
import { presentTurnMedia } from "../../../views/chatview/TurnMedia";
import { nativeToolPresentation, renderNativeToolPreview } from "../../../views/chatview/NativeToolPresentation";
import { codexActivity, codexToolActivity } from "../CodexActivity";
import { CodexImageImporter, codexImageMedia, codexImageVaultPath } from "../CodexImages";
import type { LocalAgentToolUpdate } from "../LocalAgentChatSession";

jest.mock("../../../platform/desktopOnly", () => ({ desktopHost: { fs: jest.fn() } }));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SAVED = "/Users/me/.codex/generated_images/thread/exec-1.png";
const outside = new Map<string, Uint8Array>([[SAVED, PNG]]);

beforeEach(() => {
  (desktopHost.fs as jest.Mock).mockResolvedValue({
    stat: async (path: string) => {
      if (!outside.has(path)) throw new Error("ENOENT");
      return { isFile: () => true, size: outside.get(path)!.byteLength };
    },
    readFile: async (path: string) => Buffer.from(outside.get(path)!),
    realpath: async (path: string) => path.replace(/\/[^/]+\/\.\.\//gu, "/"),
  });
});

function vault() {
  const files = new Map<string, ArrayBuffer>([["Photos/old.png", PNG.buffer]]);
  const folders = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.has(path) ? new TFile({ path }) : folders.has(path) ? new TFolder({ path }) : null,
      createFolder: async (path: string) => { folders.add(path); },
      createBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => { files.set(path, bytes); return new TFile({ path }); }),
      getResourcePath: (file: TFile) => `app://vault/${file.path}`,
      adapter: { exists: async (path: string) => files.has(path) || folders.has(path), getBasePath: () => "/vault" },
    },
    workspace: { openLinkText: jest.fn() },
  };
  return { app: app as unknown as App, files, createBinary: app.vault.createBinary, openLinkText: app.workspace.openLinkText };
}

const generation = { type: "imageGeneration", id: "exec-1", status: "completed", revisedPrompt: "Make this photo look dated", savedPath: SAVED, result: "iVBORw0KGgo=" };

function update(item: Record<string, unknown>): LocalAgentToolUpdate {
  return codexToolActivity(codexActivity("item/completed", { item })!, item, "/vault")!;
}
function codexImageMediaPath(value: AgentToolPart): string { return codexImageMedia(value)!.media.path; }
function part(saved: LocalAgentToolUpdate): AgentToolPart {
  return { id: saved.callId, callId: saved.callId, order: 0, kind: "tool", messageId: "m", location: "server", name: saved.name ?? "tool", input: saved.input, state: saved.state, output: saved.output, native: { agent: "codex", workingDirectory: "/vault", vaultRoot: "/vault" } };
}

describe("Codex images in chat", () => {
  it("keeps the generated image's base64 out of the transcript", () => {
    const saved = update(generation);
    expect(saved.input).not.toHaveProperty("result");
    expect(saved.output).toBeUndefined();
  });

  it("saves a generated image into the vault, shows it under the reply and maps Codex's link to it", async () => {
    const { app, files } = vault();
    const importer = new CodexImageImporter(app, () => new Date(2026, 10, 8, 9, 30, 0));
    const saved = await importer.present(update(generation), generation, "/vault");
    const path = "SystemSculpt/Images/2026-11-08 093000 Codex image.png";
    expect(files.has(path)).toBe(true);
    expect(presentTurnMedia([part(saved)], "Added faded sepia tones.").media).toEqual([{ kind: "image", path, mimeType: "image/png", order: 0, ratio: 1 }]);
    expect(codexImageVaultPath(SAVED)).toBe(path);
    // A saved chat writes the home folder as ~.
    expect(codexImageVaultPath("~/.codex/generated_images/thread/exec-1.png")).toBe(path);
    expect(nativeToolPresentation(part(saved))?.completedTitle).toBe("Generated image");

    // Viewing the same file later reuses the vault copy and shows it when the reply links it.
    const view = { type: "imageView", id: "exec-2", path: `file://${SAVED}` };
    const viewed = await importer.present(update(view), view, "/vault");
    expect(files.size).toBe(2);
    expect(nativeToolPresentation(part(viewed))?.completedTitle).toBe("Viewed image");
    expect(presentTurnMedia([part(viewed)], "Done.").media).toEqual([]);
    expect(presentTurnMedia([part(viewed)], `Here's the [edited image](${SAVED}).`).media.map(item => item.path)).toEqual([path]);
    expect(presentTurnMedia([part(viewed)], "Here's the [edited image](~/.codex/generated_images/thread/exec-1.png).").media).toHaveLength(1);
  });

  it("shows a viewed vault image inline in its card without copying it", async () => {
    const { app, createBinary, openLinkText } = vault();
    const view = { type: "imageView", id: "exec-3", path: "/vault/Photos/old.png" };
    const viewed = part(await new CodexImageImporter(app).present(update(view), view, "/vault"));
    expect(createBinary).not.toHaveBeenCalled();
    expect(nativeToolPresentation(viewed)?.completedTitle).toBe("Viewed old.png");
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, viewed);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("app://vault/Photos/old.png");
    expect(host.textContent).not.toContain("No preview is available");
    (host.querySelector("[data-testid='chat.tool.image.path']") as HTMLElement).click();
    expect(openLinkText).toHaveBeenCalledWith("Photos/old.png", "");
  });

  it("finds the image in a saved chat, where the result is nested under data", async () => {
    const { app } = vault();
    const saved = await new CodexImageImporter(app).present(update(generation), generation, "/vault");
    const reloaded = { ...part(saved), output: { summary: saved.output!.summary, data: saved.output } };
    expect(presentTurnMedia([reloaded]).media).toHaveLength(1);
  });

  it("uses the inline image when Codex's saved file can't be read", async () => {
    const { app, files } = vault();
    const unreadable = { ...generation, savedPath: "/Users/me/.codex/generated_images/thread/gone.png", result: Buffer.from(PNG).toString("base64") };
    const saved = await new CodexImageImporter(app).present(update(unreadable), unreadable, "/vault");
    expect(presentTurnMedia([part(saved)]).media).toHaveLength(1);
    expect(files.size).toBe(2);
  });

  it("copies the image again after the person deletes the vault copy", async () => {
    const { app, files } = vault();
    const importer = new CodexImageImporter(app);
    const view = { type: "imageView", id: "exec-5", path: SAVED };
    const first = part(await importer.present(update(view), view, "/vault"));
    files.delete(codexImageMediaPath(first));
    const again = part(await importer.present(update(view), view, "/vault"));
    expect(files.has(codexImageMediaPath(again))).toBe(true);
  });

  it("does not copy a path that only climbs out through generated_images", async () => {
    const { app, createBinary } = vault();
    outside.set("/Users/me/secret.png", PNG);
    const view = { type: "imageView", id: "exec-6", path: "/Users/me/.codex/generated_images/../../secret.png" };
    const viewed = await new CodexImageImporter(app).present(update(view), view, "/vault");
    expect(createBinary).not.toHaveBeenCalled();
    expect(viewed.output).toBeUndefined();
  });

  it("does not copy other files from outside the vault", async () => {
    const { app, createBinary } = vault();
    const view = { type: "imageView", id: "exec-4", path: "/tmp/screenshot.png" };
    const viewed = await new CodexImageImporter(app).present(update(view), view, "/vault");
    expect(createBinary).not.toHaveBeenCalled();
    expect(viewed.output).toBeUndefined();
  });
});

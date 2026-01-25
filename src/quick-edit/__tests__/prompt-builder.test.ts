import { describe, expect, it, jest } from "@jest/globals";
import type { App, TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { buildQuickEditMessages } from "../prompt-builder";

const createApp = (frontmatter: Record<string, unknown> = {}): App => {
  return {
    metadataCache: {
      getFileCache: jest.fn().mockReturnValue({
        frontmatter,
      }),
    },
    workspace: {
      getLeavesOfType: jest.fn().mockReturnValue([]),
    },
    vault: {
      cachedRead: jest.fn(async () => "# Title\n\nSome body text."),
      getAbstractFileByPath: jest.fn(() => new (require("obsidian").TFile)({ path: "Docs/Example.md" })),
    },
  } as unknown as App;
};

const createPlugin = (): SystemSculptPlugin => {
  return {
    settings: {
      selectedModelId: "openrouter/gpt-4.1-mini",
    },
  } as unknown as SystemSculptPlugin;
};

const createFile = (path = "Docs/Example.md"): TFile => {
  return new (require("obsidian").TFile)({ path });
};

describe("buildQuickEditMessages", () => {
  it("includes metadata about the target file and selection details", async () => {
    const app = createApp({ tags: ["journal"], status: "draft" });
    const plugin = createPlugin();
    const file = createFile();

    const messages = await buildQuickEditMessages({
      app,
      plugin,
      file,
      prompt: "Update the intro paragraph.",
      selection: {
        text: "Original intro paragraph.",
        range: { start: 0, end: 28 },
      },
    });

    const userText = messages.user.content as string;
    expect(userText).toMatch(/Path: Docs\/Example\.md/);
    expect(userText).toMatch(/Frontmatter keys: (status, tags|tags, status)/);
    expect(userText).toMatch(/Selection preview:/);
    expect(userText).toMatch(/Original intro paragraph\./);
    expect(userText).toMatch(/Current file contents \(exact\):/);
    expect(userText).toMatch(/# Title/);
    expect(userText).toMatch(/Some body text\./);

    const systemText = messages.systemPrompt;
    expect(systemText).toMatch(/mcp-filesystem_write/);
    expect(systemText).not.toMatch(/mcp-filesystem_edit/);
    expect(systemText).not.toMatch(/mcp-filesystem_read/);
  });

  it("omits selection section when none provided", async () => {
    const app = createApp();
    const plugin = createPlugin();
    const file = createFile();

    const messages = await buildQuickEditMessages({
      app,
      plugin,
      file,
      prompt: "Tighten bullet list formatting.",
    });

    const text = messages.user.content as string;
    expect(text).not.toMatch(/Selection preview:/);
  });

  it("prefers the active editor content when available", async () => {
    const app = createApp();
    (app.workspace.getLeavesOfType as any).mockReturnValueOnce([
      {
        view: {
          file: { path: "Docs/Example.md" },
          editor: { getValue: jest.fn(() => "FROM_EDITOR") },
        },
      },
    ]);

    const plugin = createPlugin();
    const file = createFile();

    const messages = await buildQuickEditMessages({
      app,
      plugin,
      file,
      prompt: "Update the intro paragraph.",
    });

    const userText = messages.user.content as string;
    expect(userText).toMatch(/FROM_EDITOR/);
  });
});
